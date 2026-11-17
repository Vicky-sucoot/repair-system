"""財經新聞：鉅亨網（API）、經濟日報（RSS）、工商時報（RSS）。

只保存標題、連結、發布時間與 200 字以內摘要，不轉存全文；點連結回原網站閱讀。
回傳統一格式：{id, source, title, url, summary, published_at(ISO, 台灣時間), tags}
"""
from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from .. import http

TW = timezone(timedelta(hours=8))
SUMMARY_CHARS = 200

SOURCES = {
    "cnyes": {"name": "鉅亨網", "url": "https://api.cnyes.com/media/api/v1/newslist/category/tw_stock", "params": {"limit": 50}},
    "udn": {"name": "經濟日報", "url": "https://money.udn.com/rssfeed/news/1001/5590?ch=money"},
    "ctee": {"name": "工商時報", "url": "https://www.ctee.com.tw/rss_web/livenews/stock"},
}


def clean_text(value: str | None) -> str:
    """去除 HTML 標籤與多餘空白，並截成摘要長度。"""
    text = html.unescape(value or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:SUMMARY_CHARS]


def _iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TW)
    return dt.astimezone(TW).isoformat(timespec="seconds")


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    try:
        return _iso(parsedate_to_datetime(value))  # RFC 822（經濟日報）
    except (TypeError, ValueError):
        pass
    try:
        return _iso(datetime.fromisoformat(value))  # ISO（工商時報，未附時區＝台灣時間）
    except ValueError:
        return None


def parse_rss(xml_text: str, source: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for item in root.iter("item"):
        title = clean_text(item.findtext("title"))
        link = (item.findtext("link") or "").strip()
        if not title or not link:
            continue
        guid = (item.findtext("guid") or link).strip()
        items.append({
            "id": f"{source}:{guid}", "source": SOURCES[source]["name"], "title": title, "url": link,
            "summary": clean_text(item.findtext("description")),
            "published_at": parse_date(item.findtext("pubDate")), "tags": [],
        })
    return items


def parse_cnyes(payload: dict) -> list[dict]:
    data = ((payload or {}).get("items") or {}).get("data") or []
    items = []
    for row in data:
        news_id = row.get("newsId")
        title = clean_text(row.get("title"))
        if not news_id or not title:
            continue
        published = row.get("publishAt")
        tags = []
        # 鉅亨網會附上相關個股（格式不固定，容錯處理）
        for value in (row.get("market") or []) + (row.get("stock") or []):
            raw = value.get("code") if isinstance(value, dict) else value
            m = re.search(r"(?<![\dA-Z])(\d{4,6}[A-Z]?)(?![\d])", str(raw or ""))
            if m:  # 例如 "TWS:2330:STOCK" → 2330
                tags.append(m.group(1))
        items.append({
            "id": f"cnyes:{news_id}", "source": SOURCES["cnyes"]["name"], "title": title,
            "url": f"https://news.cnyes.com/news/id/{news_id}",
            "summary": clean_text(row.get("summary") or row.get("content")),
            "published_at": _iso(datetime.fromtimestamp(int(published), TW)) if published else None,
            "tags": sorted(set(tags)),
        })
    return items


def dedupe_ticks(items: list[dict]) -> list[dict]:
    """「盤中速報－加權指數下跌 xx 點」這類每隔幾分鐘重發的快訊，同一來源只保留最新一則。"""
    latest: dict[tuple[str, str], dict] = {}
    rest = []
    for item in items:
        if re.match(r"^(盤中速報|盤後速報|鉅亨速報)", item["title"]) and "指數" in item["title"]:
            key = (item["source"], re.sub(r"[\d.,%\-+－]+", "", item["title"]))
            if key not in latest or (item.get("published_at") or "") > (latest[key].get("published_at") or ""):
                latest[key] = item
        else:
            rest.append(item)
    return rest + list(latest.values())


def fetch_all() -> tuple[list[dict], list[str]]:
    """抓取所有來源；單一來源失敗不影響其他來源。回傳 (新聞, 錯誤訊息)。"""
    items, errors = [], []
    for key, cfg in SOURCES.items():
        try:
            resp = http.get(cfg["url"], params=cfg.get("params"), min_interval=1.0)
            items += parse_cnyes(resp.json()) if key == "cnyes" else parse_rss(resp.text, key)
        except Exception as error:
            errors.append(f"{cfg['name']}：{error}")
    return dedupe_ticks(items), errors
