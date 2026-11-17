"""外資動向 Claude 解讀與「改用 Claude 後重新分析」測試（以假 client 取代 API）。"""
import json
from types import SimpleNamespace

from analysis import insight, pipeline, sentiment
from analysis.tests.test_pipeline_api import setup

FOREIGN = {
    "date": "2026-11-16", "counts": {"buy": 1}, "streak_min_days": 3,
    "streaks": [{"code": "2885", "name": "元大金", "market": "TWSE", "net_lots": 9789, "net_value": 6.7e8, "streak_days": 6, "is_big": True}],
    "big_buys": [], "big_sells": [{"code": "2330", "name": "台積電", "market": "TWSE", "net_lots": -8466, "net_value": -1.8e10, "streak_days": 0, "is_big": True}],
}
NEWS_STOCKS = [{"code": "2454", "name": "聯發科", "bullish": 1, "bearish": 0, "neutral": 0, "headlines": [{"title": "聯發科翻紅"}]}]


class FakeMessages:
    def __init__(self, output, stop_reason="end_turn", error=None):
        self.output, self.stop_reason, self.error, self.calls = output, stop_reason, error, []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(parsed_output=self.output, stop_reason=self.stop_reason, model="claude-opus-5-5")


def client(messages):
    return SimpleNamespace(beta=SimpleNamespace(messages=messages))


OUTPUT = insight.ForeignInsight(
    summary="外資連續買超金融股，同時大賣台積電。",
    highlights=[insight.StockSignal(code="2885", name="Yuanta", view="偏多", reason="連買 6 天"),
                insight.StockSignal(code="2330", name="台積電", view="偏空", reason="單日賣超 187 億"),
                insight.StockSignal(code="9999", name="不存在", view="觀察", reason="x")],
    themes=["金融", "AI"], risks=["半導體賣壓"])


def test_generate_validates_codes_and_sends_both_datasets():
    messages = FakeMessages(OUTPUT)
    result = insight.generate(FOREIGN, NEWS_STOCKS, {"利多": 1}, client=client(messages))
    assert result["summary"].startswith("外資")
    assert result["highlights"] == [
        {"code": "2885", "name": "元大金", "view": "偏多", "reason": "連買 6 天"},
        {"code": "2330", "name": "台積電", "view": "偏空", "reason": "單日賣超 187 億"}]
    assert result["themes"] == ["金融", "AI"] and result["model"] == "claude-opus-5-5"
    call = messages.calls[0]
    assert call["output_format"] is insight.ForeignInsight and call["fallbacks"] == "default"
    prompt = call["messages"][0]["content"]
    assert "元大金" in prompt and "聯發科翻紅" in prompt


def test_generate_returns_none_on_refusal_error_or_no_key(monkeypatch):
    assert insight.generate(FOREIGN, [], {}, client=client(FakeMessages(None, stop_reason="refusal"))) is None
    assert insight.generate(FOREIGN, [], {}, client=client(FakeMessages(None, error=RuntimeError("429")))) is None
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert insight.generate(FOREIGN, [], {}) is None
    assert insight.generate({"date": None}, [], {}, client=client(FakeMessages(OUTPUT))) is None


def test_pipeline_uses_claude_for_news_and_foreign(monkeypatch, tmp_path):
    db_path = setup(monkeypatch, tmp_path)
    pipeline.run(3, db_path=db_path, export_dir=tmp_path)  # 沒有金鑰：關鍵字分析、無解讀
    first = json.loads((tmp_path / "foreign.json").read_text(encoding="utf-8"))
    assert first["insight"] is None
    assert json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))["analyzer"] == "lexicon"

    # 設定金鑰後：先前關鍵字分析的新聞重新以 Claude 分析，外資也產生解讀
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    calls = []

    def fake_batch(items, stocks, client=None):
        calls.append(len(items))
        return [{"sentiment": "中性", "score": 0.0, "bullish_keywords": [], "bearish_keywords": [], "stocks": [],
                 "reason": "Claude 判斷", "analyzer": "llm:claude-opus-5-5"} for _ in items]

    monkeypatch.setattr(sentiment, "llm_analyze_batch", fake_batch)
    monkeypatch.setattr(pipeline, "generate_insight", lambda f, s, c: {"summary": "解讀", "highlights": [], "themes": [], "risks": [], "model": "m"})
    report = pipeline.run(3, db_path=db_path, export_dir=tmp_path)
    assert calls == [2] and report["news_new"] == 2 and report["insight"] is True
    news_data = json.loads((tmp_path / "news.json").read_text(encoding="utf-8"))
    assert news_data["analyzer"] == "llm" and all(i["reason"] == "Claude 判斷" for i in news_data["items"])
    assert json.loads((tmp_path / "foreign.json").read_text(encoding="utf-8"))["insight"]["summary"] == "解讀"

    # 已用 Claude 分析過的不再重複呼叫
    calls.clear()
    pipeline.run(3, db_path=db_path, export_dir=tmp_path)
    assert calls == []
