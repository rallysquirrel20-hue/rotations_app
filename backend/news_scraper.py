"""
News scraper module using Firecrawl to fetch financial news for tickers.
Provides search-based news retrieval with simple sentiment scoring.
"""

import os
import re
import json
import logging
import hashlib
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# In-memory cache: key -> (timestamp, data)
_cache: dict[str, tuple[datetime, list[dict]]] = {}
CACHE_TTL_MINUTES = int(os.getenv("NEWS_CACHE_TTL_MINUTES", "15"))

# Simple keyword-based sentiment scoring
_POSITIVE_WORDS = frozenset([
    "surge", "surges", "surging", "rally", "rallies", "rallying", "gain", "gains",
    "jump", "jumps", "soar", "soars", "bullish", "upgrade", "upgrades", "upgraded",
    "beat", "beats", "outperform", "outperforms", "record", "high", "profit",
    "growth", "strong", "positive", "buy", "overweight", "raise", "raises",
    "boost", "boosts", "optimistic", "recover", "recovers", "recovery",
    "breakout", "momentum", "upside", "opportunity",
])
_NEGATIVE_WORDS = frozenset([
    "drop", "drops", "fall", "falls", "falling", "decline", "declines", "plunge",
    "plunges", "crash", "crashes", "bearish", "downgrade", "downgrades", "downgraded",
    "miss", "misses", "underperform", "underperforms", "loss", "losses", "weak",
    "negative", "sell", "underweight", "cut", "cuts", "warning", "warns",
    "risk", "recession", "layoff", "layoffs", "shutdown", "bankruptcy",
    "breakdown", "downside", "concern", "fears",
])


def _score_sentiment(text: str) -> dict:
    """Return a simple sentiment dict based on keyword counting."""
    words = set(re.findall(r'[a-z]+', text.lower()))
    pos = len(words & _POSITIVE_WORDS)
    neg = len(words & _NEGATIVE_WORDS)
    total = pos + neg
    if total == 0:
        return {"label": "neutral", "score": 0.0}
    ratio = (pos - neg) / total
    if ratio > 0.2:
        label = "positive"
    elif ratio < -0.2:
        label = "negative"
    else:
        label = "neutral"
    return {"label": label, "score": round(ratio, 3)}


def _get_firecrawl_client():
    """Lazily initialize and return a Firecrawl client."""
    api_key = os.getenv("FIRECRAWL_API_KEY")
    if not api_key:
        raise RuntimeError(
            "FIRECRAWL_API_KEY not set. Add it to your .env file to enable news scraping."
        )
    from firecrawl import Firecrawl
    return Firecrawl(api_key=api_key)


def _cache_key(query: str, limit: int) -> str:
    return hashlib.md5(f"{query}:{limit}".encode()).hexdigest()


async def scrape_news(
    ticker: str,
    company_name: Optional[str] = None,
    limit: int = 10,
) -> list[dict]:
    """
    Search for recent financial news about a ticker using Firecrawl search.

    Returns a list of dicts with keys:
        title, url, snippet, source, sentiment, scraped_at
    """
    query = f"{ticker} stock news"
    if company_name:
        query = f"{company_name} ({ticker}) stock news"

    key = _cache_key(query, limit)

    # Check cache
    if key in _cache:
        cached_at, cached_data = _cache[key]
        if datetime.now() - cached_at < timedelta(minutes=CACHE_TTL_MINUTES):
            logger.info(f"News cache hit for {ticker}")
            return cached_data

    try:
        client = _get_firecrawl_client()

        # Use Firecrawl search to find relevant news pages
        results = client.search(query, limit=limit)

        articles = []
        for item in (results.get("data", []) if isinstance(results, dict) else results):
            # Handle both dict and object responses
            if isinstance(item, dict):
                title = item.get("title", "")
                url = item.get("url", "")
                markdown = item.get("markdown", "")
                description = item.get("description", "")
            else:
                title = getattr(item, "title", "")
                url = getattr(item, "url", "")
                markdown = getattr(item, "markdown", "")
                description = getattr(item, "description", "")

            snippet = description or (markdown[:300] + "..." if len(markdown) > 300 else markdown)

            # Extract domain as source
            source = ""
            if url:
                from urllib.parse import urlparse
                parsed = urlparse(url)
                source = parsed.netloc.replace("www.", "")

            sentiment = _score_sentiment(f"{title} {snippet}")

            articles.append({
                "title": title,
                "url": url,
                "snippet": snippet,
                "source": source,
                "sentiment": sentiment,
                "scraped_at": datetime.now().isoformat(),
            })

        # Update cache
        _cache[key] = (datetime.now(), articles)
        logger.info(f"Scraped {len(articles)} articles for {ticker}")
        return articles

    except Exception as e:
        logger.error(f"Firecrawl news scrape failed for {ticker}: {e}")
        raise


async def scrape_url(url: str) -> dict:
    """
    Scrape a single URL and return its content as markdown.

    Returns dict with keys: title, url, markdown, sentiment
    """
    try:
        client = _get_firecrawl_client()
        result = client.scrape(url, formats=["markdown"])

        if isinstance(result, dict):
            markdown = result.get("markdown", "")
            title = result.get("metadata", {}).get("title", "")
        else:
            markdown = getattr(result, "markdown", "")
            metadata = getattr(result, "metadata", {})
            title = metadata.get("title", "") if isinstance(metadata, dict) else getattr(metadata, "title", "")

        sentiment = _score_sentiment(f"{title} {markdown}")

        return {
            "title": title,
            "url": url,
            "markdown": markdown,
            "sentiment": sentiment,
            "scraped_at": datetime.now().isoformat(),
        }

    except Exception as e:
        logger.error(f"Firecrawl URL scrape failed for {url}: {e}")
        raise
