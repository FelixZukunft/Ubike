"""HTTP fetching with retry/backoff, forced UTF-8 decoding and raw archiving."""
from __future__ import annotations

import gzip
import json
import logging
import random
import time

import httpx

from .config import RAW_DIR, now_local

log = logging.getLogger(__name__)

_client = httpx.Client(
    timeout=httpx.Timeout(40.0, connect=15.0),
    headers={"User-Agent": "ubike-optimizer/0.1 (research prototype)"},
    follow_redirects=True,
)

_RETRY_STATUS = {429, 500, 502, 503, 504}


def archive_raw(source: str, content: bytes, suffix: str = "json") -> None:
    """Keep every raw payload forever (gzip), as data/raw/<source>/<date>/<time>.json.gz."""
    ts = now_local()
    d = RAW_DIR / source / ts.strftime("%Y-%m-%d")
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{ts.strftime('%H%M%S')}.{suffix}.gz"
    path.write_bytes(gzip.compress(content))


def get_json(url: str, *, params: dict | None = None, headers: dict | None = None,
             source: str | None = None, retries: int = 4):
    """GET a JSON document. Retries transport errors, 429 and 5xx with exponential backoff.

    The body is always decoded as UTF-8 (the YouBike feed has shown mojibake when
    clients guess the charset). If `source` is given, the raw body is archived.
    """
    delay = 2.0
    for attempt in range(retries + 1):
        try:
            r = _client.get(url, params=params, headers=headers)
            if r.status_code in _RETRY_STATUS:
                raise httpx.HTTPStatusError(f"HTTP {r.status_code}", request=r.request, response=r)
            r.raise_for_status()
            data = json.loads(r.content.decode("utf-8-sig"))
            if source:
                archive_raw(source, r.content)
            return data
        except (httpx.TransportError, httpx.HTTPStatusError) as e:
            retryable = isinstance(e, httpx.TransportError) or e.response.status_code in _RETRY_STATUS
            if not retryable or attempt == retries:
                raise
            wait = delay + random.random()
            log.warning("GET %s failed (%s), retry %d/%d in %.1fs", url, e, attempt + 1, retries, wait)
            time.sleep(wait)
            delay *= 2
