"""綜合評分與觀察名單測試。"""
import json
from datetime import date
from types import SimpleNamespace

from fastapi.testclient import TestClient

from analysis import api, pipeline, recommend
from analysis.foreign_analysis import stock_flows
from analysis.tests.test_pipeline_api import setup

TODAY = date(2026, 11, 17)


def flow(code, name, lots, value, streak=0, sell_streak=0):
    return {"code": code, "name": name, "market": "TWSE", "net_shares": lots * 1000, "net_lots": lots,
            "net_value": value, "price": None, "streak_days": streak, "sell_streak_days": sell_streak}


def news(title, sentiment, score, stocks, day="2026-11-17", bull=(), bear=()):
    return {"title": title, "url": f"https://example.com/{title}", "source": "經濟日報", "published_at": f"{day}T10:00:00+08:00",
            "sentiment": sentiment, "score": score, "bullish_keywords": list(bull), "bearish_keywords": list(bear),
            "stocks": [{"code": c, "name": n, "impact": sentiment} for c, n in stocks]}


def test_foreign_score_scale_and_streak():
    assert recommend.foreign_score(flow("A", "A", 0, 0)) == 0
    full = recommend.foreign_score(flow("A", "A", 10000, 2e9, streak=5), big_value=5e8)
    assert full == 1.0  # 大買門檻 4 倍（20 億）且連買 5 天才滿分
    big = recommend.foreign_score(flow("A", "A", 10000, 5e8, streak=0), big_value=5e8)
    assert big == 0.3  # 5 億元：0.6 × √0.25
    assert recommend.foreign_score(flow("A", "A", -10000, -3e9, sell_streak=7), big_value=5e8) == -1.0
    assert recommend.foreign_score(flow("A", "A", 5000, None), big_value=5e8) == 0.3  # 無價格改用張數（5,000 ÷ 20,000）


def test_news_signals_recency_and_confidence():
    items = [news("a", "利多", 0.8, [("2330", "台積電")]),
             news("b", "利空", 1.0, [("2330", "台積電")], day="2026-11-16"),
             news("c", "利多", 0.1, [("2454", "聯發科")], bull=["看好"])]
    sig = recommend.news_signals(items, TODAY)
    # 2330：(1×0.8 − 0.6×1.0) ÷ 1.6 × min(1, 1.6/1.5)
    assert sig["2330"]["news_score"] == round(0.2 / 1.6, 4)
    assert (sig["2330"]["bullish"], sig["2330"]["bearish"]) == (1, 1)
    # 2454：只有一則，分數至少 0.3，可信度 1/1.5
    assert sig["2454"]["news_score"] == round(0.3 / 1.5, 4)
    assert sig["2454"]["bullish_keywords"] == ["看好"]


def test_build_requires_both_signals_and_sorts():
    flows = [flow("2885", "元大金", 9789, 6.7e8, streak=6), flow("2618", "長榮航", 3000, 1.4e8, streak=2),
             flow("2330", "台積電", -8466, -1.8e10, sell_streak=1), flow("2317", "鴻海", -28939, -6.3e9, sell_streak=3),
             flow("2454", "聯發科", -936, -3.5e9), flow("9999", "沒新聞", 50000, 9e9, streak=5)]
    items = [news("金融股看好", "利多", 0.9, [("2885", "元大金"), ("2618", "長榮航")], bull=["看好"]),
             news("航空雙雄營運續揚", "利多", 0.8, [("2618", "長榮航")], bull=["成長"]),
             news("AI 股重挫", "利空", 1.0, [("2330", "台積電"), ("2317", "鴻海")], bear=["重挫"]),
             news("聯發科翻紅", "利多", 0.9, [("2454", "聯發科")])]  # 外資賣＋新聞利多 → 訊號分歧，兩邊都不列
    r = recommend.build(flows, items, TODAY, big_value=5e8)
    assert [c["code"] for c in r["buy"]] == ["2885", "2618"]
    # 兩者金額都超過 20 億（金額強度滿分），鴻海連賣 3 天、台積電 1 天，鴻海較偏空
    assert [c["code"] for c in r["sell"]] == ["2317", "2330"]
    assert r["candidates"] == 5  # 9999 沒有新聞，不列入
    top = r["buy"][0]
    assert top["score"] > 0 and top["foreign_score"] == round(100 * (0.6 * (6.7e8 / 2e9) ** 0.5 + 0.4))
    assert top["reason"] == "外資連買 6 天、今日買超 9,789 張（約 6.7 億元）；近期 1 則利多新聞（看好）。"
    assert r["sell"][0]["reason"].startswith("外資連賣 3 天、今日賣超 28,939 張")
    assert all(c["reason_by"] == "rule" for c in r["buy"] + r["sell"])
    assert "不構成投資建議" in r["disclaimer"]


class FakeMessages:
    def __init__(self, output, stop_reason="end_turn", error=None):
        self.output, self.stop_reason, self.error, self.calls = output, stop_reason, error, []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(parsed_output=self.output, stop_reason=self.stop_reason, model="claude-opus-5-5")


def client(m):
    return SimpleNamespace(beta=SimpleNamespace(messages=m))


def sample_result():
    flows = [flow("2885", "元大金", 9789, 6.7e8, streak=6), flow("2330", "台積電", -8466, -1.8e10, sell_streak=1)]
    items = [news("x", "利多", 0.9, [("2885", "元大金")]), news("y", "利空", 1.0, [("2330", "台積電")])]
    return recommend.build(flows, items, TODAY)


def test_claude_reasons_replace_rule_reasons_for_known_codes():
    output = recommend.Reasons(reasons=[recommend.StockReason(code="2885", reason="外資連買 6 天且金融股利多。"),
                                        recommend.StockReason(code="0000", reason="不存在")])
    m = FakeMessages(output)
    r = recommend.claude_reasons(sample_result(), client=client(m))
    assert r["buy"][0]["reason"] == "外資連買 6 天且金融股利多。" and r["buy"][0]["reason_by"] == "claude:claude-opus-5-5"
    assert r["sell"][0]["reason_by"] == "rule"  # 模型沒給理由的保留固定格式
    assert m.calls[0]["fallbacks"] == "default"


def test_claude_reasons_fallback(monkeypatch):
    for m in (FakeMessages(None, stop_reason="refusal"), FakeMessages(None, error=RuntimeError("timeout"))):
        r = recommend.claude_reasons(sample_result(), client=client(m))
        assert all(c["reason_by"] == "rule" for c in r["buy"] + r["sell"])
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert recommend.claude_reasons(sample_result())["buy"][0]["reason_by"] == "rule"


def test_stock_flows_sell_streak():
    rows = [{"date": d, "market": "TWSE", "code": "2317", "name": "鴻海", "buy": 0, "sell": 0, "net": n}
            for d, n in [("2026-11-12", 5), ("2026-11-13", -1), ("2026-11-16", -2)]]
    dates, flows = stock_flows(rows, {"2317": 200.0})
    assert flows[0]["sell_streak_days"] == 2 and flows[0]["streak_days"] == 0


def test_pipeline_exports_recommendations_and_api(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    report = pipeline.run(3, db_path=db_path, export_dir=tmp_path)
    data = json.loads((tmp_path / "recommend.json").read_text(encoding="utf-8"))
    # 假資料：台積電外資買超＋利多新聞；鴻海外資賣超＋利空新聞
    assert [c["code"] for c in data["buy"]] == ["2330"] and [c["code"] for c in data["sell"]] == ["2317"]
    assert report["recommend"] == {"buy": 1, "sell": 1} and data["date"] == "2026-11-17"
    monkeypatch.setattr(api, "DB_PATH", db_path)
    body = TestClient(api.app).get("/api/recommendations").json()
    assert [c["code"] for c in body["buy"]] == ["2330"] and body["sell"][0]["name"] == "鴻海"
