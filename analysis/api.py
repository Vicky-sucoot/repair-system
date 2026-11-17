"""FastAPI 後端：查詢外資動向與新聞情緒。

啟動：uvicorn analysis.api:app --reload  →  http://127.0.0.1:8000/docs
"""
from __future__ import annotations

from datetime import timedelta
from typing import Literal

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query

from . import db, pipeline
from .crawlers.news import dedupe_ticks
from .config import BIG_TRADE_VALUE, DB_PATH, NEWS_KEEP_DAYS, STREAK_MIN_DAYS, TOP_N
from .foreign_analysis import analyze, stock_flows
from . import backtest, recommend

app = FastAPI(title="台股外資動向與新聞情緒 API", version="1.0.0")


def _conn():
    return db.connect(DB_PATH)


@app.get("/api/health")
def health() -> dict:
    conn = _conn()
    dates = db.foreign_dates(conn)
    news_count = conn.execute("SELECT COUNT(*) FROM news").fetchone()[0]
    conn.close()
    return {"status": "ok", "foreign_dates": dates[-10:], "news": news_count}


@app.get("/api/foreign")
def foreign_summary(min_days: int = Query(STREAK_MIN_DAYS, ge=1, le=30),
                    big_value: float = Query(BIG_TRADE_VALUE, ge=0),
                    top_n: int = Query(TOP_N, ge=1, le=200)) -> dict:
    """最新交易日的外資連續買超、單日大買與大賣。"""
    conn = _conn()
    dates = db.foreign_dates(conn)[-30:]
    rows = db.foreign_rows(conn, since=dates[0]) if dates else []
    prices = {code: s["close"] for code, s in db.stock_map(conn).items()}
    conn.close()
    return analyze(rows, prices, min_days=min_days, big_value=big_value, top_n=top_n)


@app.get("/api/foreign/{code}")
def foreign_history(code: str) -> dict:
    """單一個股的外資買賣超歷史（股數）。"""
    conn = _conn()
    rows = [dict(r) for r in conn.execute("SELECT * FROM foreign_trades WHERE code=? ORDER BY date", (code,))]
    conn.close()
    if not rows:
        raise HTTPException(404, f"查無 {code} 的外資資料")
    return {"code": code, "name": rows[-1]["name"], "market": rows[-1]["market"], "history": rows}


@app.get("/api/news")
def news_list(sentiment: Literal["利多", "利空", "中性"] | None = None, stock: str | None = None,
              days: int = Query(NEWS_KEEP_DAYS, ge=1, le=30), limit: int = Query(100, ge=1, le=500)) -> dict:
    """近期新聞與情緒，可依情緒或個股代號篩選。"""
    conn = _conn()
    since = (pipeline.now_tw() - timedelta(days=days)).isoformat(timespec="seconds")
    items = dedupe_ticks(db.news_items(conn, since=since, analyzed=True))
    items.sort(key=lambda i: i.get("published_at") or "", reverse=True)
    conn.close()
    if sentiment:
        items = [i for i in items if i["sentiment"] == sentiment]
    if stock:
        items = [i for i in items if any(s["code"] == stock for s in i["stocks"])]
    return {"count": len(items), "items": items[:limit]}


@app.get("/api/news/stocks")
def news_stocks(days: int = Query(NEWS_KEEP_DAYS, ge=1, le=30)) -> list[dict]:
    """依個股彙整的利多／利空新聞則數。"""
    conn = _conn()
    since = (pipeline.now_tw() - timedelta(days=days)).isoformat(timespec="seconds")
    items = dedupe_ticks(db.news_items(conn, since=since, analyzed=True))
    conn.close()
    return pipeline.stock_summary(items)


@app.get("/api/recommendations")
def recommendations(top_n: int = Query(10, ge=1, le=50), big_value: float = Query(BIG_TRADE_VALUE, ge=0)) -> dict:
    """今日觀察名單：建議買入（外資買＋新聞利多）與建議賣出／避開（外資賣＋新聞利空），附評分與理由。"""
    conn = _conn()
    dates = db.foreign_dates(conn)[-30:]
    rows = db.foreign_rows(conn, since=dates[0]) if dates else []
    prices = {code: s["close"] for code, s in db.stock_map(conn).items()}
    since = (pipeline.now_tw() - timedelta(days=NEWS_KEEP_DAYS)).isoformat(timespec="seconds")
    items = dedupe_ticks(db.news_items(conn, since=since, analyzed=True))
    conn.close()
    _, flows = stock_flows(rows, prices)
    result = recommend.build(flows, items, pipeline.now_tw().date(), top_n=top_n, big_value=big_value)
    return {"date": dates[-1] if dates else None, **result}


@app.get("/api/backtest")
def backtest_summary() -> dict:
    """回測：外資策略歷史回測與觀察名單實際追蹤的 1／5／20 日報酬、勝率與超額報酬。"""
    conn = _conn()
    table = db.price_table(conn)
    book = backtest.PriceBook(table)
    result = {
        "horizons": list(backtest.HORIZONS), "price_days": len(book.dates),
        "foreign_only": backtest.evaluate(backtest.foreign_only_picks(db.foreign_rows(conn), table), book),
        "combined": backtest.evaluate(db.recommendations(conn), book),
    }
    conn.close()
    return result


@app.post("/api/refresh", status_code=202)
def refresh(background: BackgroundTasks, skip_foreign: bool = False, skip_news: bool = False) -> dict:
    """在背景重新抓取並分析（僅供本機使用，正式部署請加上驗證）。"""
    background.add_task(pipeline.run, skip_foreign=skip_foreign, skip_news=skip_news)
    return {"status": "started"}
