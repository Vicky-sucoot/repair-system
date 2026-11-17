"""外資動向篩選：連續買超、單日大買／大賣。"""
from __future__ import annotations

from collections import defaultdict

from .config import BIG_TRADE_VALUE, STREAK_MIN_DAYS, TOP_N


def streak_length(nets: list[int]) -> int:
    """由最近一天往回數，連續買超（>0）幾天；最近一天不是買超則為 0。"""
    count = 0
    for net in reversed(nets):
        if net > 0:
            count += 1
        else:
            break
    return count


def analyze(rows: list[dict], prices: dict[str, float | None] | None = None, *,
            min_days: int = STREAK_MIN_DAYS, big_value: float = BIG_TRADE_VALUE, top_n: int = TOP_N) -> dict:
    """
    rows：多個交易日的外資買賣超（date, market, code, name, net…）。
    prices：最新收盤價，用來把股數換算成金額（新台幣）；沒有價格時金額為 None。
    """
    prices = prices or {}
    if not rows:
        return {"date": None, "dates": [], "streaks": [], "big_buys": [], "big_sells": []}
    dates = sorted({r["date"] for r in rows})
    latest = dates[-1]
    by_stock: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    for r in rows:
        by_stock[(r["market"], r["code"])][r["date"]] = r

    def enrich(r: dict, history: dict[str, dict]) -> dict:
        nets = [history[d]["net"] if d in history else 0 for d in dates]
        streak = streak_length(nets)
        price = prices.get(r["code"])
        value = r["net"] * price if price else None
        return {
            "code": r["code"], "name": r["name"], "market": r["market"],
            "net_shares": r["net"], "net_lots": round(r["net"] / 1000),
            "price": price, "net_value": round(value) if value is not None else None,
            "streak_days": streak,
            "streak_shares": sum(nets[len(nets) - streak:]) if streak else 0,
        }

    today = [enrich(h[latest], h) for h in by_stock.values() if latest in h]
    streaks = sorted((s for s in today if s["streak_days"] >= min_days),
                     key=lambda s: (s["streak_days"], s["net_value"] or s["net_shares"]), reverse=True)

    def size(s: dict) -> float:
        return s["net_value"] if s["net_value"] is not None else 0

    buys = sorted((s for s in today if s["net_shares"] > 0), key=lambda s: (size(s), s["net_shares"]), reverse=True)
    sells = sorted((s for s in today if s["net_shares"] < 0), key=lambda s: (size(s), s["net_shares"]))
    for s in buys + sells:
        s["is_big"] = s["net_value"] is not None and abs(s["net_value"]) >= big_value
    return {
        "date": latest, "dates": dates,
        "streak_min_days": min_days, "big_trade_value": big_value,
        "streaks": streaks[:top_n], "big_buys": buys[:top_n], "big_sells": sells[:top_n],
        "counts": {"stocks": len(today), "buy": len(buys), "sell": len(sells), "streaks": len(streaks),
                   "big_buy": sum(1 for s in buys if s["is_big"]), "big_sell": sum(1 for s in sells if s["is_big"])},
    }
