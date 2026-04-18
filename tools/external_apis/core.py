"""External API Integration Core — rate limiting, caching, base client."""
import asyncio
import aiohttp
import hashlib
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from xml.parsers.expat import ExpatError

logger = logging.getLogger(__name__)


@dataclass
class APIResponse:
    """Standardised API response format."""
    success: bool
    data: Any
    error: Optional[str] = None
    source: str = ""
    cached: bool = False
    rate_limited: bool = False
    retry_after: Optional[int] = None
    metadata: Optional[Dict] = None


@dataclass
class RateLimitConfig:
    """Rate limiting configuration."""
    requests_per_second: float
    requests_per_minute: int
    requests_per_hour: int
    burst_limit: int


class APIRateLimiter:
    """Intelligent rate limiting with burst support."""

    def __init__(self, config: RateLimitConfig):
        self.config = config
        self.local_requests: List[float] = []
        self.last_request: float = 0

    async def acquire(self, api_name: str) -> bool:
        now = time.time()
        # Prune requests older than 1 hour
        self.local_requests = [t for t in self.local_requests if now - t < 3600]

        if self._over_second_limit(now):
            return False
        if self._over_minute_limit(now):
            return False
        if self._over_hour_limit():
            return False
        if self._over_burst_limit(now):
            return False

        self.local_requests.append(now)
        self.last_request = now
        return True

    def _over_second_limit(self, now: float) -> bool:
        return self.last_request > 0 and (now - self.last_request) < (1.0 / self.config.requests_per_second)

    def _over_minute_limit(self, now: float) -> bool:
        recent = [t for t in self.local_requests if now - t < 60]
        return len(recent) >= self.config.requests_per_minute

    def _over_hour_limit(self) -> bool:
        return len(self.local_requests) >= self.config.requests_per_hour

    def _over_burst_limit(self, now: float) -> bool:
        burst = [t for t in self.local_requests if now - t < 10]
        return len(burst) >= self.config.burst_limit

    async def wait_if_needed(self, api_name: str) -> float:
        if await self.acquire(api_name):
            return 0.0
        now = time.time()
        wait_candidates: List[float] = []
        if self.last_request > 0:
            wait_candidates.append((1.0 / self.config.requests_per_second) - (now - self.last_request))
        recent_minute = [t for t in self.local_requests if now - t < 60]
        if len(recent_minute) >= self.config.requests_per_minute and recent_minute:
            wait_candidates.append(60.0 - (now - min(recent_minute)))
        wait_time = max(0.0, max(wait_candidates) if wait_candidates else 0.0)
        if wait_time > 0:
            await asyncio.sleep(wait_time)
        return wait_time


class APICache:
    """In-memory LRU-style cache for API responses (Redis optional)."""

    def __init__(self, redis_client=None):
        self._redis = None
        self._memory: Dict[str, tuple] = {}
        if redis_client is not None:
            self._redis = redis_client
        else:
            try:
                import redis as _redis
                self._redis = _redis.from_url("redis://localhost:6379/0", decode_responses=True)
                # Test connection
                self._redis.ping()
            except Exception:
                logger.debug("Redis unavailable — using in-memory cache")
                self._redis = None

    @staticmethod
    def _key(api_name: str, endpoint: str, params: Dict) -> str:
        payload = json.dumps(params, sort_keys=True)
        digest = hashlib.md5(payload.encode()).hexdigest()
        return f"api_cache:{api_name}:{endpoint}:{digest}"

    async def get(self, api_name: str, endpoint: str, params: Dict, ttl_hours: int = 24) -> Optional[Any]:
        key = self._key(api_name, endpoint, params)
        try:
            if self._redis:
                raw = self._redis.get(key)
                return json.loads(raw) if raw else None
            entry = self._memory.get(key)
            if entry:
                data, ts = entry
                if time.time() - ts < ttl_hours * 3600:
                    return data
                del self._memory[key]
        except Exception as exc:
            logger.debug("Cache get error: %s", exc)
        return None

    async def set(self, api_name: str, endpoint: str, params: Dict, data: Any, ttl_hours: int = 24) -> None:
        key = self._key(api_name, endpoint, params)
        try:
            if self._redis:
                self._redis.setex(key, ttl_hours * 3600, json.dumps(data, default=str))
                return
            self._memory[key] = (data, time.time())
            # Simple size cap
            if len(self._memory) > 1000:
                now = time.time()
                expired = [k for k, (_, ts) in self._memory.items() if now - ts > ttl_hours * 3600]
                for k in expired:
                    del self._memory[k]
        except Exception as exc:
            logger.debug("Cache set error: %s", exc)



class BaseAPIClient:
    """Base class for external API clients."""

    def __init__(self, api_name: str, base_url: str, rate_limit_config: RateLimitConfig):
        self.api_name = api_name
        self.base_url = base_url.rstrip("/")
        self.rate_limiter = APIRateLimiter(rate_limit_config)
        self.cache = APICache()
        self.session: Optional[aiohttp.ClientSession] = None
        self.request_count = 0
        self.error_count = 0

    async def __aenter__(self) -> "BaseAPIClient":
        self.session = aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=30),
            headers=self._default_headers(),
        )
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        if self.session:
            await self.session.close()

    def _default_headers(self) -> Dict[str, str]:
        return {
            "User-Agent": f"PrionLab-tools/1.0 ({self.api_name} client)",
            "Accept": "application/json",
        }

    async def _make_request(
        self,
        method: str,
        endpoint: str,
        params: Optional[Dict] = None,
        body: Optional[Dict] = None,
        headers: Optional[Dict] = None,
        cache_ttl_hours: int = 24,
        use_cache: bool = True,
    ) -> APIResponse:
        """Make an API request with rate limiting, caching, and retry logic."""

        # Cache lookup (GET only)
        if use_cache and method.upper() == "GET":
            cached = await self.cache.get(self.api_name, endpoint, params or {}, cache_ttl_hours)
            if cached is not None:
                return APIResponse(success=True, data=cached, source=self.api_name, cached=True)

        # Wait for rate-limit quota
        wait = await self.rate_limiter.wait_if_needed(self.api_name)
        if wait > 0:
            logger.debug("%s: waited %.2fs for rate limiting", self.api_name, wait)

        url = f"{self.base_url}/{endpoint.lstrip('/')}"
        req_headers = self._default_headers()
        if headers:
            req_headers.update(headers)

        max_retries = 3
        for attempt in range(max_retries):
            try:
                self.request_count += 1
                async with self.session.request(
                    method=method,
                    url=url,
                    params=params,
                    json=body if method.upper() != "GET" else None,
                    headers=req_headers,
                ) as resp:
                    if resp.status == 429:
                        retry_after = int(resp.headers.get("Retry-After", 60))
                        logger.warning("%s: rate-limited, waiting %ds", self.api_name, retry_after)
                        await asyncio.sleep(retry_after)
                        continue

                    if resp.status >= 400:
                        self.error_count += 1
                        err_text = await resp.text()
                        return APIResponse(
                            success=False, data=None,
                            error=f"HTTP {resp.status}: {err_text[:200]}",
                            source=self.api_name,
                        )

                    content_type = resp.headers.get("content-type", "").lower()
                    if "json" in content_type:
                        response_data = await resp.json()
                    elif "xml" in content_type:
                        response_data = self._parse_xml(await resp.text())
                    else:
                        response_data = await resp.text()

                    if use_cache and method.upper() == "GET":
                        await self.cache.set(self.api_name, endpoint, params or {}, response_data, cache_ttl_hours)

                    return APIResponse(
                        success=True,
                        data=response_data,
                        source=self.api_name,
                        cached=False,
                        metadata={"status_code": resp.status, "content_type": content_type},
                    )

            except asyncio.TimeoutError:
                self.error_count += 1
                if attempt == max_retries - 1:
                    return APIResponse(success=False, data=None,
                                       error="Request timed out", source=self.api_name)
                await asyncio.sleep(2 ** attempt)

            except Exception as exc:
                self.error_count += 1
                logger.error("%s request error (attempt %d): %s", self.api_name, attempt + 1, exc)
                if attempt == max_retries - 1:
                    return APIResponse(success=False, data=None,
                                       error=str(exc), source=self.api_name)
                await asyncio.sleep(2 ** attempt)

        return APIResponse(success=False, data=None, error="Max retries exceeded", source=self.api_name)

    def _parse_xml(self, xml_text: str) -> Dict:
        try:
            root = ET.fromstring(xml_text)
            return self._elem_to_dict(root)
        except ExpatError as exc:
            logger.warning("XML parse error: %s", exc)
            return {"raw_xml": xml_text}

    def _elem_to_dict(self, elem) -> Any:
        result: Dict[str, Any] = {}
        if elem.attrib:
            result["@attributes"] = dict(elem.attrib)
        if elem.text and elem.text.strip():
            if len(elem) == 0:
                return elem.text.strip()
            result["#text"] = elem.text.strip()
        for child in elem:
            child_data = self._elem_to_dict(child)
            if child.tag in result:
                if not isinstance(result[child.tag], list):
                    result[child.tag] = [result[child.tag]]
                result[child.tag].append(child_data)
            else:
                result[child.tag] = child_data
        return result

    async def health_status(self) -> Dict:
        error_rate = (self.error_count / max(1, self.request_count)) * 100
        return {
            "api_name": self.api_name,
            "total_requests": self.request_count,
            "total_errors": self.error_count,
            "error_rate_pct": round(error_rate, 2),
            "status": "healthy" if error_rate < 10 else "degraded",
        }


# Per-API rate limit configurations
API_RATE_LIMITS = {
    "crossref": RateLimitConfig(
        requests_per_second=1.0,
        requests_per_minute=50,
        requests_per_hour=2000,
        burst_limit=5,
    ),
    "pubmed": RateLimitConfig(
        requests_per_second=0.33,
        requests_per_minute=20,
        requests_per_hour=1000,
        burst_limit=3,
    ),
    "orcid": RateLimitConfig(
        requests_per_second=2.0,
        requests_per_minute=100,
        requests_per_hour=5000,
        burst_limit=10,
    ),
}
