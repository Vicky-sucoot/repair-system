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
from .config import BACKTEST_DAYS, DB_PATH, EXPORT_DIR, HISTORY_DAYS, NEWS_KEEP_DAYS
from .crawlers import foreign, news, prices, stocks
from .crawlers.news import TW
from .foreign_analysis import analyze, stock_flows
from . import backtest, recommend
from .insight import generate as generate_insight
from .sentiment import analyze_items, llm_available


def now_tw() -> datetime:
    return datetime.now(TW)


def collect_foreign(conn, days: int, today: date | None = None, with_prices: bool = True) -> list[str]:
    """往回補齊最近 days 個有資料的交易日的外資買賣超與收盤價（已存在的日期不重抓）。"""
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
                if with_prices and not db.has_prices(conn, iso):
                    try:
                        db.upsert_prices(conn, iso, prices.fetch_closes(day))
                    except Exception as error:
                        print(f"{iso} 收盤價下載失敗：{error}")
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


def export_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def history_path(export_dir: Path) -> Path:
    return export_dir / "recommend_history.json"


def import_history(conn, export_dir: Path) -> None:
    """載入已提交的觀察名單歷史（GitHub Actions 的資料庫快取可能過期，名單歷史以 JSON 保存在儲存庫）。"""
    path = history_path(export_dir)
    if not path.exists():
        return
    try:
        picks = json.loads(path.read_text(encoding="utf-8")).get("picks") or []
    except (OSError, ValueError):
        return
    by_date: dict[str, list[dict]] = defaultdict(list)
    for p in picks:
        by_date[p["date"]].append(p)
    for day, rows in by_date.items():
        db.save_recommendations(conn, day, rows)


def run_backtest(conn, export_dir: Path) -> dict:
    table = db.price_table(conn)
    book = backtest.PriceBook(table)
    history = db.recommendations(conn)
    result = {
        "updatedAt": now_tw().isoformat(timespec="seconds"),
        "horizons": list(backtest.HORIZONS),
        "price_days": len(book.dates),
        "price_range": [book.dates[0], book.dates[-1]] if book.dates else None,
        "foreign_only": backtest.evaluate(backtest.foreign_only_picks(db.foreign_rows(conn), table), book),
        "combined": backtest.evaluate(history, book),
        "notes": backtest.__doc__.strip(),
    }
    export_json(export_dir / "backtest.json", result)
    export_json(history_path(export_dir), {"updatedAt": result["updatedAt"], "picks": history})
    return result


def run(days: int = HISTORY_DAYS, *, skip_foreign: bool = False, skip_news: bool = False,
        db_path: Path = DB_PATH, export_dir: Path = EXPORT_DIR, backtest_days: int | None = None) -> dict:
    backtest_days = BACKTEST_DAYS if backtest_days is None else backtest_days
    conn = db.connect(db_path)
    import_history(conn, export_dir)
    report: dict = {"errors": []}
    stock_list = stocks.fetch_stock_list()
    if stock_list:
        db.upsert_stocks(conn, stock_list)
    smap = db.stock_map(conn)

    foreign_result = None
    if not skip_foreign:
        dates = collect_foreign(conn, max(days, backtest_days))[-days:]
        if dates:
            rows = [r for r in db.foreign_rows(conn, since=dates[0]) if r["date"] in set(dates)]
            prices = {code: s["close"] for code, s in smap.items()}
            foreign_result = analyze(rows, prices)
            _, flows = stock_flows(rows, prices)
            report["foreign_date"] = foreign_result["date"]
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
            db.save_recommendations(conn, foreign_result["date"],
                                    [{"side": side, "code": c["code"], "name": c["name"], "score": c["score"]}
                                     for side in ("buy", "sell") for c in rec[side]])
        bt = run_backtest(conn, export_dir)
        report["backtest"] = {k: bt[k]["picks"] for k in ("foreign_only", "combined")}
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
