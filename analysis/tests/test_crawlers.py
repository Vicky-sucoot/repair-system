"""爬蟲解析測試：樣本取自各網站實際回應（已截短）。"""
from datetime import date

from analysis.crawlers import foreign, news, stocks

TWSE_PAYLOAD = {
    "stat": "OK", "date": "20261116", "title": "115年11月16日 外資及陸資買賣超彙總表",
    "fields": ["", "證券代號", "證券名稱", "買進股數", "賣出股數", "買賣超股數", "買進股數", "賣出股數", "買賣超股數", "買進股數", "賣出股數", "買賣超股數"],
    "data": [
        [" ", "9904  ", "寶成            ", "31,516,169", "6,409,200", "25,106,969", "0", "0", "0", "31,516,169", "6,409,200", "25,106,969"],
        [" ", "2330  ", "台積電          ", "10,000,000", "30,000,000", "-20,000,000", "1,000", "0", "1,000", "10,001,000", "30,000,000", "-19,999,000"],
    ],
}
TPEX_PAYLOAD = {"tables": [{
    "title": "外資及陸資買賣超彙總表", "date": "115/11/16",
    "data": [["1", "1815", "富喬", "37,748", "31,603", "6,145", "0", "0", "0", "37,748", "31,603", "6,145"]],
}]}


def test_parse_twse_uses_total_columns_and_strips_spaces():
    rows = foreign.parse_twse(TWSE_PAYLOAD, date(2026, 11, 16))
    assert rows[0] == {"date": "2026-11-16", "market": "TWSE", "code": "9904", "name": "寶成",
                       "buy": 31516169, "sell": 6409200, "net": 25106969}
    assert rows[1]["net"] == -19999000  # 含外資自營商的合計欄


def test_parse_twse_no_data():
    assert foreign.parse_twse({"stat": "很抱歉，沒有符合條件的資料!"}, date(2026, 11, 15)) == []


def test_parse_tpex_converts_lots_to_shares():
    rows = foreign.parse_tpex(TPEX_PAYLOAD, date(2026, 11, 16))
    assert rows == [{"date": "2026-11-16", "market": "TPEx", "code": "1815", "name": "富喬",
                     "buy": 37748000, "sell": 31603000, "net": 6145000}]


def test_roc_date():
    assert foreign.roc_date(date(2026, 11, 6)) == "115/11/06"


def test_parse_stock_list_tolerates_field_names():
    twse = [{"Date": "1151116", "Code": "2330", "Name": "台積電", "ClosingPrice": "1,450.00", "Change": "-25.0000"}]
    tpex = [{"SecuritiesCompanyCode": "1815", "CompanyName": "富喬", "Close": "55.3"}, {"Code": "", "Name": "x"}]
    assert stocks.parse_stock_list(twse, "TWSE") == [{"code": "2330", "name": "台積電", "market": "TWSE", "close": 1450.0,
                                                       "change": -25.0, "date": "2026-11-16"}]
    assert stocks.parse_stock_list(tpex, "TPEx") == [{"code": "1815", "name": "富喬", "market": "TPEx", "close": 55.3,
                                                       "change": None, "date": None}]


UDN_RSS = """<?xml version="1.0" encoding="UTF-8" ?><rss version="2.0"><channel><title><![CDATA[經濟日報]]></title>
<item><title><![CDATA[台股今日陷40,000點保衛戰 今年以來掛牌的主動式ETF破發率達70%]]></title>
<link>https://money.udn.com/money/story/5607/9883591</link><pubDate>Tue, 17 Nov 2026 11:42:51 +0800</pubDate>
<description><![CDATA[台股今天繼續上演40,000點關卡保衛戰，<b>投資人</b>一片血流成河。]]></description>
<guid isPermaLink='false'>https://money.udn.com/money/story/5607/9883591</guid></item></channel></rss>"""

CTEE_RSS = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>工商時報 證券</title>
<item><title>明年Q1 CES、MWC及普發現金等利多題材匯集 台股上攻有底氣</title>
<link>https://www.ctee.com.tw/news/20261117701036-430201</link>
<description>台新投信表示，近五次國安基金護盤期間，台股漲幅皆高達兩位數以上。</description>
<pubDate>2026-11-17T12:16:27</pubDate><guid>20261117701036</guid></item></channel></rss>"""


def test_parse_rss_udn_and_ctee():
    udn = news.parse_rss(UDN_RSS, "udn")[0]
    assert udn["source"] == "經濟日報"
    assert udn["published_at"] == "2026-11-17T11:42:51+08:00"
    assert "<b>" not in udn["summary"] and "投資人" in udn["summary"]
    ctee = news.parse_rss(CTEE_RSS, "ctee")[0]
    assert ctee["id"] == "ctee:20261117701036"
    assert ctee["published_at"] == "2026-11-17T12:16:27+08:00"  # 無時區視為台灣時間


def test_parse_cnyes_unescapes_html_and_builds_url():
    payload = {"items": {"data": [{
        "newsId": 6200001, "title": "台積電法說會 &amp; 展望", "publishAt": 1794890000,
        "content": "&lt;p&gt;為協助台灣企業&lt;/p&gt;", "summary": "",
        "market": [{"code": "TWS:2330:STOCK", "name": "台積電"}],
    }]}}
    item = news.parse_cnyes(payload)[0]
    assert item["url"] == "https://news.cnyes.com/news/id/6200001"
    assert item["title"] == "台積電法說會 & 展望"
    assert item["summary"] == "為協助台灣企業"
    assert item["tags"] == ["2330"]
    assert item["published_at"].endswith("+08:00")


def test_clean_text_truncates():
    assert len(news.clean_text("字" * 500)) == news.SUMMARY_CHARS


def test_dedupe_ticks_keeps_latest_index_flash():
    items = [
        {"source": "鉅亨網", "title": "盤中速報 - 櫃買市場加權指數下跌-8.89點至310.23點，跌幅2.79%", "published_at": "2026-11-17T11:59:35+08:00"},
        {"source": "鉅亨網", "title": "盤中速報 - 櫃買市場加權指數下跌-12.95點至306.17點，跌幅4.06%", "published_at": "2026-11-17T12:11:05+08:00"},
        {"source": "鉅亨網", "title": "盤中速報 - 集中市場加權指數下跌-851.72點至40188.36點，跌幅2.08%", "published_at": "2026-11-17T12:15:06+08:00"},
        {"source": "鉅亨網", "title": "營收速報 - 台產(2832)10月營收年增56%", "published_at": "2026-11-17T11:52:55+08:00"},
    ]
    kept = news.dedupe_ticks(items)
    assert len(kept) == 3
    assert any("306.17" in i["title"] for i in kept) and not any("310.23" in i["title"] for i in kept)


def test_export_quotes_keeps_market_dates(tmp_path):
    import json
    from analysis import pipeline
    pipeline.export_quotes(tmp_path / "q.json", [
        {"code": "2330", "name": "台積電", "market": "TWSE", "close": 2215.0, "change": -135.0, "date": "2026-11-16"},
        {"code": "1815", "name": "富喬", "market": "TPEx", "close": 118.0, "change": -13.0, "date": "2026-11-17"},
        {"code": "9999", "name": "無成交", "market": "TPEx", "close": None, "change": None, "date": "2026-11-17"}])
    q = json.loads((tmp_path / "q.json").read_text(encoding="utf-8"))
    assert q["dates"] == {"TWSE": "2026-11-16", "TPEx": "2026-11-17"}
    assert q["quotes"] == {"2330": ["台積電", "TWSE", 2215.0, -135.0], "1815": ["富喬", "TPEx", 118.0, -13.0]}
