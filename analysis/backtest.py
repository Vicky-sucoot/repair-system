"""回測：驗證觀察名單之後的實際報酬。

兩種策略：
- foreign_only（歷史回測）：只用外資分數（與觀察名單相同公式），在過去每個交易日選出前 N 檔買超與賣超。
  新聞來源沒有歷史資料，所以歷史回測不含新聞面。
- combined（實際追蹤）：每天實際產生的觀察名單（外資＋新聞），自開始保存起逐日累積。

報酬計算：
- 進場價＝名單日期「下一個交易日」的收盤價（名單在收盤後或隔天早上才產生）。
- 持有 1／5／20 個交易日後的收盤價計算報酬，不含手續費、證交稅與股利。
- 基準＝同期間全市場個股（排除 ETF）等權平均報酬；超額報酬＝個股報酬－基準。
- 建議買入以「報酬 > 0」為勝；建議賣出／避開以「報酬 < 0」（避開下跌）為勝。
"""
from __future__ import annotations

import statistics
from collections import defaultdict

from .config import BIG_TRADE_VALUE
from .foreign_analysis import stock_flows
from .recommend import foreign_score, is_etf

HORIZONS = (1, 5, 20)
LOOKBACK_DAYS = 10      # 計算連續買賣超天數用的回看交易日數
MAX_ABS_RETURN = 1.5    # 超過 ±150% 視為除權、減資等資料異常，不納入


class PriceBook:
    """依日期查收盤價。prices：{日期: {代號: 收盤價}}。"""

    def __init__(self, prices: dict[str, dict[str, float]]):
        self.prices = prices
        self.dates = sorted(d for d, p in prices.items() if p)
        self._market: dict[tuple[str, str], float | None] = {}

    def entry_index(self, pick_date: str) -> int | None:
        """名單日期之後第一個交易日的索引。"""
        for i, d in enumerate(self.dates):
            if d > pick_date:
                return i
        return None

    def ret(self, code: str, start: str, end: str) -> float | None:
        a, b = self.prices.get(start, {}).get(code), self.prices.get(end, {}).get(code)
        if not a or not b:
            return None
        r = b / a - 1
        return r if abs(r) <= MAX_ABS_RETURN else None

    def market(self, start: str, end: str) -> float | None:
        key = (start, end)
        if key not in self._market:
            rets = [r for code in self.prices.get(start, {}) if not is_etf(code)
                    if (r := self.ret(code, start, end)) is not None]
            self._market[key] = statistics.fmean(rets) if rets else None
        return self._market[key]

    def forward(self, pick_date: str, code: str, horizons=HORIZONS) -> dict:
        """回傳 {進場日, h: {return, excess, exit_date}}；資料不足的持有期為 None。"""
        i = self.entry_index(pick_date)
        out = {"entry_date": self.dates[i] if i is not None else None}
        for h in horizons:
            if i is None or i + h >= len(self.dates):
                out[h] = None
                continue
            start, end = self.dates[i], self.dates[i + h]
            r = self.ret(code, start, end)
            m = self.market(start, end)
            out[h] = None if r is None else {"return": r, "excess": None if m is None else r - m, "exit_date": end}
        return out


def foreign_only_picks(foreign_rows: list[dict], prices: dict[str, dict[str, float]], *, top_n: int = 10,
                       min_history: int = 3, big_value: float = BIG_TRADE_VALUE) -> list[dict]:
    """在每個有外資資料的交易日，以當日收盤價換算金額，用外資分數選出買超前 N 與賣超前 N。"""
    by_date: dict[str, list[dict]] = defaultdict(list)
    for r in foreign_rows:
        by_date[r["date"]].append(r)
    dates = sorted(by_date)
    picks = []
    for i, day in enumerate(dates):
        if i + 1 < min_history:
            continue
        window = [r for d in dates[max(0, i + 1 - LOOKBACK_DAYS):i + 1] for r in by_date[d]]
        _, flows = stock_flows(window, prices.get(day, {}))
        scored = []
        for f in flows:
            if is_etf(f["code"]) or f.get("net_value") is None:
                continue
            scored.append((foreign_score(f, big_value), abs(f["net_value"]), f))
        buys = sorted((s for s in scored if s[0] > 0), key=lambda s: (-s[0], -s[1]))[:top_n]
        sells = sorted((s for s in scored if s[0] < 0), key=lambda s: (s[0], -s[1]))[:top_n]
        for side, rows in (("buy", buys), ("sell", sells)):
            for score, _, f in rows:
                picks.append({"date": day, "side": side, "code": f["code"], "name": f["name"], "score": round(score * 100)})
    return picks


def evaluate(picks: list[dict], book: PriceBook, horizons=HORIZONS, recent: int = 20) -> dict:
    """彙整每個方向、每個持有期的筆數、平均／中位數報酬、勝率與平均超額報酬。"""
    stats: dict = {}
    details = []
    for p in picks:
        fwd = book.forward(p["date"], p["code"], horizons)
        details.append({**p, "entry_date": fwd["entry_date"],
                        **{f"r{h}": round(fwd[h]["return"], 4) if fwd[h] else None for h in horizons}})
        for h in horizons:
            if fwd[h] is None:
                continue
            bucket = stats.setdefault(p["side"], {}).setdefault(str(h), {"returns": [], "excess": []})
            bucket["returns"].append(fwd[h]["return"])
            if fwd[h]["excess"] is not None:
                bucket["excess"].append(fwd[h]["excess"])
    summary: dict = {}
    for side in ("buy", "sell"):
        summary[side] = {}
        for h in horizons:
            b = stats.get(side, {}).get(str(h))
            if not b or not b["returns"]:
                summary[side][str(h)] = {"n": 0}
                continue
            rets = b["returns"]
            wins = sum(1 for r in rets if (r > 0 if side == "buy" else r < 0))
            summary[side][str(h)] = {
                "n": len(rets),
                "avg_return": round(statistics.fmean(rets), 4),
                "median_return": round(statistics.median(rets), 4),
                "hit_rate": round(wins / len(rets), 4),
                "avg_excess": round(statistics.fmean(b["excess"]), 4) if b["excess"] else None,
            }
    dates = sorted({p["date"] for p in picks})
    details.sort(key=lambda d: (d["side"], -abs(d["score"])))
    details.sort(key=lambda d: d["date"], reverse=True)  # 最新日期在前，同日依方向與分數排序
    return {"summary": summary, "days": len(dates), "first_date": dates[0] if dates else None,
            "last_date": dates[-1] if dates else None, "picks": len(picks), "recent": details[:recent]}
