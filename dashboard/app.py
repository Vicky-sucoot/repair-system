"""Streamlit 儀表板：外資動向與財經新聞情緒。

執行：streamlit run dashboard/app.py
資料來源：本機 SQLite（data/market.db）；尚未執行過爬蟲時，改讀網站用的 data/foreign.json、data/news.json。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pandas as pd
import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from analysis import db, pipeline  # noqa: E402
from analysis.config import DB_PATH, EXPORT_DIR, STREAK_MIN_DAYS  # noqa: E402
from analysis.foreign_analysis import analyze  # noqa: E402

st.set_page_config(page_title="外資動向與新聞情緒", page_icon="📈", layout="wide")
st.title("台股外資動向與新聞情緒")


@st.cache_data(ttl=600)
def load_foreign(min_days: int, big_value: float) -> dict:
    if DB_PATH.exists():
        conn = db.connect(DB_PATH)
        dates = db.foreign_dates(conn)[-30:]
        if dates:
            rows = db.foreign_rows(conn, since=dates[0])
            prices = {c: s["close"] for c, s in db.stock_map(conn).items()}
            conn.close()
            return analyze(rows, prices, min_days=min_days, big_value=big_value, top_n=100)
        conn.close()
    path = EXPORT_DIR / "foreign.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


@st.cache_data(ttl=600)
def load_news() -> dict:
    if DB_PATH.exists():
        conn = db.connect(DB_PATH)
        items = db.news_items(conn, analyzed=True)
        conn.close()
        if items:
            return {"items": items, "stocks": pipeline.stock_summary(items)}
    path = EXPORT_DIR / "news.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


with st.sidebar:
    st.header("設定")
    min_days = st.slider("連續買超至少幾天", 2, 10, STREAK_MIN_DAYS)
    big_value_e = st.number_input("單日大買／大賣門檻（億元）", 0.5, 100.0, 5.0, 0.5)
    if st.button("立即重新抓取並分析", type="primary"):
        with st.spinner("抓取中（證交所有頻率限制，約需 1–2 分鐘）…"):
            report = pipeline.run()
        st.cache_data.clear()
        st.success(f"完成：外資資料 {report.get('foreign_date')}，新聞 {report.get('news', 0)} 則")
        for error in report.get("errors", []):
            st.warning(error)
    st.caption("資料：臺灣證券交易所、證券櫃檯買賣中心、鉅亨網、經濟日報、工商時報。僅供參考，不構成投資建議。")

foreign_tab, news_tab = st.tabs(["外資動向", "新聞情緒"])


def stock_table(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df["net_value_e"] = (df["net_value"].astype(float) / 1e8).round(2)
    return df.rename(columns={"code": "代號", "name": "名稱", "market": "市場", "net_lots": "買賣超(張)",
                              "net_value_e": "金額(億)", "streak_days": "連買天數", "price": "收盤價"})[
        ["代號", "名稱", "市場", "買賣超(張)", "金額(億)", "連買天數", "收盤價"]]


with foreign_tab:
    data = load_foreign(min_days, big_value_e * 1e8)
    if not data.get("date"):
        st.info("尚無外資資料，請按左側「立即重新抓取並分析」。")
    else:
        c = data.get("counts", {})
        st.subheader(f"{data['date']} 外資及陸資買賣超")
        cols = st.columns(4)
        cols[0].metric("買超家數", c.get("buy", 0))
        cols[1].metric("賣超家數", c.get("sell", 0))
        cols[2].metric(f"連續買超 ≥{data.get('streak_min_days', min_days)} 天", c.get("streaks", 0))
        cols[3].metric("單日大買／大賣", f"{c.get('big_buy', 0)} / {c.get('big_sell', 0)}")
        st.markdown("#### 連續買超")
        st.dataframe(stock_table(data["streaks"]), hide_index=True, use_container_width=True)
        left, right = st.columns(2)
        left.markdown("#### 單日大買（依金額）")
        left.dataframe(stock_table(data["big_buys"]), hide_index=True, use_container_width=True)
        right.markdown("#### 單日大賣（依金額）")
        right.dataframe(stock_table(data["big_sells"]), hide_index=True, use_container_width=True)

with news_tab:
    data = load_news()
    items = data.get("items") or []
    if not items:
        st.info("尚無新聞資料，請按左側「立即重新抓取並分析」。")
    else:
        choice = st.radio("篩選", ["全部", "利多", "利空", "中性"], horizontal=True)
        counts = {k: sum(1 for i in items if i["sentiment"] == k) for k in ("利多", "利空", "中性")}
        cols = st.columns(3)
        for col, (k, v) in zip(cols, counts.items()):
            col.metric(k, v)
        st.markdown("#### 相關個股")
        stocks_df = pd.DataFrame(data.get("stocks") or [])
        if not stocks_df.empty:
            st.dataframe(stocks_df.rename(columns={"code": "代號", "name": "名稱", "bullish": "利多", "bearish": "利空",
                                                   "neutral": "中性", "total": "則數"})[["代號", "名稱", "利多", "利空", "中性", "則數"]],
                         hide_index=True, use_container_width=True)
        st.markdown("#### 新聞")
        for item in items:
            if choice != "全部" and item["sentiment"] != choice:
                continue
            badge = {"利多": "🟥 利多", "利空": "🟩 利空"}.get(item["sentiment"], "⬜ 中性")
            # 標題來自外部網站：跳脫 Markdown 符號，且不允許 HTML
            title = re.sub(r"([\\`*_\[\]()<>#|])", r"\\\1", item["title"])
            url = item["url"] if str(item["url"]).startswith("https://") else ""
            st.markdown(f"**{badge}** [{title}]({url})" if url else f"**{badge}** {title}")
            details = [f"{item['source']}・{(item.get('published_at') or '')[:16].replace('T', ' ')}"]
            if item.get("bullish_keywords"):
                details.append("利多詞：" + "、".join(item["bullish_keywords"]))
            if item.get("bearish_keywords"):
                details.append("利空詞：" + "、".join(item["bearish_keywords"]))
            if item.get("stocks"):
                details.append("個股：" + "、".join(f"{s['name']}({s['code']})" for s in item["stocks"]))
            if item.get("reason"):
                details.append(item["reason"])
            if details:
                st.caption("｜".join(details))
