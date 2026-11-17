"""外資及陸資買賣超彙總表：證交所（上市）與櫃買中心（上櫃）。

- 證交所 TWT38U：https://www.twse.com.tw/rwd/zh/fund/TWT38U?date=YYYYMMDD&response=json（單位：股）
- 櫃買中心 forgtr_result.php：買超、賣超分兩張表，日期為民國年（單位：張，換算成股）
回傳統一格式：{date, market, code, name, buy, sell, net}，股數為整數。
"""
from __future__ import annotations

from datetime import date

from .. import http

TWSE_URL = "https://www.twse.com.tw/rwd/zh/fund/TWT38U"
TPEX_URL = "https://www.tpex.org.tw/web/stock/3insti/qfii_trading/forgtr_result.php"


def _int(value) -> int:
    text = str(value).replace(",", "").strip()
    try:
        return int(float(text))
    except ValueError:
        return 0


def parse_twse(payload: dict, day: date) -> list[dict]:
    """解析證交所 TWT38U。欄位最後三欄為外資合計（含外資自營商）的買進、賣出、買賣超股數。"""
    if payload.get("stat") != "OK" or not payload.get("data"):
        return []
    rows = []
    for row in payload["data"]:
        if len(row) < 12:
            continue
        code, name = str(row[1]).strip(), str(row[2]).strip()
        if not code:
            continue
        rows.append({"date": day.isoformat(), "market": "TWSE", "code": code, "name": name,
                     "buy": _int(row[9]), "sell": _int(row[10]), "net": _int(row[11])})
    return rows


def parse_tpex(payload: dict, day: date) -> list[dict]:
    """解析櫃買中心外資買賣超表（單位：張 → 股）。"""
    rows = []
    for table in payload.get("tables") or []:
        for row in table.get("data") or []:
            if len(row) < 12:
                continue
            code, name = str(row[1]).strip(), str(row[2]).strip()
            if not code:
                continue
            rows.append({"date": day.isoformat(), "market": "TPEx", "code": code, "name": name,
                         "buy": _int(row[9]) * 1000, "sell": _int(row[10]) * 1000, "net": _int(row[11]) * 1000})
    return rows


def roc_date(day: date) -> str:
    return f"{day.year - 1911}/{day.month:02d}/{day.day:02d}"


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
