"""美股、日股自選清單報價測試（樣本格式取自實際回應）。"""
import json

from analysis import pipeline
from analysis.crawlers import global_quotes

SP500_HTML = """<table><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>AAPL</td><td>Apple Inc.</td><td>IT</td></tr><tr><td>BRK.B</td><td>Berkshire Hathaway</td><td>Financials</td></tr></table>
<table><tr><th>vte</th><th>x</th></tr><tr><td>a</td><td>b</td></tr></table>"""

NIKKEI_HTML = """<table><tr><th>コード</th><th>銘柄名</th><th>社名</th></tr>
<tr><td>285A</td><td>キオクシア</td><td>キオクシアホールディングス（株）</td></tr><tr><td>7203</td><td>トヨタ自動車</td><td>トヨタ自動車（株）</td></tr></table>
<table><tr><th>コード</th><th>銘柄名</th><th>社名</th></tr><tr><td>6758</td><td>ソニーグループ</td><td>ソニーグループ（株）</td></tr></table>"""

SPARK = {"spark": {"result": [
    {"symbol": "AAPL", "response": [{"meta": {"currency": "USD", "longName": "Apple Inc.", "shortName": "Apple",
                                              "exchangeTimezoneName": "America/New_York"},
                                     "timestamp": [1794580200, 1794839400], "indicators": {"quote": [{"close": [356.27, 352.78]}]}}]},
    {"symbol": "7203.T", "response": [{"meta": {"currency": "JPY", "longName": "Toyota Motor Corporation", "exchangeTimezoneName": "Asia/Tokyo"},
                                       "timestamp": [1794787200, 1794873600], "indicators": {"quote": [{"close": [3428.0, 3414.0]}]}}]},
    {"symbol": "BAD", "response": [{"meta": {}, "timestamp": [1], "indicators": {"quote": [{"close": [None]}]}}]},
]}}


def test_parse_sp500_and_nikkei():
    assert global_quotes.parse_sp500(SP500_HTML) == [
        {"symbol": "AAPL", "name": "Apple Inc.", "market": "US"}, {"symbol": "BRK-B", "name": "Berkshire Hathaway", "market": "US"}]
    assert [(i["symbol"], i["name"]) for i in global_quotes.parse_nikkei(NIKKEI_HTML)] == [
        ("285A.T", "キオクシア"), ("7203.T", "トヨタ自動車"), ("6758.T", "ソニーグループ")]


def test_parse_spark_dates_in_exchange_timezone():
    q = global_quotes.parse_spark(SPARK)
    assert set(q) == {"AAPL", "7203.T"}
    assert q["AAPL"] == {"name": "Apple Inc.", "currency": "USD", "close": 352.78, "change": -3.49, "date": "2026-11-16"}
    assert q["7203.T"]["change"] == -14.0 and q["7203.T"]["date"] == "2026-11-17"


def test_fetch_quotes_prefers_japanese_names(monkeypatch):
    class Resp:
        def json(self):
            return SPARK
    monkeypatch.setattr(global_quotes.http, "get", lambda *a, **k: Resp())
    out = global_quotes.fetch_quotes([{"symbol": "AAPL", "name": "Apple Inc.", "market": "US"},
                                      {"symbol": "7203.T", "name": "トヨタ自動車", "market": "JP"},
                                      {"symbol": "ZZZZ", "name": None, "market": "US"}])
    assert [(o["code"], o["name"], o["alias"]) for o in out] == [("AAPL", "Apple Inc.", "蘋果"), ("7203.T", "トヨタ自動車", None)]


def test_export_quotes_keeps_previous_global_quotes(tmp_path):
    path = tmp_path / "quotes.json"
    tw = [{"code": "2330", "name": "台積電", "market": "TWSE", "close": 2215.0, "change": -135.0, "date": "2026-11-16"}]
    us = [{"code": "AAPL", "name": "Apple Inc.", "market": "US", "close": 352.78, "change": -3.49, "date": "2026-11-16", "alias": "蘋果"}]
    pipeline.export_quotes(path, tw, us)
    pipeline.export_quotes(path, tw, [])  # 美股這次沒抓到 → 沿用上一版
    q = json.loads(path.read_text(encoding="utf-8"))
    assert q["quotes"]["AAPL"] == ["Apple Inc.", "US", 352.78, -3.49]
    assert q["dates"] == {"TWSE": "2026-11-16", "US": "2026-11-16"} and q["aliases"] == {"AAPL": "蘋果"}
