"""外資篩選與新聞情緒分析測試。"""
from types import SimpleNamespace

from analysis import sentiment
from analysis.foreign_analysis import analyze, streak_length


def row(day, code, net, name=None, market="TWSE"):
    return {"date": day, "market": market, "code": code, "name": name or code, "buy": max(net, 0), "sell": max(-net, 0), "net": net}


DAYS = ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-16"]


def test_streak_length():
    assert streak_length([1, -1, 5, 3, 2]) == 3
    assert streak_length([5, 3, -2]) == 0
    assert streak_length([]) == 0


def test_analyze_streaks_and_big_trades():
    rows = []
    for i, d in enumerate(DAYS):
        rows.append(row(d, "2330", 1_000_000))            # 連買 5 天
        rows.append(row(d, "2303", -500_000 if i < 2 else 2_000_000))  # 連買 3 天
        rows.append(row(d, "1101", 100_000 if i < 4 else -3_000_000))  # 最後一天賣超
    rows.append(row(DAYS[-1], "1815", 6_145_000, market="TPEx"))     # 只有最後一天，買超 1 天
    prices = {"2330": 1000.0, "2303": 50.0, "1101": 40.0, "1815": 55.0}
    r = analyze(rows, prices, min_days=3, big_value=5e8, top_n=10)
    assert r["date"] == "2026-11-16" and r["dates"] == DAYS
    assert [(s["code"], s["streak_days"]) for s in r["streaks"]] == [("2330", 5), ("2303", 3)]
    assert r["streaks"][0]["streak_shares"] == 5_000_000
    # 大買依金額排序：2330 10 億 > 1815 3.38 億 > 2303 1 億
    assert [s["code"] for s in r["big_buys"]] == ["2330", "1815", "2303"]
    assert r["big_buys"][0]["is_big"] is True and r["big_buys"][1]["is_big"] is False
    assert r["big_sells"][0]["code"] == "1101" and r["big_sells"][0]["net_value"] == -120_000_000
    assert r["big_sells"][0]["net_lots"] == -3000
    assert r["counts"] == {"stocks": 4, "buy": 3, "sell": 1, "streaks": 2, "big_buy": 1, "big_sell": 0}


def test_analyze_without_price_and_empty():
    r = analyze([row("2026-11-16", "9999", 1000)], {})
    assert r["big_buys"][0]["net_value"] is None and r["big_buys"][0]["is_big"] is False
    assert analyze([], {})["date"] is None


STOCKS = {
    "2330": {"code": "2330", "name": "台積電"}, "2317": {"code": "2317", "name": "鴻海"},
    "5347": {"code": "5347", "name": "世界"}, "0050": {"code": "0050", "name": "元大台灣50"},
}


def test_lexicon_bullish_bearish_and_negation():
    bull = sentiment.lexicon_analyze({"title": "台積電營收創高 法人看好", "summary": "訂單滿載，獲利優於預期"}, STOCKS)
    assert bull["sentiment"] == "利多" and bull["score"] > 0.2
    assert {"營收創高", "看好", "優於預期"} <= set(bull["bullish_keywords"])
    assert bull["stocks"] == [{"code": "2330", "name": "台積電", "impact": "利多"}]
    bear = sentiment.lexicon_analyze({"title": "台股重挫失守40000點", "summary": "賣壓沉重，投資人信心危機"}, STOCKS)
    assert bear["sentiment"] == "利空"
    neg = sentiment.lexicon_analyze({"title": "法人不看好鴻海後市", "summary": ""}, STOCKS)
    assert neg["sentiment"] == "利空" and "不看好" in neg["bearish_keywords"]
    neutral = sentiment.lexicon_analyze({"title": "央行理監事會今日召開", "summary": ""}, STOCKS)
    assert neutral["sentiment"] == "中性" and neutral["score"] == 0


def test_longer_keyword_wins():
    r = sentiment.lexicon_analyze({"title": "利空出盡", "summary": ""}, STOCKS)
    assert r["bearish_keywords"] == ["利空出盡"]


def test_match_stocks_ambiguous_names_and_codes():
    assert sentiment.match_stocks("世界經濟展望", STOCKS) == []
    assert sentiment.match_stocks("世界(5347)擴產", STOCKS) == [{"code": "5347", "name": "世界"}]
    assert sentiment.match_stocks("旺矽(6223-TW)EPS上修", {"6223": {"code": "6223", "name": "旺矽"}}) == [{"code": "6223", "name": "旺矽"}]
    assert sentiment.match_stocks("元大台灣50 成交量", STOCKS) == []  # ETF 名稱不比對


def test_match_stocks_prefers_longer_names_and_title_for_short_names():
    stocks = {**STOCKS, "2454": {"code": "2454", "name": "聯發科"}, "1459": {"code": "1459", "name": "聯發"},
              "2618": {"code": "2618", "name": "長榮航"}, "2603": {"code": "2603", "name": "長榮"},
              "8923": {"code": "8923", "name": "時報"}}
    assert sentiment.match_stocks("聯發科翻紅 長榮航看好", stocks, title="聯發科翻紅 長榮航看好") == [
        {"code": "2454", "name": "聯發科"}, {"code": "2618", "name": "長榮航"}]
    text = "標題 摘要提到鴻海與工商時報"
    assert sentiment.match_stocks(text, stocks, title="標題") == []  # 兩字名稱只認標題；「時報」為常用詞
    assert sentiment.match_stocks(text, stocks, title=None) == [{"code": "2317", "name": "鴻海"}]


def test_source_tags_need_mention_in_text():
    assert sentiment.match_stocks("加權指數下跌", STOCKS, tags=["2317"]) == []
    assert sentiment.match_stocks("2317 盤中", STOCKS, tags=["2317"]) == [{"code": "2317", "name": "鴻海"}]


class FakeMessages:
    def __init__(self, output, stop_reason="end_turn", error=None):
        self.output, self.stop_reason, self.error, self.calls = output, stop_reason, error, []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(parsed_output=self.output, stop_reason=self.stop_reason, model="claude-opus-5-5")


def fake_client(messages):
    return SimpleNamespace(beta=SimpleNamespace(messages=messages))


ITEMS = [{"title": "台積電法說會釋利多", "summary": ""}, {"title": "鴻海遭降評", "summary": ""}]


def test_llm_results_are_validated_and_fallback_fills_gaps():
    output = sentiment.BatchResult(results=[sentiment.NewsSentiment(
        index=0, sentiment="利多", score=1.7, bullish_keywords=["利多"], bearish_keywords=[],
        stocks=[sentiment.StockImpact(code="2330", name="TSMC", impact="利多"),
                sentiment.StockImpact(code="9999", name="不存在", impact="利多")],
        reason="法說會釋出正面展望")])
    messages = FakeMessages(output)
    results = sentiment.analyze_items(ITEMS, STOCKS, client=fake_client(messages))
    assert results[0]["analyzer"] == "llm:claude-opus-5-5"
    assert results[0]["score"] == 1.0  # 分數夾在 -1 到 1
    assert results[0]["stocks"] == [{"code": "2330", "name": "台積電", "impact": "利多"}]  # 名稱以清單為準，剔除不存在代號
    assert results[1]["analyzer"] == "lexicon"  # 模型漏掉的新聞改用關鍵字分析
    call = messages.calls[0]
    assert call["output_format"] is sentiment.BatchResult and call["fallbacks"] == "default"


def test_llm_refusal_or_error_falls_back_to_lexicon():
    refused = sentiment.analyze_items(ITEMS, STOCKS, client=fake_client(FakeMessages(None, stop_reason="refusal")))
    assert all(r["analyzer"] == "lexicon" for r in refused)
    failed = sentiment.analyze_items(ITEMS, STOCKS, client=fake_client(FakeMessages(None, error=RuntimeError("timeout"))))
    assert [r["sentiment"] for r in failed] == ["利多", "利空"]


def test_llm_not_used_without_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert sentiment.llm_available() is False
    assert sentiment.analyze_items(ITEMS, STOCKS)[0]["analyzer"] == "lexicon"
