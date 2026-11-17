"""新聞情緒分析：利多／利空判斷、關鍵字與相關個股。

兩種分析器：
- lexicon（預設）：關鍵字詞典＋否定詞處理，不需金鑰。
- llm：設定 ANTHROPIC_API_KEY 時，以 Claude 結構化輸出分析；失敗或被拒時退回 lexicon。
"""
from __future__ import annotations

import os
import re
from typing import Literal

from pydantic import BaseModel, Field

from .config import LLM_MODEL

BULLISH = [
    "利多", "大漲", "上漲", "漲停", "勁揚", "走高", "創新高", "新高", "看好", "看旺", "買超", "加碼", "成長", "增長",
    "獲利", "轉盈", "優於預期", "超乎預期", "上修", "調升", "升評", "營收創高", "接單", "訂單滿", "擴產", "回升",
    "反彈", "突破", "受惠", "強勁", "護盤", "配息", "增資", "利基", "復甦", "樂觀", "旺季", "題材", "噴出", "攻頂",
]
BEARISH = [
    "利空", "重挫", "大跌", "下跌", "跌停", "崩跌", "走低", "暴跌", "賣超", "減碼", "衰退", "虧損", "轉虧", "低於預期",
    "下修", "調降", "降評", "砍單", "減產", "疲弱", "警訊", "裁員", "制裁", "衝擊", "破發", "套牢", "保衛戰", "失守",
    "跌破", "賣壓", "恐慌", "信心危機", "風暴", "悲觀", "淡季", "下滑", "疑慮", "利空出盡",
]
NEGATIONS = ("不", "未", "沒", "無", "難", "非")
# 常見詞恰好也是股名的，只有在「名稱(代號)」寫法時才算個股
AMBIGUOUS_NAMES = {"世界", "中華", "大同", "統一", "國產", "東元", "大成", "正新", "長興", "興富發", "全國", "台灣",
                   "時報", "台南", "資通", "信大", "達運", "聯發", "力積", "華新", "國票", "遠東", "台中", "新光", "第一"}


def _count(text: str, words: list[str]) -> tuple[list[str], list[str]]:
    """回傳 (成立的關鍵字, 被否定的關鍵字)。較長的詞優先，避免「利空出盡」同時算到「利空」。"""
    found, negated = [], []
    taken = [False] * len(text)
    for word in sorted(words, key=len, reverse=True):
        for m in re.finditer(re.escape(word), text):
            if any(taken[m.start():m.end()]):
                continue
            for i in range(m.start(), m.end()):
                taken[i] = True
            before = text[max(0, m.start() - 2):m.start()]
            (negated if any(n in before for n in NEGATIONS) else found).append(word)
    return found, negated


def match_stocks(text: str, stocks: dict[str, dict], tags: list[str] | None = None, title: str | None = None) -> list[dict]:
    """
    比對新聞提到的上市櫃個股：
    - 「名稱(代號)」或「(代號)」寫法一定採用；
    - 名稱比對時較長的名稱優先（「聯發科」不會再算到「聯發」）；
    - 兩個字的名稱容易與一般詞混淆，只在標題中出現才採用；
    - 來源附的個股標籤（tags）只有在內文提到該股名稱或代號時才採用。
    """
    hits: dict[str, dict] = {}
    for m in re.finditer(r"[(（](\d{4,6}[A-Z]?)(?:-TW)?[)）]", text):
        if m.group(1) in stocks:
            hits[m.group(1)] = stocks[m.group(1)]
    taken = [False] * len(text)
    candidates = sorted(((c, s) for c, s in stocks.items() if len(s["name"]) >= 2 and not c.startswith("0")),
                        key=lambda cs: len(cs[1]["name"]), reverse=True)  # 0 開頭多為 ETF，名稱常與一般詞重疊
    for code, s in candidates:
        name = s["name"]
        for m in re.finditer(re.escape(name), text):
            if any(taken[m.start():m.end()]):
                continue
            for i in range(m.start(), m.end()):
                taken[i] = True
            if code in hits or name in AMBIGUOUS_NAMES:
                continue
            if len(name) == 2 and title is not None and name not in title:
                continue
            hits[code] = s
    for code in tags or []:
        if code in stocks and code not in hits and (code in text or stocks[code]["name"] in text):
            hits[code] = stocks[code]
    return [{"code": c, "name": s["name"]} for c, s in sorted(hits.items())]


def lexicon_analyze(item: dict, stocks: dict[str, dict]) -> dict:
    text = f"{item.get('title', '')} {item.get('summary', '')}"
    bull, bull_neg = _count(text, BULLISH)
    bear, bear_neg = _count(text, BEARISH)
    # 被否定的利多視為利空、被否定的利空視為利多（如「不看好」「未衰退」）
    pos = len(bull) + len(bear_neg)
    neg = len(bear) + len(bull_neg)
    title_bull, _ = _count(item.get("title", ""), BULLISH)
    title_bear, _ = _count(item.get("title", ""), BEARISH)
    pos += len(title_bull)  # 標題權重加倍
    neg += len(title_bear)
    score = 0.0 if pos + neg == 0 else round((pos - neg) / (pos + neg), 3)
    sentiment = "利多" if score > 0.2 else "利空" if score < -0.2 else "中性"
    return {
        "sentiment": sentiment, "score": score,
        "bullish_keywords": sorted(set(bull + [f"不{w}" for w in bear_neg])),
        "bearish_keywords": sorted(set(bear + [f"不{w}" for w in bull_neg])),
        "stocks": [{**s, "impact": sentiment} for s in match_stocks(text, stocks, item.get("tags"), item.get("title", ""))],
        "reason": None, "analyzer": "lexicon",
    }


# ---------------- LLM（Claude）分析 ----------------
class StockImpact(BaseModel):
    code: str = Field(description="台股代號，例如 2330")
    name: str
    impact: Literal["利多", "利空", "中性"]


class NewsSentiment(BaseModel):
    index: int = Field(description="新聞編號（輸入中的 [n]）")
    sentiment: Literal["利多", "利空", "中性"]
    score: float = Field(description="-1（極度利空）到 1（極度利多）")
    bullish_keywords: list[str]
    bearish_keywords: list[str]
    stocks: list[StockImpact]
    reason: str = Field(description="一句話說明判斷理由（繁體中文）")


class BatchResult(BaseModel):
    results: list[NewsSentiment]


SYSTEM_PROMPT = (
    "你是台股財經新聞分析助理。對每則新聞判斷對台股投資人的情緒（利多、利空或中性），"
    "給出 -1 到 1 的分數，從標題與摘要中擷取代表利多與利空的關鍵詞（原文用詞），"
    "並列出新聞直接提到的台灣上市櫃個股（代號與名稱，只列有把握的，不要猜測代號），"
    "以及該新聞對各股的影響。理由用一句繁體中文說明。只依據提供的文字判斷，不要引用外部資訊。"
)


def llm_available() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY")) and os.environ.get("SENTIMENT_ANALYZER", "auto") != "lexicon"


def llm_analyze_batch(items: list[dict], stocks: dict[str, dict], client=None) -> list[dict | None]:
    """一次分析多則新聞；回傳與 items 對應的結果，無法分析的位置為 None（由呼叫端改用 lexicon）。"""
    import anthropic

    client = client or anthropic.Anthropic()
    lines = [f"[{i}] 標題：{it['title']}\n摘要：{it.get('summary') or ''}" for i, it in enumerate(items)]
    response = client.beta.messages.parse(
        model=LLM_MODEL,
        max_tokens=16000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": "請分析以下新聞：\n\n" + "\n\n".join(lines)}],
        output_format=BatchResult,
        output_config={"effort": "low"},  # 分類任務，低 effort 即可
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",  # 主要模型拒答時由伺服器改用備援模型
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return [None] * len(items)
    out: list[dict | None] = [None] * len(items)
    for r in response.parsed_output.results:
        if not 0 <= r.index < len(items):
            continue
        # 只保留確實存在的個股代號，避免模型產生不存在的代號
        valid = [{"code": s.code, "name": stocks[s.code]["name"], "impact": s.impact}
                 for s in r.stocks if s.code in stocks] if stocks else [s.model_dump() for s in r.stocks]
        out[r.index] = {
            "sentiment": r.sentiment, "score": max(-1.0, min(1.0, round(r.score, 3))),
            "bullish_keywords": r.bullish_keywords, "bearish_keywords": r.bearish_keywords,
            "stocks": valid, "reason": r.reason, "analyzer": f"llm:{response.model}",
        }
    return out


def analyze_items(items: list[dict], stocks: dict[str, dict], *, batch_size: int = 20, client=None) -> list[dict]:
    """分析多則新聞。可用 LLM 時優先使用，任何錯誤都退回 lexicon，不中斷流程。"""
    results: list[dict | None] = [None] * len(items)
    if items and (client is not None or llm_available()):
        for start in range(0, len(items), batch_size):
            batch = items[start:start + batch_size]
            try:
                for offset, r in enumerate(llm_analyze_batch(batch, stocks, client=client)):
                    results[start + offset] = r
            except Exception as error:  # 網路、額度、格式錯誤等
                print(f"LLM 分析失敗，改用關鍵字分析：{error}")
    return [r or lexicon_analyze(item, stocks) for item, r in zip(items, results)]
