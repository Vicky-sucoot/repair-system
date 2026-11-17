"""每日資料流程：抓取外資買賣超與財經新聞 → 存入 SQLite → 分析 → 匯出 JSON 給網站。

執行：python -m analysis.pipeline [--days 10] [--skip-foreign] [--skip-news]
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

from . import db
from .config import DB_PATH, EXPORT_DIR, HISTORY_DAYS, NEWS_KEEP_DAYS, TRUST_BIG_TRADE_VALUE
from .crawlers import foreign, global_quotes, news, stocks, trust
from .crawlers.news import TW
from .foreign_analysis import analyze, stock_flows
from . import recommend
from .insight import generate as generate_insight
from .sentiment import analyze_items, llm_available


def now_tw() -> datetime:
    return datetime.now(TW)


def collect_foreign(conn, days: int, today: date | None = None) -> list[str]:
    """往回補齊最近 days 個有資料的交易日（已存在的日期不重抓）。"""
    today = today or now_tw().date()
    found: list[str] = []
    day, tried = today, 0
    while len(found) < days and tried < days * 2 + 7:
        tried += 1
        if day.weekday() < 5:
            iso = day.isoformat()
            if not db.has_foreign(conn, iso, "TWSE"):
                try:
                    db.upsert_foreign(conn, foreign.fetch_twse(day))
                except Exception as error:
                    print(f"證交所 {iso} 下載失敗：{error}")
            if db.has_foreign(conn, iso, "TWSE"):
                found.append(iso)
                if not db.has_foreign(conn, iso, "TPEx"):
                    try:
                        db.upsert_foreign(conn, foreign.fetch_tpex(day))
                    except Exception as error:
                        print(f"櫃買中心 {iso} 下載失敗：{error}")
                # 投信買賣超（同一交易日）
                for market, fetcher in (("TWSE", trust.fetch_twse), ("TPEx", trust.fetch_tpex)):
                    if not db.has_foreign(conn, iso, market, table="trust_trades"):
                        try:
                            db.upsert_foreign(conn, fetcher(day), table="trust_trades")
                        except Exception as error:
                            print(f"投信 {market} {iso} 下載失敗：{error}")
        day -= timedelta(days=1)
    return sorted(found)


def stock_summary(items: list[dict]) -> list[dict]:
    """依個股彙整新聞情緒：利多／利空／中性則數與最新標題。"""
    agg: dict[str, dict] = defaultdict(lambda: {"bullish": 0, "bearish": 0, "neutral": 0, "headlines": []})
    for item in items:
        for s in item.get("stocks") or []:
            a = agg[s["code"]]
            a.update(code=s["code"], name=s["name"])
            key = {"利多": "bullish", "利空": "bearish"}.get(s.get("impact") or item["sentiment"], "neutral")
            a[key] += 1
            if len(a["headlines"]) < 3:
                a["headlines"].append({"title": item["title"], "url": item["url"], "sentiment": item["sentiment"]})
    rows = [dict(v, total=v["bullish"] + v["bearish"] + v["neutral"], net=v["bullish"] - v["bearish"]) for v in agg.values()]
    return sorted(rows, key=lambda r: (r["total"], abs(r["net"])), reverse=True)


def import_news_json(conn, path: Path) -> None:
    """載入上次匯出的新聞與分析結果，避免重複分析（GitHub Actions 每次都是全新環境）。"""
    if not path.exists():
        return
    try:
        items = json.loads(path.read_text(encoding="utf-8")).get("items") or []
    except (OSError, ValueError):
        return
    db.upsert_news(conn, items)
    for item in items:
        if item.get("sentiment"):
            db.save_analysis(conn, item["id"], item)


def export_quotes(path: Path, stock_list: list[dict], global_list: list[dict] | None = None) -> None:
    """
    網站自選清單用的資料：{代號: [名稱, 市場, 收盤價, 漲跌]}，格式精簡以縮小檔案。
    市場：TWSE 上市、TPEx 上櫃（含最新收盤價，兩市場日期可能不同，分別記錄）；
    US 美股、JP 日股只有代號與名稱，價格為 null（報價來源禁止程式抓取，網頁改連到 Yahoo 頁面）。
    某市場這次沒抓到時，沿用上一版檔案中的資料。
    """
    previous = {}
    if path.exists():
        try:
            previous = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            previous = {}
    rows = [s for s in stock_list if s.get("close")] + list(global_list or [])
    quotes = {s["code"]: [s["name"], s["market"], s.get("close"), s.get("change")] for s in rows}
    dates: dict[str, str] = {}
    for s in rows:
        if s.get("date"):
            dates[s["market"]] = max(dates.get(s["market"], ""), s["date"])
    aliases = {s["code"]: s["alias"] for s in (global_list or []) if s.get("alias") and s["code"] in quotes}
    for market in ("TWSE", "TPEx", "US", "JP"):
        if not any(q[1] == market for q in quotes.values()):
            old = {c: q for c, q in (previous.get("quotes") or {}).items() if q[1] == market}
            quotes.update(old)
            if old and (previous.get("dates") or {}).get(market):
                dates[market] = previous["dates"][market]
            aliases.update({c: a for c, a in (previous.get("aliases") or {}).items() if c in old})
    export_json(path, {"updatedAt": now_tw().isoformat(timespec="seconds"), "dates": dates,
                       "source": "臺灣證券交易所、證券櫃檯買賣中心；美股、日股代號來自維基百科 S&P 500 與日經 225 成分股",
                       "quotes": quotes, "aliases": aliases})


def export_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def run(days: int = HISTORY_DAYS, *, skip_foreign: bool = False, skip_news: bool = False,
        db_path: Path = DB_PATH, export_dir: Path = EXPORT_DIR) -> dict:
    conn = db.connect(db_path)
    report: dict = {"errors": []}
    stock_list = stocks.fetch_stock_list()
    if stock_list:
        db.upsert_stocks(conn, stock_list)
    try:
        global_list = global_quotes.fetch_all()
    except Exception as error:  # 美日股失敗不影響台股與其他流程
        global_list = []
        report["errors"].append(f"美股、日股代號清單下載失敗：{error}")
    if stock_list or global_list:
        export_quotes(export_dir / "quotes.json", stock_list, global_list)
        report["quotes"] = len(stock_list) + len(global_list)
    smap = db.stock_map(conn)

    foreign_result = None
    if not skip_foreign:
        dates = collect_foreign(conn, days)
        if dates:
            rows = [r for r in db.foreign_rows(conn, since=dates[0]) if r["date"] in set(dates)]
            prices = {code: s["close"] for code, s in smap.items()}
            foreign_result = analyze(rows, prices)
            _, flows = stock_flows(rows, prices)
            report["foreign_date"] = foreign_result["date"]
            # 投信動向：與外資相同的篩選方式，門檻較低
            trust_rows = [r for r in db.foreign_rows(conn, since=dates[0], table="trust_trades") if r["date"] in set(dates)]
            if trust_rows:
                trust_result = analyze(trust_rows, prices, big_value=TRUST_BIG_TRADE_VALUE)
                export_json(export_dir / "trust.json", {"updatedAt": now_tw().isoformat(timespec="seconds"),
                                                        "source": "臺灣證券交易所、證券櫃檯買賣中心（投信買賣超彙總表）",
                                                        **trust_result})
                report["trust_date"] = trust_result["date"]
        else:
            report["errors"].append("沒有取得任何外資買賣超資料")

    news_stocks, news_counts, analyzed = [], {}, None

    if not skip_news:
        news_path = export_dir / "news.json"
        import_news_json(conn, news_path)
        items, errors = news.fetch_all()
        report["errors"] += errors
        db.upsert_news(conn, items)
        cutoff = (now_tw() - timedelta(days=NEWS_KEEP_DAYS)).isoformat(timespec="seconds")
        db.delete_news_before(conn, cutoff)
        pending = db.news_items(conn, analyzed=False)
        if llm_available():
            # 改用 Claude 後，先前以關鍵字分析的新聞也重新分析
            pending += [i for i in db.news_items(conn, since=cutoff, analyzed=True) if i.get("analyzer") == "lexicon"]
        # 名稱比對用：股票清單＋外資表中出現過的名稱
        names = dict(smap)
        for r in db.foreign_rows(conn):
            names.setdefault(r["code"], {"code": r["code"], "name": r["name"], "market": r["market"], "close": None})
        for item, result in zip(pending, analyze_items(pending, names)):
            db.save_analysis(conn, item["id"], result)
        analyzed = news.dedupe_ticks(db.news_items(conn, since=cutoff, analyzed=True))
        analyzed.sort(key=lambda i: i.get("published_at") or "", reverse=True)
        counts = {k: sum(1 for i in analyzed if i["sentiment"] == k) for k in ("利多", "利空", "中性")}
        news_stocks, news_counts = stock_summary(analyzed), counts
        export_json(news_path, {
            "updatedAt": now_tw().isoformat(timespec="seconds"),
            "sources": [s["name"] for s in news.SOURCES.values()],
            "analyzer": "llm" if any(str(i.get("analyzer", "")).startswith("llm") for i in analyzed) else "lexicon",
            "counts": counts, "stocks": stock_summary(analyzed)[:30],
            "items": [{k: i[k] for k in ("id", "source", "title", "url", "summary", "published_at", "tags", "sentiment",
                                         "score", "bullish_keywords", "bearish_keywords", "stocks", "reason", "analyzer")}
                      for i in analyzed],
        })
        report["news"] = len(analyzed)
        report["news_new"] = len(pending)

    if foreign_result:
        # 外資動向最後寫出，讓 Claude 解讀能同時參考新聞情緒
        insight = generate_insight(foreign_result, news_stocks, news_counts)
        export_json(export_dir / "foreign.json", {"updatedAt": now_tw().isoformat(timespec="seconds"),
                                                  "source": "臺灣證券交易所、證券櫃檯買賣中心",
                                                  **foreign_result, "insight": insight})
        report["insight"] = bool(insight)
        if analyzed is not None:
            # 綜合評分：外資買＋新聞利多 → 建議買入；外資賣＋新聞利空 → 建議賣出／避開
            rec = recommend.claude_reasons(recommend.build(flows, analyzed, now_tw().date()))
            export_json(export_dir / "recommend.json", {"updatedAt": now_tw().isoformat(timespec="seconds"),
                                                        "date": foreign_result["date"], **rec})
            report["recommend"] = {"buy": len(rec["buy"]), "sell": len(rec["sell"])}
    conn.close()
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="抓取外資買賣超與財經新聞並分析")
    parser.add_argument("--days", type=int, default=HISTORY_DAYS, help="回補的交易日數")
    parser.add_argument("--skip-foreign", action="store_true")
    parser.add_argument("--skip-news", action="store_true")
    args = parser.parse_args()
    report = run(args.days, skip_foreign=args.skip_foreign, skip_news=args.skip_news)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
