"""美股、日股收盤價（網站自選清單用）。

- 美股範圍：S&P 500 成分股（維基百科）＋常見 ETF 與非 S&P 500 熱門股。
- 日股範圍：日經 225 成分股（日經官方成分股頁，日文名稱）＋常見日股 ETF。
- 報價：Yahoo Finance spark API，一次 20 檔；最新收盤與前一交易日收盤計算漲跌。
"""
from __future__ import annotations

import io
from datetime import datetime
from zoneinfo import ZoneInfo

from .. import http

SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
NIKKEI_URL = "https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225"
SPARK_URL = "https://query1.finance.yahoo.com/v7/finance/spark"
BATCH = 20

# 非 S&P 500 但台灣投資人常看的美股與 ETF
US_EXTRA = ["VOO", "SPY", "IVV", "QQQ", "QQQM", "VTI", "VT", "VXUS", "VEA", "VWO", "SMH", "SOXX", "DIA", "SCHD", "VYM",
            "VIG", "BND", "TLT", "IEF", "SHY", "GLD", "SLV", "VNQ", "ARKK", "TQQQ", "SOXL", "SQQQ", "EWJ", "EWT",
            "TSM", "ASML", "ARM", "PDD", "BABA", "MELI", "SHOP", "SONY", "TM", "NVO", "SAP", "COIN", "MSTR", "SNOW", "U"]
# 常見日股 ETF
JP_EXTRA = ["1321.T", "1306.T", "1330.T", "1570.T", "1655.T", "2558.T"]

# 中文常用名稱（可用中文搜尋）
ALIASES = {
    "AAPL": "蘋果", "MSFT": "微軟", "NVDA": "輝達", "AMZN": "亞馬遜", "GOOGL": "谷歌 A", "GOOG": "谷歌 C", "META": "Meta 臉書",
    "TSLA": "特斯拉", "AVGO": "博通", "AMD": "超微", "INTC": "英特爾", "QCOM": "高通", "TSM": "台積電 ADR", "NFLX": "網飛",
    "BRK-B": "波克夏", "JPM": "摩根大通", "V": "Visa", "MA": "萬事達卡", "KO": "可口可樂", "PEP": "百事", "MCD": "麥當勞",
    "SBUX": "星巴克", "NKE": "耐吉", "DIS": "迪士尼", "WMT": "沃爾瑪", "COST": "好市多", "PG": "寶僑", "JNJ": "嬌生",
    "PFE": "輝瑞", "LLY": "禮來", "UNH": "聯合健康", "XOM": "埃克森美孚", "BA": "波音", "ORCL": "甲骨文", "MU": "美光",
    "ASML": "艾司摩爾", "ARM": "安謀", "BABA": "阿里巴巴", "SONY": "索尼 ADR", "TM": "豐田 ADR",
    "VOO": "先鋒標普500", "SPY": "SPDR 標普500", "IVV": "iShares 標普500", "QQQ": "那斯達克100", "VTI": "美國全市場",
    "VT": "全世界股票", "SMH": "半導體 ETF", "SOXX": "費城半導體", "DIA": "道瓊工業", "SCHD": "美國高股息", "TLT": "20年期美債",
    "GLD": "黃金 ETF",
    "1321.T": "日經225 ETF", "1306.T": "TOPIX ETF", "1330.T": "日興日經225 ETF", "1570.T": "日經225 正2", "1655.T": "日股標普500 ETF",
    "2558.T": "日股標普500 ETF（MAXIS）",
}


def _read_html(text: str):
    import pandas as pd  # 延後載入，只有抓美日股時才需要

    return pd.read_html(io.StringIO(text))


def parse_sp500(html: str) -> list[dict]:
    """維基百科 S&P 500 成分股表：Symbol、Security。代號中的「.」改成 Yahoo 的「-」（BRK.B → BRK-B）。"""
    for table in _read_html(html):
        cols = [str(c) for c in table.columns]
        if "Symbol" in cols and "Security" in cols:
            return [{"symbol": str(r["Symbol"]).strip().replace(".", "-"), "name": str(r["Security"]).strip(), "market": "US"}
                    for _, r in table.iterrows() if str(r["Symbol"]).strip()]
    return []


def parse_nikkei(html: str) -> list[dict]:
    """日經官方成分股頁（日文）：每個產業一張表，欄位「コード」「銘柄名」。"""
    out = []
    for table in _read_html(html):
        cols = [str(c) for c in table.columns]
        if "コード" in cols and "銘柄名" in cols:
            for _, r in table.iterrows():
                code = str(r["コード"]).strip()
                if code and code.lower() != "nan":
                    out.append({"symbol": f"{code}.T", "name": str(r["銘柄名"]).strip(), "market": "JP"})
    return out


def parse_spark(payload: dict) -> dict[str, dict]:
    """Yahoo spark：回傳 {代號: {name, currency, close, change, date}}。"""
    out = {}
    for item in (payload.get("spark") or {}).get("result") or []:
        try:
            resp = item["response"][0]
            meta = resp["meta"]
            closes = resp["indicators"]["quote"][0]["close"]
            stamps = resp["timestamp"]
        except (KeyError, IndexError, TypeError):
            continue
        points = [(t, c) for t, c in zip(stamps, closes) if c is not None]
        if not points:
            continue
        last_t, last = points[-1]
        prev = points[-2][1] if len(points) > 1 else None
        tz = ZoneInfo(meta.get("exchangeTimezoneName") or "UTC")
        out[item["symbol"]] = {
            "name": meta.get("longName") or meta.get("shortName") or item["symbol"],
            "currency": meta.get("currency"),
            "close": round(last, 4),
            "change": round(last - prev, 4) if prev is not None else None,
            "date": datetime.fromtimestamp(last_t, tz).date().isoformat(),
        }
    return out


def universe() -> list[dict]:
    """美股與日股的代號清單；單一來源失敗時仍保留其他來源與固定清單。"""
    items: dict[str, dict] = {}
    for url, parser in ((SP500_URL, parse_sp500), (NIKKEI_URL, parse_nikkei)):
        try:
            for it in parser(http.get(url, min_interval=1.0).text):
                items[it["symbol"]] = it
        except Exception as error:
            print(f"成分股清單下載失敗（{url}）：{error}")
    for sym in US_EXTRA:
        items.setdefault(sym, {"symbol": sym, "name": None, "market": "US"})
    for sym in JP_EXTRA:
        items.setdefault(sym, {"symbol": sym, "name": None, "market": "JP"})
    return list(items.values())


def fetch_quotes(symbols: list[dict]) -> list[dict]:
    """回傳 [{code, name, market, close, change, date, alias}]；日股優先使用日經的日文名稱。"""
    out = []
    for i in range(0, len(symbols), BATCH):
        batch = symbols[i:i + BATCH]
        try:
            resp = http.get(SPARK_URL, params={"symbols": ",".join(s["symbol"] for s in batch), "range": "5d", "interval": "1d"},
                            min_interval=0.5)
            quotes = parse_spark(resp.json())
        except Exception as error:
            print(f"美日股報價下載失敗（第 {i // BATCH + 1} 批）：{error}")
            continue
        for s in batch:
            q = quotes.get(s["symbol"])
            if not q:
                continue
            name = s["name"] if s["market"] == "JP" and s.get("name") else q["name"]
            out.append({"code": s["symbol"], "name": name, "market": s["market"], "close": q["close"],
                        "change": q["change"], "date": q["date"], "alias": ALIASES.get(s["symbol"])})
    return out


def fetch_all() -> list[dict]:
    return fetch_quotes(universe())
