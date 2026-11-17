"""外資動向的 Claude 解讀：綜合外資連續買超、大買／大賣與新聞情緒，產生摘要與重點個股。

需要 ANTHROPIC_API_KEY；沒有金鑰、呼叫失敗或被拒答時回傳 None（網站不顯示解讀，其他資料照常更新）。
"""
from __future__ import annotations

import json
from typing import Literal

from pydantic import BaseModel, Field

from .config import LLM_MODEL
from .sentiment import llm_available


class StockSignal(BaseModel):
    code: str = Field(description="台股代號，必須出現在提供的資料中")
    name: str
    view: Literal["偏多", "偏空", "觀察"]
    reason: str = Field(description="一句繁體中文理由，引用資料中的數字或新聞")


class ForeignInsight(BaseModel):
    summary: str = Field(description="2 到 4 句繁體中文，說明今日外資動向重點與新聞面的呼應或矛盾")
    highlights: list[StockSignal] = Field(description="最多 8 檔值得注意的個股")
    themes: list[str] = Field(description="外資買賣集中的產業或題材，最多 5 個")
    risks: list[str] = Field(description="需要留意的風險，最多 3 點")


SYSTEM_PROMPT = (
    "你是台股籌碼與消息面分析助理。根據提供的外資及陸資買賣超統計（連續買超、連續賣超、單日大買、單日大賣，"
    "金額以最新收盤價估算）與近期新聞情緒彙整，寫出給一般投資人看的繁體中文解讀。"
    "只能使用提供的資料，不要引用外部資訊或預測股價；個股代號必須來自提供的資料。"
    "語氣客觀，不提供買賣建議。"
)


def _compact(rows: list[dict], n: int = 15) -> list[dict]:
    keys = ("code", "name", "market", "net_lots", "net_value", "streak_days", "sell_streak_days", "is_big")
    return [{k: r.get(k) for k in keys} for r in rows[:n]]


def build_prompt(foreign: dict, news_stocks: list[dict], news_counts: dict) -> str:
    payload = {
        "date": foreign.get("date"),
        "counts": foreign.get("counts"),
        "streak_min_days": foreign.get("streak_min_days"),
        "streaks": _compact(foreign.get("streaks") or []),
        "sell_streaks": _compact(foreign.get("sell_streaks") or []),
        "big_buys": _compact(foreign.get("big_buys") or []),
        "big_sells": _compact(foreign.get("big_sells") or []),
        "news_counts": news_counts,
        "news_stocks": [{k: s.get(k) for k in ("code", "name", "bullish", "bearish", "neutral")}
                        | {"headlines": [h["title"] for h in s.get("headlines", [])[:2]]} for s in news_stocks[:20]],
    }
    return "以下是今日資料（JSON，net_lots 單位為張，net_value 單位為新台幣元）：\n" + json.dumps(payload, ensure_ascii=False)


def generate(foreign: dict, news_stocks: list[dict], news_counts: dict, client=None) -> dict | None:
    if not foreign.get("date") or (client is None and not llm_available()):
        return None
    try:
        import anthropic

        client = client or anthropic.Anthropic()
        response = client.beta.messages.parse(
            model=LLM_MODEL,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": build_prompt(foreign, news_stocks, news_counts)}],
            output_format=ForeignInsight,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",  # 主要模型拒答時由伺服器改用備援模型
        )
    except Exception as error:  # 網路、額度、格式錯誤等
        print(f"Claude 外資解讀失敗：{error}")
        return None
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return None
    insight = response.parsed_output
    known = {r["code"]: r["name"] for key in ("streaks", "sell_streaks", "big_buys", "big_sells") for r in foreign.get(key) or []}
    known.update({s["code"]: s["name"] for s in news_stocks})
    return {
        "summary": insight.summary,
        # 只保留資料中確實存在的代號，名稱以資料為準
        "highlights": [{"code": h.code, "name": known[h.code], "view": h.view, "reason": h.reason}
                       for h in insight.highlights if h.code in known][:8],
        "themes": insight.themes[:5],
        "risks": insight.risks[:3],
        "model": response.model,
    }
