"""共用設定：資料庫路徑、匯出路徑與篩選門檻（可用環境變數覆寫）。"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("MARKET_DB", ROOT / "data" / "market.db"))
EXPORT_DIR = Path(os.environ.get("MARKET_EXPORT_DIR", ROOT / "data"))

# 外資篩選
STREAK_MIN_DAYS = int(os.environ.get("STREAK_MIN_DAYS", "3"))      # 連續買超至少幾天
BIG_TRADE_VALUE = float(os.environ.get("BIG_TRADE_VALUE", "500000000"))  # 外資單日大買／大賣門檻（新台幣，預設 5 億）
TRUST_BIG_TRADE_VALUE = float(os.environ.get("TRUST_BIG_TRADE_VALUE", "100000000"))  # 投信門檻（預設 1 億，投信規模較小）
TOP_N = int(os.environ.get("TOP_N", "20"))
HISTORY_DAYS = int(os.environ.get("HISTORY_DAYS", "10"))           # 每次回補的交易日數

# 新聞
NEWS_KEEP_DAYS = int(os.environ.get("NEWS_KEEP_DAYS", "3"))
LLM_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")

USER_AGENT = "Mozilla/5.0 (compatible; tw-market-intel/1.0)"
