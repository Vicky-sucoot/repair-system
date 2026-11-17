"""上市、上櫃股票清單與最新收盤價（用於新聞個股比對、換算外資買賣金額，以及網站的自選清單）。"""
from __future__ import annotations

from .. import http

TWSE_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
TPEX_URL = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"


def _float(value) -> float | None:
    try:
        return float(str(value).replace(",", ""))
    except (TypeError, ValueError):
        return None


def _pick(item: dict, *names: str):
    """OpenAPI 欄位名稱偶有空白或大小寫差異，容錯取值。"""
    normalized = {k.replace(" ", "").lower(): v for k, v in item.items()}
    for name in names:
        value = normalized.get(name.replace(" ", "").lower())
        if value not in (None, ""):
            return value
    return None


def roc_to_iso(value) -> str | None:
    """民國日期 1151116 → 2026-11-16。"""
    text = str(value or "").strip().replace("/", "")
    if len(text) == 7 and text.isdigit():
        return f"{int(text[:3]) + 1911}-{text[3:5]}-{text[5:]}"
    return None


def parse_stock_list(items: list[dict], market: str) -> list[dict]:
    stocks = []
    for item in items or []:
        code = _pick(item, "Code", "SecuritiesCompanyCode")
        name = _pick(item, "Name", "CompanyName")
        if not code or not name:
            continue
        close = _float(_pick(item, "ClosingPrice", "Close"))
        change = _float(_pick(item, "Change", "Changes", "PriceChange"))
        stocks.append({"code": str(code).strip(), "name": str(name).strip(), "market": market, "close": close,
                       "change": change, "date": roc_to_iso(_pick(item, "Date"))})
    return stocks


def fetch_stock_list() -> list[dict]:
    stocks = []
    for url, market in ((TWSE_URL, "TWSE"), (TPEX_URL, "TPEx")):
        try:
            stocks += parse_stock_list(http.get(url, min_interval=1.0).json(), market)
        except Exception as error:  # 清單抓不到時仍可用外資表中的名稱
            print(f"股票清單下載失敗（{market}）：{error}")
    return stocks
