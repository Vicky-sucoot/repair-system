"""每日收盤價（回測用）：證交所 MI_INDEX 與櫃買中心上櫃每日收盤行情，一個日期一次取得全部個股；回應日期與要求不符時捨棄。"""
from __future__ import annotations

import re
from datetime import date

from .. import http

TWSE_URL = "https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX"
# 注意：舊網址 daily_close_quotes/stk_quote_result.php 會忽略日期、永遠回傳最新一天，不能用於回測
TPEX_URL = "https://www.tpex.org.tw/www/zh-tw/afterTrading/otc"
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
        fields = [str(f).strip() for f in table.get("fields") or []]  # 櫃買欄位名稱有尾端空白（「收盤 」）
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


def _response_day(payload: dict) -> str | None:
    """回應中的資料日期，統一成 YYYYMMDD（證交所為西元，櫃買中心可能為西元或民國）。"""
    raw = str(payload.get("date") or "").replace("/", "").replace("-", "").strip()
    if len(raw) == 7 and raw.isdigit():  # 民國 1151113
        return f"{int(raw[:3]) + 1911}{raw[3:]}"
    return raw or None


def parse_twse_closes(payload: dict, day: date | None = None) -> dict[str, float]:
    if payload.get("stat") != "OK":
        return {}
    if day and _response_day(payload) != day.strftime("%Y%m%d"):
        return {}  # 回應不是要求的日期，不能拿來回測
    return _rows(payload.get("tables"), "每日收盤行情", "證券代號", "收盤價")


def parse_tpex_closes(payload: dict, day: date | None = None) -> dict[str, float]:
    # 櫃買中心此網址會忽略日期參數、永遠回傳最新一天；日期不符時整份捨棄，避免把同一價格當成歷史價格
    if day and _response_day(payload) != day.strftime("%Y%m%d"):
        return {}
    return _rows(payload.get("tables"), None, "代號", "收盤")


def fetch_closes(day: date) -> dict[str, float]:
    """回傳 {代號: 收盤價}（上市＋上櫃）；任一市場失敗時拋出例外。"""
    twse = http.get(TWSE_URL, params={"date": day.strftime("%Y%m%d"), "type": "ALLBUT0999", "response": "json"}, min_interval=3.0)
    closes = parse_twse_closes(twse.json(), day)
    tpex = http.get(TPEX_URL, params={"date": day.strftime("%Y/%m/%d"), "type": "EW", "response": "json"}, min_interval=2.0)
    closes.update(parse_tpex_closes(tpex.json(), day))
    return closes
