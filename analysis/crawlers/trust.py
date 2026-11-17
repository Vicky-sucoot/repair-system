"""投信買賣超彙總表：證交所（上市）與櫃買中心（上櫃）。

- 證交所 TWT44U：https://www.twse.com.tw/rwd/zh/fund/TWT44U?date=YYYYMMDD&response=json（單位：股）
- 櫃買中心 sitctr_result.php：買超、賣超分兩張表，日期為民國年（單位：張，換算成股）；回應日期與要求不符時捨棄
回傳格式與外資相同：{date, market, code, name, buy, sell, net}。
"""
from __future__ import annotations

from datetime import date

from .. import http
from .foreign import _int, roc_date

TWSE_URL = "https://www.twse.com.tw/rwd/zh/fund/TWT44U"
TPEX_URL = "https://www.tpex.org.tw/web/stock/3insti/sitc_trading/sitctr_result.php"


def parse_twse(payload: dict, day: date) -> list[dict]:
    if payload.get("stat") != "OK" or not payload.get("data"):
        return []
    fields = [str(f).strip() for f in payload.get("fields") or []]
    try:
        ci, ni, bi, si, vi = (fields.index(n) for n in ("證券代號", "證券名稱", "買進股數", "賣出股數", "買賣超股數"))
    except ValueError:
        return []
    rows = []
    for row in payload["data"]:
        code = str(row[ci]).strip()
        if code:
            rows.append({"date": day.isoformat(), "market": "TWSE", "code": code, "name": str(row[ni]).strip(),
                         "buy": _int(row[bi]), "sell": _int(row[si]), "net": _int(row[vi])})
    return rows


def parse_tpex(payload: dict, day: date) -> list[dict]:
    rows = []
    for table in payload.get("tables") or []:
        if table.get("date") and table["date"] != roc_date(day):
            continue  # 日期不符，不能當成該日資料
        fields = [str(f).strip() for f in table.get("fields") or []]
        try:
            ci, ni, bi, si, vi = (fields.index(n) for n in ("代號", "名稱", "買進", "賣出", "買賣超(張數)"))
        except ValueError:
            continue
        for row in table.get("data") or []:
            code = str(row[ci]).strip()
            if code:
                rows.append({"date": day.isoformat(), "market": "TPEx", "code": code, "name": str(row[ni]).strip(),
                             "buy": _int(row[bi]) * 1000, "sell": _int(row[si]) * 1000, "net": _int(row[vi]) * 1000})
    return rows


def fetch_twse(day: date) -> list[dict]:
    resp = http.get(TWSE_URL, params={"date": day.strftime("%Y%m%d"), "response": "json"}, min_interval=3.0)
    return parse_twse(resp.json(), day)


def fetch_tpex(day: date) -> list[dict]:
    rows: dict[str, dict] = {}
    for kind in ("buy", "sell"):
        resp = http.get(TPEX_URL, params={"l": "zh-tw", "t": "D", "type": kind, "d": roc_date(day)}, min_interval=2.0)
        for row in parse_tpex(resp.json(), day):
            rows[row["code"]] = row
    return list(rows.values())
