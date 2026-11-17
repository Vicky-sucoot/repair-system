"""美股、日股代號清單（網站自選清單用，不含價格）。

Yahoo Finance、Stooq 等報價來源的 robots.txt 都禁止程式自動抓取，因此美股、日股只提供代號與名稱，
使用者點名稱開啟 Yahoo 頁面查看報價。代號清單來源（皆允許程式讀取）：
- 美股：S&P 500 成分股（維基百科）＋常見 ETF 與非 S&P 500 熱門股（固定清單）。
- 日股：日經 225 成分股（日經官方成分股頁，日文名稱）＋常見日股 ETF（固定清單）。
"""
from __future__ import annotations

import io

from .. import http

SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
NIKKEI_URL = "https://indexes.nikkei.co.jp/nkave/index/component?idx=nk225"

# 非 S&P 500 但台灣投資人常看的美股與 ETF（名稱固定）
US_EXTRA = {
    "VOO": "Vanguard S&P 500 ETF", "SPY": "SPDR S&P 500 ETF Trust", "IVV": "iShares Core S&P 500 ETF",
    "QQQ": "Invesco QQQ Trust", "QQQM": "Invesco NASDAQ 100 ETF", "VTI": "Vanguard Total Stock Market ETF",
    "VT": "Vanguard Total World Stock ETF", "VXUS": "Vanguard Total International Stock ETF",
    "VEA": "Vanguard FTSE Developed Markets ETF", "VWO": "Vanguard FTSE Emerging Markets ETF",
    "SMH": "VanEck Semiconductor ETF", "SOXX": "iShares Semiconductor ETF", "DIA": "SPDR Dow Jones Industrial Average ETF",
    "SCHD": "Schwab U.S. Dividend Equity ETF", "VYM": "Vanguard High Dividend Yield ETF", "VIG": "Vanguard Dividend Appreciation ETF",
    "BND": "Vanguard Total Bond Market ETF", "TLT": "iShares 20+ Year Treasury Bond ETF", "IEF": "iShares 7-10 Year Treasury Bond ETF",
    "SHY": "iShares 1-3 Year Treasury Bond ETF", "GLD": "SPDR Gold Shares", "SLV": "iShares Silver Trust",
    "VNQ": "Vanguard Real Estate ETF", "ARKK": "ARK Innovation ETF", "TQQQ": "ProShares UltraPro QQQ",
    "SOXL": "Direxion Daily Semiconductor Bull 3X Shares", "SQQQ": "ProShares UltraPro Short QQQ",
    "EWJ": "iShares MSCI Japan ETF", "EWT": "iShares MSCI Taiwan ETF",
    "TSM": "Taiwan Semiconductor Manufacturing (ADR)", "ASML": "ASML Holding", "ARM": "Arm Holdings",
    "PDD": "PDD Holdings", "BABA": "Alibaba Group (ADR)", "MELI": "MercadoLibre", "SHOP": "Shopify",
    "SONY": "Sony Group (ADR)", "TM": "Toyota Motor (ADR)", "NVO": "Novo Nordisk (ADR)", "SAP": "SAP (ADR)",
    "SNOW": "Snowflake", "U": "Unity Software",
}
# 常見日股 ETF（名稱固定）
JP_EXTRA = {
    "1321.T": "NEXT FUNDS 日経225連動型上場投信", "1306.T": "NEXT FUNDS TOPIX連動型上場投信",
    "1330.T": "上場インデックスファンド225", "1570.T": "NEXT FUNDS 日経平均レバレッジ・インデックス連動型上場投信",
    "1655.T": "iシェアーズ S&P 500 米国株 ETF", "2558.T": "MAXIS 米国株式(S&P500)上場投信",
}

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
    import pandas as pd  # 延後載入，只有抓美日股清單時才需要

    return pd.read_html(io.StringIO(text))


def parse_sp500(html: str) -> list[dict]:
    """維基百科 S&P 500 成分股表：Symbol、Security。代號中的「.」改成 Yahoo 的「-」（BRK.B → BRK-B）。"""
    for table in _read_html(html):
        cols = [str(c) for c in table.columns]
        if "Symbol" in cols and "Security" in cols:
            return [{"code": str(r["Symbol"]).strip().replace(".", "-"), "name": str(r["Security"]).strip(), "market": "US"}
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
                    out.append({"code": f"{code}.T", "name": str(r["銘柄名"]).strip(), "market": "JP"})
    return out


def fetch_all() -> list[dict]:
    """回傳 [{code, name, market, alias}]（不含價格）；單一來源失敗時仍保留其他來源與固定清單。"""
    items: dict[str, dict] = {}
    for url, parser in ((SP500_URL, parse_sp500), (NIKKEI_URL, parse_nikkei)):
        try:
            for it in parser(http.get(url, min_interval=1.0).text):
                items[it["code"]] = it
        except Exception as error:
            print(f"成分股清單下載失敗（{url}）：{error}")
    for extra, market in ((US_EXTRA, "US"), (JP_EXTRA, "JP")):
        for code, name in extra.items():
            items.setdefault(code, {"code": code, "name": name, "market": market})
    return [{**it, "alias": ALIASES.get(it["code"])} for it in items.values()]
