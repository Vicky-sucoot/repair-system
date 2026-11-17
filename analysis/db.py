"""SQLite 資料庫：外資買賣超、新聞與分析結果、股票清單。"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS foreign_trades (
    date TEXT NOT NULL, market TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL,
    buy INTEGER NOT NULL, sell INTEGER NOT NULL, net INTEGER NOT NULL,
    PRIMARY KEY (date, market, code)
);
CREATE INDEX IF NOT EXISTS idx_foreign_code ON foreign_trades (code, date);
CREATE TABLE IF NOT EXISTS stocks (
    code TEXT PRIMARY KEY, name TEXT NOT NULL, market TEXT NOT NULL, close REAL
);
CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    summary TEXT, published_at TEXT, tags TEXT NOT NULL DEFAULT '[]',
    sentiment TEXT, score REAL, bullish_keywords TEXT, bearish_keywords TEXT,
    stocks TEXT, reason TEXT, analyzer TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_news_published ON news (published_at);
CREATE TABLE IF NOT EXISTS prices (
    date TEXT NOT NULL, code TEXT NOT NULL, close REAL NOT NULL, PRIMARY KEY (date, code)
);
CREATE TABLE IF NOT EXISTS recommendations (
    date TEXT NOT NULL, side TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL,
    PRIMARY KEY (date, side, code)
);
"""

JSON_FIELDS = ("tags", "bullish_keywords", "bearish_keywords", "stocks")


def connect(path: Path | str = DB_PATH) -> sqlite3.Connection:
    path = Path(path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def upsert_foreign(conn: sqlite3.Connection, rows: list[dict]) -> int:
    conn.executemany(
        "INSERT OR REPLACE INTO foreign_trades (date, market, code, name, buy, sell, net) "
        "VALUES (:date, :market, :code, :name, :buy, :sell, :net)", rows)
    conn.commit()
    return len(rows)


def foreign_dates(conn: sqlite3.Connection) -> list[str]:
    return [r[0] for r in conn.execute("SELECT DISTINCT date FROM foreign_trades ORDER BY date")]


def has_foreign(conn: sqlite3.Connection, day: str, market: str) -> bool:
    return conn.execute("SELECT 1 FROM foreign_trades WHERE date=? AND market=? LIMIT 1", (day, market)).fetchone() is not None


def foreign_rows(conn: sqlite3.Connection, since: str | None = None) -> list[dict]:
    sql = "SELECT * FROM foreign_trades" + (" WHERE date >= ?" if since else "") + " ORDER BY date"
    return [dict(r) for r in conn.execute(sql, (since,) if since else ())]


def upsert_stocks(conn: sqlite3.Connection, stocks: list[dict]) -> None:
    conn.executemany("INSERT OR REPLACE INTO stocks (code, name, market, close) VALUES (:code, :name, :market, :close)", stocks)
    conn.commit()


def stock_map(conn: sqlite3.Connection) -> dict[str, dict]:
    return {r["code"]: dict(r) for r in conn.execute("SELECT * FROM stocks")}


def upsert_news(conn: sqlite3.Connection, items: list[dict]) -> None:
    """新增新聞；已存在且分析過的不覆蓋分析結果。"""
    for item in items:
        row = {k: item.get(k) for k in ("id", "source", "title", "url", "summary", "published_at")}
        row["tags"] = json.dumps(item.get("tags") or [], ensure_ascii=False)
        conn.execute(
            "INSERT INTO news (id, source, title, url, summary, published_at, tags) "
            "VALUES (:id, :source, :title, :url, :summary, :published_at, :tags) "
            "ON CONFLICT(id) DO UPDATE SET title=excluded.title, summary=excluded.summary", row)
    conn.commit()


def save_analysis(conn: sqlite3.Connection, news_id: str, result: dict) -> None:
    conn.execute(
        "UPDATE news SET sentiment=?, score=?, bullish_keywords=?, bearish_keywords=?, stocks=?, reason=?, analyzer=? WHERE id=?",
        (result["sentiment"], result["score"], json.dumps(result["bullish_keywords"], ensure_ascii=False),
         json.dumps(result["bearish_keywords"], ensure_ascii=False), json.dumps(result["stocks"], ensure_ascii=False),
         result.get("reason"), result["analyzer"], news_id))
    conn.commit()


def _decode(row: sqlite3.Row) -> dict:
    item = dict(row)
    for key in JSON_FIELDS:
        item[key] = json.loads(item[key]) if item.get(key) else []
    return item


def news_items(conn: sqlite3.Connection, since: str | None = None, analyzed: bool | None = None) -> list[dict]:
    clauses, params = [], []
    if since:
        clauses.append("published_at >= ?")
        params.append(since)
    if analyzed is True:
        clauses.append("sentiment IS NOT NULL")
    elif analyzed is False:
        clauses.append("sentiment IS NULL")
    sql = "SELECT * FROM news" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY published_at DESC"
    return [_decode(r) for r in conn.execute(sql, params)]


def delete_news_before(conn: sqlite3.Connection, cutoff: str) -> None:
    conn.execute("DELETE FROM news WHERE published_at < ?", (cutoff,))
    conn.commit()


def has_prices(conn: sqlite3.Connection, day: str) -> bool:
    return conn.execute("SELECT 1 FROM prices WHERE date=? LIMIT 1", (day,)).fetchone() is not None


def upsert_prices(conn: sqlite3.Connection, day: str, closes: dict[str, float]) -> None:
    conn.executemany("INSERT OR REPLACE INTO prices (date, code, close) VALUES (?, ?, ?)",
                     [(day, code, close) for code, close in closes.items()])
    conn.commit()


def price_table(conn: sqlite3.Connection, since: str | None = None) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    sql = "SELECT date, code, close FROM prices" + (" WHERE date >= ?" if since else "")
    for d, code, close in conn.execute(sql, (since,) if since else ()):
        out.setdefault(d, {})[code] = close
    return out


def save_recommendations(conn: sqlite3.Connection, day: str, picks: list[dict]) -> None:
    """同一個外資資料日期只保留最新一版名單。"""
    conn.execute("DELETE FROM recommendations WHERE date=?", (day,))
    conn.executemany("INSERT OR REPLACE INTO recommendations (date, side, code, name, score) VALUES (:date, :side, :code, :name, :score)",
                     [{**p, "date": day} for p in picks])
    conn.commit()


def recommendations(conn: sqlite3.Connection) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM recommendations ORDER BY date, side, score DESC")]
