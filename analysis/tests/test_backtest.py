"""回測測試：報酬計算、進場日、基準、勝率與歷史外資策略。"""
import json

import pytest

from analysis import backtest, pipeline
from analysis.crawlers import prices
from analysis.tests.test_pipeline_api import setup

DATES = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16", "2026-11-17"]
# 2330 每天 +10；2317 每天 −5；9904 持平（作為市場其他股票）
PRICES = {d: {"2330": 100 + 10 * i, "2317": 100 - 5 * i, "9904": 50.0, "0050": 80.0} for i, d in enumerate(DATES)}


def test_forward_uses_next_trading_day_as_entry():
    book = backtest.PriceBook(PRICES)
    fwd = book.forward("2026-11-10", "2330", horizons=(1, 2, 10))
    assert fwd["entry_date"] == "2026-11-11"
    assert fwd[1]["return"] == pytest.approx(120 / 110 - 1) and fwd[1]["exit_date"] == "2026-11-12"
    assert fwd[2]["return"] == pytest.approx(130 / 110 - 1)
    assert fwd[10] is None  # 資料不足
    # 基準：全市場個股等權平均（排除 ETF 0050）
    market = ((120 / 110 - 1) + (90 / 95 - 1) + 0) / 3
    assert fwd[1]["excess"] == pytest.approx(120 / 110 - 1 - market)
    assert book.forward("2026-11-17", "2330")["entry_date"] is None


def test_ret_ignores_missing_and_abnormal_prices():
    book = backtest.PriceBook({"2026-11-10": {"A": 10.0, "B": 10.0}, "2026-11-11": {"A": 40.0}})
    assert book.ret("A", "2026-11-10", "2026-11-11") is None  # +300% 視為除權／減資等資料異常
    assert book.ret("B", "2026-11-10", "2026-11-11") is None


def test_evaluate_stats_and_hit_rate():
    book = backtest.PriceBook(PRICES)
    picks = [{"date": "2026-11-10", "side": "buy", "code": "2330", "name": "台積電", "score": 80},
             {"date": "2026-11-11", "side": "buy", "code": "2317", "name": "鴻海", "score": 50},
             {"date": "2026-11-10", "side": "sell", "code": "2317", "name": "鴻海", "score": -70}]
    r = backtest.evaluate(picks, book, horizons=(1,))
    buy = r["summary"]["buy"]["1"]
    assert buy["n"] == 2 and buy["hit_rate"] == 0.5
    assert buy["avg_return"] == round(((120 / 110 - 1) + (85 / 90 - 1)) / 2, 4)
    sell = r["summary"]["sell"]["1"]
    assert sell["n"] == 1 and sell["hit_rate"] == 1.0  # 賣出名單下跌即為正確
    assert r["days"] == 2 and r["picks"] == 3
    assert r["recent"][0]["date"] == "2026-11-11" and r["recent"][-1]["r1"] == round(90 / 95 - 1, 4)
    assert backtest.evaluate([], book)["summary"]["buy"]["1"] == {"n": 0}


def test_foreign_only_picks_uses_history_and_excludes_etf():
    rows = []
    for i, d in enumerate(DATES[:4]):
        rows += [{"date": d, "market": "TWSE", "code": "2330", "name": "台積電", "buy": 0, "sell": 0, "net": 1_000_000},
                 {"date": d, "market": "TWSE", "code": "2317", "name": "鴻海", "buy": 0, "sell": 0, "net": -2_000_000},
                 {"date": d, "market": "TWSE", "code": "0050", "name": "元大台灣50", "buy": 0, "sell": 0, "net": 9_000_000}]
    picks = backtest.foreign_only_picks(rows, PRICES, top_n=5, min_history=3)
    assert {p["date"] for p in picks} == {"2026-11-12", "2026-11-13"}  # 至少 3 天歷史才開始
    assert {(p["side"], p["code"]) for p in picks} == {("buy", "2330"), ("sell", "2317")}
    later = [p for p in picks if p["date"] == "2026-11-13" and p["side"] == "buy"][0]
    first = [p for p in picks if p["date"] == "2026-11-12" and p["side"] == "buy"][0]
    assert later["score"] > first["score"]  # 連買天數增加，分數提高


def test_parse_close_quotes():
    twse = {"stat": "OK", "tables": [
        {"title": "價格指數", "fields": ["指數", "收盤指數"], "data": [["寶島股價指數", "48,117.24"]]},
        {"title": "115年11月13日 每日收盤行情(全部(不含權證、牛熊證、可展延牛熊證))",
         "fields": ["證券代號", "證券名稱", "成交股數", "成交筆數", "成交金額", "開盤價", "最高價", "最低價", "收盤價"],
         "data": [["2330", "台積電", "1", "1", "1", "1", "1", "1", "1,450.00"], ["00400A", "主動國泰", "1", "1", "1", "1", "1", "1", "12.86"],
                  ["9958", "世紀鋼", "1", "1", "1", "1", "1", "1", "--"]]}]}
    assert prices.parse_twse_closes(twse) == {"2330": 1450.0, "00400A": 12.86}
    assert prices.parse_twse_closes({"stat": "很抱歉"}) == {}
    tpex = {"tables": [{"title": "上櫃股票行情", "fields": ["代號", "名稱", "收盤", "漲跌"],
                        "data": [["1815", "富喬", "55.30", "+1"], ["701234", "某權證", "1.2", "0"], ["00687B", "國泰20年美債", "30.1", "0"]]}]}
    assert prices.parse_tpex_closes(tpex) == {"1815": 55.3, "00687B": 30.1}


def test_pipeline_saves_history_and_exports_backtest(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    report = pipeline.run(3, db_path=db_path, export_dir=tmp_path, backtest_days=5)
    bt = json.loads((tmp_path / "backtest.json").read_text(encoding="utf-8"))
    assert bt["horizons"] == [1, 5, 20] and bt["price_days"] == 5
    assert bt["foreign_only"]["picks"] > 0 and report["backtest"]["combined"] == 2
    history = json.loads((tmp_path / "recommend_history.json").read_text(encoding="utf-8"))
    assert {(p["side"], p["code"]) for p in history["picks"]} == {("buy", "2330"), ("sell", "2317")}
    # 資料庫遺失（例如快取過期）時，名單歷史仍可從 JSON 還原
    db_path.unlink()
    pipeline.run(3, db_path=db_path, export_dir=tmp_path, backtest_days=5, skip_news=True)
    again = json.loads((tmp_path / "recommend_history.json").read_text(encoding="utf-8"))
    assert len(again["picks"]) == 2


def test_api_backtest(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from analysis import api
    db_path = setup(monkeypatch, tmp_path)
    pipeline.run(3, db_path=db_path, export_dir=tmp_path, backtest_days=5)
    monkeypatch.setattr(api, "DB_PATH", db_path)
    body = TestClient(api.app).get("/api/backtest").json()
    assert body["price_days"] == 5 and body["combined"]["picks"] == 2
    assert set(body["foreign_only"]["summary"]) == {"buy", "sell"}


def test_close_quotes_rejected_when_response_date_differs():
    from datetime import date
    tpex = {"date": "20261116", "tables": [{"fields": ["代號", "名稱", "收盤"], "data": [["1815", "富喬", "131.00"]]}]}
    assert prices.parse_tpex_closes(tpex, date(2026, 11, 13)) == {}  # 要 11/13，卻回傳 11/16
    assert prices.parse_tpex_closes(tpex, date(2026, 11, 16)) == {"1815": 131.0}
    assert prices.parse_tpex_closes({**tpex, "date": "1151116"}, date(2026, 11, 16)) == {"1815": 131.0}  # 民國日期
    twse = {"stat": "OK", "date": "20261112", "tables": [{"title": "每日收盤行情", "fields": ["證券代號", "收盤價"], "data": [["2330", "2,340.00"]]}]}
    assert prices.parse_twse_closes(twse, date(2026, 11, 12)) == {"2330": 2340.0}
    assert prices.parse_twse_closes(twse, date(2026, 11, 13)) == {}
