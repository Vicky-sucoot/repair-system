"""每日收盤價（回測用）：證交所 MI_INDEX 與櫃買中心每日收盤行情，一個日期一次取得全部個股。"""
from __future__ import annotations

import re
from datetime import date

from .. import http
from .foreign import roc_date

TWSE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
TPEX_URL = "https://www.tpex.org.tw/web/stock/aftertrading/daily_close_quotes/stk_quote_result.php"
# 只保留個股（4 碼）與 ETF（00 開頭），排除權證、牛熊證等
CODE = re.compile(r"^(\d{4}|00\d{2,4}[A-Z]?)$")


def _price(value) -> float | None:
    try:
        v = float(str(value).replace(",", ""))
    except ValueError:
        return None  # 「--」表示當日無成交
    return v if v > 0 else None


def _rows(tables: list[dict], title_has: str | None, code_field: str, close_field: str) -> dict[str, float]:
    closes: dict[str, float] = {}
    for table in tables or []:
        fields = table.get("fields") or []
        if code_field not in fields or close_field not in fields:
            continue
        if title_has and title_has not in (table.get("title") or ""):
            continue
        ci, pi = fields.index(code_field), fields.index(close_field)
        for row in table.get("data") or []:
            code = str(row[ci]).strip()
            price = _price(row[pi])
            if CODE.match(code) and price:
                closes[code] = price
    return closes


def parse_twse_closes(payload: dict) -> dict[str, float]:
    if payload.get("stat") != "OK":
        return {}
    return _rows(payload.get("tables"), "每日收盤行情", "證券代號", "收盤價")


def parse_tpex_closes(payload: dict) -> dict[str, float]:
    return _rows(payload.get("tables"), None, "代號", "收盤")


def fetch_closes(day: date) -> dict[str, float]:
    """回傳 {代號: 收盤價}（上市＋上櫃）；任一市場失敗時拋出例外。"""
    twse = http.get(TWSE_URL, params={"date": day.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"}, min_interval=3.0)
    closes = parse_twse_closes(twse.json())
    tpex = http.get(TPEX_URL, params={"l": "zh-tw", "d": roc_date(day)}, min_interval=2.0)
    closes.update(parse_tpex_closes(tpex.json()))
    return closes
