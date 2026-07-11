"""Scrapes MM2 item values from supremevalues.com.

Uses curl_cffi with Chrome impersonation to get past the Incapsula WAF, which
blocks plain requests/httpx/aiohttp based on TLS fingerprint.
"""
import re

from bs4 import BeautifulSoup
from curl_cffi import requests as cf_requests

BASE_URL = "https://supremevalues.com/mm2"
IMPERSONATE = "chrome120"

CATEGORIES = [
    'sets', 'uniques', 'evos', 'ancients', 'vintages', 'chromas',
    'godlies', 'legendaries', 'rares', 'uncommons', 'commons',
    'pets', 'misc', 'untradables',
]

# If the site structure changes, parsing silently returns near-nothing.
# Bail out instead of pushing a near-empty snapshot.
MIN_ITEMS_SANITY = 100
MIN_CATEGORIES_SANITY = 10


def _parse_int(text, default=0):
    if text is None:
        return default
    cleaned = re.sub(r'[^\d+-]', '', str(text))
    if not cleaned or cleaned in ('+', '-'):
        return default
    try:
        return int(cleaned)
    except ValueError:
        return default


def _extract_last_change(col):
    # The change lives as raw HTML: <br>Last Change in Value - (<b>+25</b>)
    # Large changes are comma-formatted, e.g. (<b>-1,000</b>), so digits alone won't match.
    html = str(col)
    m = re.search(r'Last Change in Value\s*-\s*\(<b>\s*([+-]?[\d,]+)\s*</b>\)', html)
    return _parse_int(m.group(1)) if m else 0


def _parse_item(col, category):
    name_el = col.select_one('.itemhead')
    name = name_el.get_text(strip=True) if name_el else None
    if not name:
        return None

    # Unique owner-items, untradables, and starter items have no market value at
    # all (no data-value attribute, no .itemvalue element) - skip them rather than
    # recording a misleading value of 0.
    raw_value = col.get('data-value')
    if not raw_value:
        return None

    demand_el = col.select_one('.itemdemand')
    rarity_el = col.select_one('.itemrarity')
    origin_el = col.select_one('.itemorigin')
    stability_el = col.select_one('.itemstability')

    value = _parse_int(raw_value)
    demand = _parse_int(col.get('data-demand') or (demand_el.get_text() if demand_el else ''))
    rarity = _parse_int(col.get('data-rarity') or (rarity_el.get_text() if rarity_el else ''))
    stability = stability_el.get_text(strip=True) if stability_el else (col.get('data-stability-score') or '')
    origin = origin_el.get_text(strip=True) if origin_el else ''

    return {
        'name': name,
        'category': category,
        'value': value,
        'demand': demand,
        'rarity': rarity,
        'last_change': _extract_last_change(col),
        'stability': stability,
        'origin': origin,
    }


def _fetch_category(category, session):
    url = f"{BASE_URL}/{category}"
    resp = session.get(url, impersonate=IMPERSONATE, timeout=30)
    resp.raise_for_status()
    return resp.text


def scrape_all():
    """Scrapes every category and returns a flat list of item dicts.

    Raises RuntimeError if the result looks implausibly small, which usually
    means the site's HTML structure changed and parsing broke silently.
    """
    items = []
    categories_with_data = 0

    with cf_requests.Session() as session:
        for category in CATEGORIES:
            try:
                html = _fetch_category(category, session)
            except Exception as exc:
                print(f"[scrape] failed to fetch category '{category}': {exc}")
                continue

            soup = BeautifulSoup(html, 'lxml')
            found_any = False
            for col in soup.select('.itemcolumn'):
                item = _parse_item(col, category)
                if item:
                    items.append(item)
                    found_any = True
            if found_any:
                categories_with_data += 1

    if len(items) < MIN_ITEMS_SANITY or categories_with_data < MIN_CATEGORIES_SANITY:
        raise RuntimeError(
            f"Sanity check failed: only {len(items)} items across "
            f"{categories_with_data} categories were parsed. The site's HTML "
            "structure may have changed."
        )

    return items


if __name__ == '__main__':
    result = scrape_all()
    print(f"Scraped {len(result)} items")
