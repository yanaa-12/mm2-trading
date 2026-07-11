# MM2 Supreme Values Tracker

Scrapes ~1,030 priced Murder Mystery 2 items from [supremevalues.com](https://supremevalues.com)
six times a day, commits the results as CSV to this repo, and serves a
TradingView-style charting SPA from GitHub Pages. No servers, no database —
just a container that scrapes + pushes, and static files that GitHub Pages hosts.

## Layout

```
scraper/            Python scraper + self-scheduling container
  scrape.py            fetches & parses supremevalues.com
  storage.py            writes docs/data/{latest.csv,meta.json,items/*.csv}
  run.py                long-running loop: scrapes at 06/09/12/15/18/21 UTC, git push
  Dockerfile
docs/                GitHub Pages root (the SPA)
  index.html, app.js, style.css
  data/
    latest.csv          current snapshot, one row per item
    meta.json           { last_updated, item_count }
    items/{name}.csv    per-item history, appended every scrape
docker-compose.yml   Portainer stack definition
.github/workflows/   builds & publishes the scraper image to ghcr.io
```

## Why a self-scheduling container instead of cron

Portainer manages standalone Docker containers — it has no built-in
scheduled/cron-triggered run (that's a Nomad/Kubernetes CronJob feature, not
available here). So instead of relying on the host to trigger runs,
`scraper/run.py` stays up permanently and drives its own schedule: it scrapes
immediately on start, then sleeps until the next of 06:00 / 09:00 / 12:00 /
15:00 / 18:00 / 21:00 UTC, forever. `restart: unless-stopped` in
`docker-compose.yml` means Portainer just needs to keep the container alive —
the container handles timing.

## Data format

Each item CSV row is timestamped (not just dated), since the scraper runs
6x/day:

```csv
timestamp,value,demand,rarity,last_change,stability
2026-07-11T06:00:04Z,4750,5,5,-250,Stable
2026-07-11T09:00:02Z,4750,5,5,0,Stable
```

Timestamps are UTC, ISO-8601 (`YYYY-MM-DDTHH:MM:SSZ`).

## Setup

### 1. GitHub token

The container needs a token that can push to this repo:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Repository access: only `yanaa-12/mm2-trading`
3. Permissions: **Contents: write**, **Metadata: read**
4. Copy the token — you won't see it again

### 2. Deploy the scraper in Portainer

Copy `.env.example` to `.env` and fill in `GH_TOKEN` (Portainer also lets you
set these as the stack's environment variables directly instead of a `.env`
file — either works).

In Portainer: **Stacks → Add stack → Repository**, point it at this repo and
`docker-compose.yml`, or paste the compose file directly and upload/paste
`.env`. Deploy. The container builds the image (from `scraper/Dockerfile`),
scrapes once immediately, then keeps running and re-scrapes at 06/09/12/15/18/21 UTC.

Check logs in Portainer to confirm: `[run] scraped 1032 items` followed by
either `[run] pushed update for ...` or `[run] nothing changed, skipping push`.

Alternatively, once the GitHub Actions workflow below has run at least once,
point `docker-compose.yml`'s `image:` at `ghcr.io/yanaa-12/mm2-trading/scraper:latest`
instead of building locally — faster deploys, no build step in Portainer.

### 3. Enable GitHub Pages

Repo → Settings → Pages → Source: `Deploy from a branch` → Branch: `main`,
folder: `/docs`. The site will be live at `https://yanaa-12.github.io/mm2-trading/`.

## Local testing without git/Docker

```bash
cd scraper
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
DRY_RUN=1 RUN_ONCE=1 python3 run.py
```

This scrapes the live site and writes CSVs to `./local-data/` (no GitHub
token needed, no git operations). Point a local static server at `docs/`
with `local-data` copied in as `docs/data` to preview the SPA against real data.

## Known limitations (carried over from the original design doc)

- If supremevalues.com changes its HTML structure, parsing may silently
  return too few items — `scrape_all()` raises instead of pushing a broken
  snapshot if fewer than 100 items or 10 categories are found.
- If the Proxmox host is offline during a scheduled run, that run is simply
  skipped — per-item CSVs just get a gap, no corruption.
- A push can fail if the remote has diverged; `run.py` does a fresh
  `fetch` + hard reset to `origin/main` before every write, which handles the
  common case (no concurrent writers) but will discard local-only commits if
  someone edits the repo checkout inside a running container by hand.
