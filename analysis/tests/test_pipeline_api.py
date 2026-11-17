"""資料庫、每日流程（以假資料取代網路）與 FastAPI 測試。"""
import json
from datetime import date

from fastapi.testclient import TestClient

from analysis import api, db, pipeline
from analysis.crawlers import foreign, news, stocks


def fake_twse(day: date):
    if day.weekday() >= 5 or day == date(2026, 11, 13):  # 11/13 當作休市
        return []
    return [{"date": day.isoformat(), "market": "TWSE", "code": "2330", "name": "台積電", "buy": 2_000_000, "sell": 1_000_000, "net": 1_000_000},
            {"date": day.isoformat(), "market": "TWSE", "code": "2317", "name": "鴻海", "buy": 0, "sell": 500_000, "net": -500_000}]


def fake_trust_twse(day: date):
    if day.weekday() >= 5 or day == date(2026, 11, 13):
        return []
    return [{"date": day.isoformat(), "market": "TWSE", "code": "2317", "name": "鴻海", "buy": 300_000, "sell": 0, "net": 300_000}]


def fake_tpex(day: date):
    return [{"date": day.isoformat(), "market": "TPEx", "code": "1815", "name": "富喬", "buy": 6_000_000, "sell": 0, "net": 6_000_000}]


NEWS = [
    {"id": "udn:1", "source": "經濟日報", "title": "台積電營收創高 法人看好", "url": "https://money.udn.com/1",
     "summary": "", "published_at": "2026-11-17T09:00:00+08:00", "tags": []},
    {"id": "ctee:2", "source": "工商時報", "title": "鴻海遭降評 股價重挫", "url": "https://www.ctee.com.tw/2",
     "summary": "", "published_at": "2026-11-17T10:00:00+08:00", "tags": []},
]


def setup(monkeypatch, tmp_path):
    monkeypatch.setattr(foreign, "fetch_twse", fake_twse)
    monkeypatch.setattr(foreign, "fetch_tpex", fake_tpex)
    from analysis.crawlers import trust
    monkeypatch.setattr(trust, "fetch_twse", fake_trust_twse)
    monkeypatch.setattr(trust, "fetch_tpex", lambda day: [])
    monkeypatch.setattr(stocks, "fetch_stock_list", lambda: [
        {"code": "2330", "name": "台積電", "market": "TWSE", "close": 1000.0},
        {"code": "2317", "name": "鴻海", "market": "TWSE", "close": 200.0}])
    monkeypatch.setattr(news, "fetch_all", lambda: (list(NEWS), ["鉅亨網：HTTP 500"]))
    from analysis.crawlers import global_quotes
    monkeypatch.setattr(global_quotes, "fetch_all", lambda: [
        {"code": "AAPL", "name": "Apple Inc.", "market": "US", "alias": "蘋果"}])
    monkeypatch.setattr(pipeline, "now_tw", lambda: pipeline.datetime(2026, 11, 17, 18, 0, tzinfo=pipeline.TW))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return tmp_path / "market.db"


def test_pipeline_collects_trading_days_and_exports(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    report = pipeline.run(3, db_path=db_path, export_dir=tmp_path)
    assert report["foreign_date"] == "2026-11-17"
    assert report["errors"] == ["鉅亨網：HTTP 500"]
    f = json.loads((tmp_path / "foreign.json").read_text(encoding="utf-8"))
    assert f["dates"] == ["2026-11-12", "2026-11-16", "2026-11-17"]  # 跳過週末與休市日
    assert {s["code"] for s in f["streaks"]} == {"2330", "1815"}
    assert f["big_buys"][0]["code"] == "2330" and f["big_buys"][0]["net_value"] == 1_000_000_000
    q = json.loads((tmp_path / "quotes.json").read_text(encoding="utf-8"))
    assert q["quotes"]["2330"] == ["台積電", "TWSE", 1000.0, None] and report["quotes"] == 3
    assert q["quotes"]["AAPL"] == ["Apple Inc.", "US", None, None] and q["aliases"] == {"AAPL": "蘋果"}
    assert q["dates"] == {}
    t = json.loads((tmp_path / "trust.json").read_text(encoding="utf-8"))
    assert t["date"] == "2026-11-17" and t["streaks"][0]["code"] == "2317" and t["streaks"][0]["streak_days"] == 3
    assert t["big_trade_value"] == 1e8 and report["trust_date"] == "2026-11-17"
    n = json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))
    assert n["counts"] == {"利多": 1, "利空": 1, "中性": 0}
    assert {s["code"] for s in n["stocks"]} == {"2330", "2317"}
    assert n["analyzer"] == "lexicon"


def test_pipeline_reuses_previous_analysis(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    pipeline.run(3, db_path=db_path, export_dir=tmp_path, skip_foreign=True)
    data = json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))
    data["items"][0]["reason"] = "保留的舊分析"
    (tmp_path / "news.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    db_path.unlink()  # 模擬 GitHub Actions 的全新環境
    report = pipeline.run(3, db_path=db_path, export_dir=tmp_path, skip_foreign=True)
    assert report["news_new"] == 0
    again = json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))
    assert again["items"][0]["reason"] == "保留的舊分析"


def test_api_endpoints(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    pipeline.run(3, db_path=db_path, export_dir=tmp_path)
    monkeypatch.setattr(api, "DB_PATH", db_path)
    client = TestClient(api.app)
    assert client.get("/api/health").json()["news"] == 2
    summary = client.get("/api/foreign", params={"min_days": 2}).json()
    assert summary["date"] == "2026-11-17" and summary["streaks"]
    assert client.get("/api/trust").json()["streaks"][0]["code"] == "2317"
    history = client.get("/api/foreign/2330").json()
    assert [h["date"] for h in history["history"]] == ["2026-11-12", "2026-11-16", "2026-11-17"]
    assert client.get("/api/foreign/0000").status_code == 404
    bullish = client.get("/api/news", params={"sentiment": "利多"}).json()
    assert bullish["count"] == 1 and bullish["items"][0]["stocks"][0]["code"] == "2330"
    assert client.get("/api/news", params={"stock": "2317"}).json()["count"] == 1
    assert client.get("/api/news", params={"sentiment": "大漲"}).status_code == 422
    assert {s["code"] for s in client.get("/api/news/stocks").json()} == {"2330", "2317"}


def test_db_roundtrip(tmp_path):
    conn = db.connect(tmp_path / "x.db")
    db.upsert_news(conn, NEWS[:1])
    assert db.news_items(conn, analyzed=False)[0]["tags"] == []
    db.save_analysis(conn, "udn:1", {"sentiment": "利多", "score": 0.5, "bullish_keywords": ["看好"], "bearish_keywords": [],
                                     "stocks": [{"code": "2330", "name": "台積電", "impact": "利多"}], "analyzer": "lexicon"})
    item = db.news_items(conn, analyzed=True)[0]
    assert item["bullish_keywords"] == ["看好"] and item["stocks"][0]["code"] == "2330"
