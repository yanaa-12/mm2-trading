"""Writes scraped items to the per-item CSV history and the latest snapshot."""
import csv
import json
from pathlib import Path

LATEST_FIELDS = ['name', 'category', 'value', 'demand', 'rarity', 'last_change', 'stability', 'origin']
ITEM_FIELDS = ['timestamp', 'value', 'demand', 'rarity', 'last_change', 'stability']


def safe_filename(name):
    return name.replace('/', '_').replace('\\', '_')


def write_snapshot(data_dir: Path, items, timestamp: str):
    """timestamp must be an ISO-8601 UTC string, e.g. 2026-07-11T06:00:00Z."""
    items_dir = data_dir / 'items'
    items_dir.mkdir(parents=True, exist_ok=True)

    for item in items:
        item_path = items_dir / f"{safe_filename(item['name'])}.csv"
        is_new = not item_path.exists()
        with open(item_path, 'a', newline='') as f:
            writer = csv.writer(f)
            if is_new:
                writer.writerow(ITEM_FIELDS)
            writer.writerow([
                timestamp,
                item['value'],
                item['demand'],
                item['rarity'],
                item['last_change'],
                item['stability'],
            ])

    with open(data_dir / 'latest.csv', 'w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=LATEST_FIELDS)
        writer.writeheader()
        writer.writerows({k: item[k] for k in LATEST_FIELDS} for item in items)

    meta = {'last_updated': timestamp, 'item_count': len(items)}
    with open(data_dir / 'meta.json', 'w') as f:
        json.dump(meta, f, indent=2)
