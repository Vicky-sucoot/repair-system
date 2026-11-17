"""美股、日股代號清單測試（不含價格；樣本格式取自實際回應）。"""
import json

from analysis import pipeline
from analysis.crawlers import global_quotes

SP500_HTML = """<table><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>AAPL</td><td>Apple Inc.</td><td>IT</td></tr><tr><td>BRK.B</td><td>Berkshire Hathaway</td><td>Financials</td></tr></table>
<table><tr><th>vte</th><th>x</th></tr><tr><td>a</td><td>b</td></tr></table>"""

NIKKEI_HTML = """<table><tr><th>コード</th><th>銘柄名</th><th>社名</th></tr>
<tr><td>285A</td><td>キオクシア</td><td>キオクシアホールディングス（株）</td></tr><tr><td>7203</td><td>トヨタ自動車</td><td>トヨタ自動車（株）</td></tr></table>
<table><tr><th>コード</th><th>銘柄名</th><th>社名</th></tr><tr><td>6758</td><td>ソニーグループ</td><td>ソニーグループ（株）</td></tr></table>"""


def test_parse_sp500_and_nikkei():
    assert global_quotes.parse_sp500(SP500_HTML) == [
        {"code": "AAPL", "name": "Apple Inc.", "market": "US"}, {"code": "BRK-B", "name": "Berkshire Hathaway", "market": "US"}]
    assert [(i["code"], i["name"]) for i in global_quotes.parse_nikkei(NIKKEI_HTML)] == [
        ("285A.T", "キオクシア"), ("7203.T", "トヨタ自動車"), ("6758.T", "ソニーグループ")]


def test_fetch_all_merges_lists_extras_and_aliases(monkeypatch):
    class Resp:
        def __init__(self, text):
            self.text = text

    pages = {global_quotes.SP500_URL: SP500_HTML, global_quotes.NIKKEI_URL: NIKKEI_HTML}
    monkeypatch.setattr(global_quotes.http, "get", lambda url, **k: Resp(pages[url]))
    items = {i["code"]: i for i in global_quotes.fetch_all()}
    assert items["AAPL"] == {"code": "AAPL", "name": "Apple Inc.", "market": "US", "alias": "蘋果"}
    assert items["7203.T"]["name"] == "トヨタ自動車" and items["7203.T"]["market"] == "JP"
    assert items["VOO"]["name"] == "Vanguard S&P 500 ETF" and items["VOO"]["alias"] == "先鋒標普500"
    assert items["1321.T"]["market"] == "JP"
    assert all("close" not in i for i in items.values())  # 不含價格


def test_fetch_all_keeps_fixed_lists_when_sources_fail(monkeypatch):
    def boom(url, **k):
        raise RuntimeError("timeout")

    monkeypatch.setattr(global_quotes.http, "get", boom)
    codes = {i["code"] for i in global_quotes.fetch_all()}
    assert {"VOO", "QQQ", "TSM", "1321.T"} <= codes and "AAPL" not in codes


def test_export_quotes_without_global_prices_and_fallback(tmp_path):
    path = tmp_path / "quotes.json"
    tw = [{"code": "2330", "name": "台積電", "market": "TWSE", "close": 2215.0, "change": -135.0, "date": "2026-11-16"}]
    us = [{"code": "AAPL", "name": "Apple Inc.", "market": "US", "alias": "蘋果"}]
    pipeline.export_quotes(path, tw, us)
    pipeline.export_quotes(path, tw, [])  # 美股這次沒抓到 → 沿用上一版
    q = json.loads(path.read_text(encoding="utf-8"))
    assert q["quotes"]["AAPL"] == ["Apple Inc.", "US", None, None]
    assert q["quotes"]["2330"] == ["台積電", "TWSE", 2215.0, -135.0]
    assert q["dates"] == {"TWSE": "2026-11-16"} and q["aliases"] == {"AAPL": "蘋果"}
