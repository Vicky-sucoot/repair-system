"""綜合評分：結合外資買賣超與新聞利多／利空，產生每日「建議買入」與「建議賣出／避開」觀察名單。

評分方式（分數 -100～+100）：
- 外資分數 F（-1～1）＝方向 ×（0.6 × 買賣超金額強度 + 0.4 × 連續買／賣超強度）
  - 金額強度＝√min(1, |買賣超金額| ÷ (4 × 大買門檻))，預設 20 億元為滿分、5 億元約 0.5；沒有收盤價時改用張數（÷ 20,000 張）。
  - 連續強度＝min(連續天數, 5) ÷ 5。
- 新聞分數 N（-1～1）＝近期提及該股新聞的加權平均情緒 × 可信度
  - 每則新聞對該股的影響：利多 +|分數|、利空 −|分數|（至少 0.3）、中性 0。
  - 時間權重：當天 1、前一天 0.6、前兩天 0.36…；可信度＝min(1, 權重總和 ÷ 1.5)，只有一則新聞時打折。
- 綜合分數＝100 ×（0.55 × F + 0.45 × N）。
- 建議買入：外資買超（F > 0）且新聞偏多（N > 0），依綜合分數由高到低。
- 建議賣出／避開：外資賣超（F < 0）且新聞偏空（N < 0），依綜合分數由低到高。

結果僅供研究參考，不構成投資建議。
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date, datetime

from pydantic import BaseModel, Field

from .config import BIG_TRADE_VALUE, LLM_MODEL
from .sentiment import llm_available

WEIGHT_FOREIGN = 0.55
WEIGHT_NEWS = 0.45
LOTS_SCALE = 20000
FLOW_FULL_MULTIPLE = 4  # 買賣超金額達大買門檻的 4 倍才算滿分，避免大型股全部同分
RECENCY_DECAY = 0.6
DISCLAIMER = "依外資籌碼與新聞情緒自動計算，僅供研究參考，不構成投資建議；投資前請自行判斷並注意風險。"


def foreign_score(flow: dict, big_value: float = BIG_TRADE_VALUE) -> float:
    net = flow.get("net_shares") or 0
    if net == 0:
        return 0.0
    sign = 1 if net > 0 else -1
    if flow.get("net_value") is not None and big_value > 0:
        strength = min(1.0, abs(flow["net_value"]) / (big_value * FLOW_FULL_MULTIPLE))
    else:
        strength = min(1.0, abs(flow.get("net_lots") or 0) / LOTS_SCALE)
    streak = flow.get("streak_days", 0) if sign > 0 else flow.get("sell_streak_days", 0)
    return round(sign * (0.6 * math.sqrt(strength) + 0.4 * min(streak, 5) / 5), 4)


def _day(value: str | None) -> date | None:
    try:
        return datetime.fromisoformat(value).date() if value else None
    except ValueError:
        return None


def news_signals(items: list[dict], today: date) -> dict[str, dict]:
    """依個股彙整新聞情緒：加權分數、利多／利空則數、關鍵字與標題。"""
    acc: dict[str, dict] = defaultdict(lambda: {"weighted": 0.0, "weight": 0.0, "bullish": 0, "bearish": 0, "neutral": 0,
                                                "bull_words": [], "bear_words": [], "headlines": []})
    for item in items:
        published = _day(item.get("published_at")) or today
        w = RECENCY_DECAY ** max(0, (today - published).days)
        magnitude = max(abs(item.get("score") or 0), 0.3)
        for s in item.get("stocks") or []:
            impact = s.get("impact") or item.get("sentiment")
            v = magnitude if impact == "利多" else -magnitude if impact == "利空" else 0.0
            a = acc[s["code"]]
            a["name"] = s.get("name")
            a["weighted"] += w * v
            a["weight"] += w
            a[{"利多": "bullish", "利空": "bearish"}.get(impact, "neutral")] += 1
            if impact == "利多":
                a["bull_words"] += item.get("bullish_keywords") or []
            elif impact == "利空":
                a["bear_words"] += item.get("bearish_keywords") or []
            if len(a["headlines"]) < 3:
                a["headlines"].append({"title": item["title"], "url": item["url"], "sentiment": impact,
                                       "source": item.get("source"), "published_at": item.get("published_at")})
    out = {}
    for code, a in acc.items():
        raw = a["weighted"] / a["weight"] if a["weight"] else 0.0
        confidence = min(1.0, a["weight"] / 1.5)

        def top(words):
            counts = defaultdict(int)
            for w in words:
                counts[w] += 1
            return [w for w, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:4]

        out[code] = {"name": a["name"], "news_score": round(raw * confidence, 4), "bullish": a["bullish"],
                     "bearish": a["bearish"], "neutral": a["neutral"], "bullish_keywords": top(a["bull_words"]),
                     "bearish_keywords": top(a["bear_words"]), "headlines": a["headlines"]}
    return out


def _amount(flow: dict) -> str:
    lots = f"{abs(flow['net_lots']):,} 張"
    return f"{lots}（約 {abs(flow['net_value']) / 1e8:.1f} 億元）" if flow.get("net_value") is not None else lots


def rule_reason(entry: dict, side: str) -> str:
    """不需 AI 的固定格式理由。"""
    if side == "buy":
        streak = f"連買 {entry['streak_days']} 天、" if entry["streak_days"] >= 2 else ""
        words = "、".join(entry["bullish_keywords"][:3])
        text = f"外資{streak}今日買超 {_amount(entry)}；近期 {entry['bullish']} 則利多新聞" + (f"（{words}）" if words else "")
        if entry["bearish"]:
            text += f"，但也有 {entry['bearish']} 則利空"
    else:
        streak = f"連賣 {entry['sell_streak_days']} 天、" if entry["sell_streak_days"] >= 2 else ""
        words = "、".join(entry["bearish_keywords"][:3])
        text = f"外資{streak}今日賣超 {_amount(entry)}；近期 {entry['bearish']} 則利空新聞" + (f"（{words}）" if words else "")
        if entry["bullish"]:
            text += f"，但也有 {entry['bullish']} 則利多"
    return text + "。"


def build(flows: list[dict], news_items: list[dict], today: date, *, top_n: int = 10,
          big_value: float = BIG_TRADE_VALUE) -> dict:
    signals = news_signals(news_items, today)
    candidates = []
    for flow in flows:
        sig = signals.get(flow["code"])
        if not sig:
            continue  # 需同時有外資與新聞訊號
        f = foreign_score(flow, big_value)
        n = sig["news_score"]
        entry = {**{k: flow.get(k) for k in ("code", "name", "market", "net_lots", "net_value", "price",
                                               "streak_days", "sell_streak_days")},
                 **{k: sig[k] for k in ("bullish", "bearish", "neutral", "bullish_keywords", "bearish_keywords", "headlines")},
                 "foreign_score": round(f * 100), "news_score": round(n * 100),
                 "score": round(100 * (WEIGHT_FOREIGN * f + WEIGHT_NEWS * n))}
        candidates.append(entry)
    size = lambda c: abs(c["net_value"] or 0)  # 同分時以買賣超金額大者優先
    buys = sorted((c for c in candidates if c["foreign_score"] > 0 and c["news_score"] > 0),
                  key=lambda c: (-c["score"], -size(c)))[:top_n]
    sells = sorted((c for c in candidates if c["foreign_score"] < 0 and c["news_score"] < 0),
                   key=lambda c: (c["score"], -size(c)))[:top_n]
    for side, rows in (("buy", buys), ("sell", sells)):
        for c in rows:
            c["reason"] = rule_reason(c, side)
            c["reason_by"] = "rule"
    return {"buy": buys, "sell": sells, "candidates": len(candidates),
            "weights": {"foreign": WEIGHT_FOREIGN, "news": WEIGHT_NEWS}, "disclaimer": DISCLAIMER}


# ---------------- Claude 撰寫推薦理由（選用） ----------------
class StockReason(BaseModel):
    code: str
    reason: str = Field(description="40 到 80 字的繁體中文理由，引用外資數字與新聞重點，不使用保證獲利等字眼")


class Reasons(BaseModel):
    reasons: list[StockReason]


REASON_PROMPT = (
    "你是台股量化分析助理。以下是依外資買賣超與新聞情緒篩出的觀察名單。請為每檔股票寫一句簡短理由，"
    "說明外資動向與新聞面為何支持「建議買入」或「建議賣出／避開」，必要時點出相反訊號。"
    "只使用提供的資料，不預測價格、不保證報酬。"
)


def claude_reasons(result: dict, client=None) -> dict:
    """以 Claude 改寫理由；沒有金鑰或失敗時保留固定格式理由。"""
    rows = result["buy"] + result["sell"]
    if not rows or (client is None and not llm_available()):
        return result
    import json

    payload = [{"side": "建議買入" if r in result["buy"] else "建議賣出/避開",
                **{k: r[k] for k in ("code", "name", "net_lots", "net_value", "streak_days", "sell_streak_days",
                                     "bullish", "bearish", "bullish_keywords", "bearish_keywords", "score")},
                "headlines": [h["title"] for h in r["headlines"][:2]]} for r in rows]
    try:
        import anthropic

        client = client or anthropic.Anthropic()
        response = client.beta.messages.parse(
            model=LLM_MODEL, max_tokens=16000, system=REASON_PROMPT,
            messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False)}],
            output_format=Reasons, output_config={"effort": "low"},
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
        )
    except Exception as error:
        print(f"Claude 推薦理由失敗，使用固定格式理由：{error}")
        return result
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return result
    by_code = {r.code: r.reason.strip() for r in response.parsed_output.reasons if r.reason.strip()}
    for r in rows:
        if r["code"] in by_code:
            r["reason"] = by_code[r["code"]]
            r["reason_by"] = f"claude:{response.model}"
    return result
