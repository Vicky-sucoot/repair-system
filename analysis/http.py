"""HTTP 工具：統一 User-Agent、重試、間隔，並遵守 robots.txt。"""
from __future__ import annotations

import time
import urllib.robotparser
from urllib.parse import urlsplit

import requests

from .config import USER_AGENT

_session = requests.Session()
_session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json, application/xml, text/xml, */*"})
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
_last_request: dict[str, float] = {}


def allowed_by_robots(url: str) -> bool:
    """robots.txt 明確禁止時回傳 False；讀不到 robots.txt 時視為允許。"""
    parts = urlsplit(url)
    origin = f"{parts.scheme}://{parts.netloc}"
    if origin not in _robots:
        parser = urllib.robotparser.RobotFileParser()
        try:
            resp = _session.get(f"{origin}/robots.txt", timeout=15)
            if resp.status_code == 200 and "text/html" not in resp.headers.get("content-type", ""):
                parser.parse(resp.text.splitlines())
                _robots[origin] = parser
            else:
                _robots[origin] = None
        except requests.RequestException:
            _robots[origin] = None
    parser = _robots[origin]
    return True if parser is None else parser.can_fetch(USER_AGENT, url)


def get(url: str, *, params=None, min_interval: float = 1.0, retries: int = 3, timeout: float = 30) -> requests.Response:
    """GET 並在同一主機的請求間保持最小間隔（證交所有頻率限制）。"""
    if not allowed_by_robots(url):
        raise PermissionError(f"robots.txt 不允許抓取：{url}")
    host = urlsplit(url).netloc
    last_error: Exception | None = None
    for attempt in range(retries):
        wait = _last_request.get(host, 0) + min_interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        try:
            resp = _session.get(url, params=params, timeout=timeout)
            _last_request[host] = time.monotonic()
            resp.raise_for_status()
            return resp
        except requests.RequestException as error:
            _last_request[host] = time.monotonic()
            last_error = error
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"下載失敗：{url}（{last_error}）")
