"""Long-running entrypoint: scrapes on a fixed UTC schedule and syncs to GitHub.

Portainer (standalone Docker) has no built-in cron/scheduled-run feature, so
this container stays up and drives its own schedule instead of relying on a
host cron job.
"""
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scrape import scrape_all
from storage import write_snapshot

RUN_HOURS_UTC = [6, 9, 12, 15, 18, 21]
DATA_SUBDIR = 'docs/data'
GIT_TIMEOUT_SECONDS = 60

REPO_DIR = Path(os.environ.get('REPO_DIR', '/app/repo'))
DRY_RUN = os.environ.get('DRY_RUN', '').lower() in ('1', 'true', 'yes')
RUN_ONCE = os.environ.get('RUN_ONCE', '').lower() in ('1', 'true', 'yes')
LOCAL_DATA_DIR = Path(os.environ.get('LOCAL_DATA_DIR', 'local-data'))

# Fail fast instead of hanging if a credential is ever wrong - git would
# otherwise try to prompt for a username/password with no terminal to prompt on.
os.environ['GIT_TERMINAL_PROMPT'] = '0'


def env(name, required=True, default=None):
    value = os.environ.get(name, default)
    if required and not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def git(*args, check=True, timeout=GIT_TIMEOUT_SECONDS):
    return subprocess.run(
        ['git', *args], cwd=REPO_DIR, check=check, capture_output=True, text=True, timeout=timeout,
    )


def ensure_repo():
    owner = env('REPO_OWNER')
    name = env('REPO_NAME')
    branch = env('REPO_BRANCH', required=False, default='main')
    token = env('GH_TOKEN')
    remote_url = f"https://x-access-token:{token}@github.com/{owner}/{name}.git"

    if (REPO_DIR / '.git').exists():
        subprocess.run(
            ['git', 'remote', 'set-url', 'origin', remote_url],
            cwd=REPO_DIR, check=True, timeout=GIT_TIMEOUT_SECONDS,
        )
        git('fetch', '--depth', '1', 'origin', branch)
        git('checkout', '-B', branch, f'origin/{branch}')
    else:
        REPO_DIR.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ['git', 'clone', '--branch', branch, '--depth', '1', remote_url, str(REPO_DIR)],
            check=True, timeout=GIT_TIMEOUT_SECONDS,
        )

    git('config', 'user.name', env('GIT_USER_NAME', required=False, default='mm2-bot'))
    git('config', 'user.email', env('GIT_USER_EMAIL', required=False, default='mm2-bot@users.noreply.github.com'))
    return branch


def run_once():
    now = datetime.now(timezone.utc)
    timestamp = now.strftime('%Y-%m-%dT%H:%M:%SZ')
    print(f"[run] starting scrape at {timestamp}")

    items = scrape_all()
    print(f"[run] scraped {len(items)} items")

    if DRY_RUN:
        LOCAL_DATA_DIR.mkdir(parents=True, exist_ok=True)
        write_snapshot(LOCAL_DATA_DIR, items, timestamp)
        print(f"[run] DRY_RUN set, wrote snapshot to {LOCAL_DATA_DIR} (skipped git)")
        return

    branch = ensure_repo()
    write_snapshot(REPO_DIR / DATA_SUBDIR, items, timestamp)

    git('add', 'docs/data/')
    commit = git('commit', '-m', f'scrape {timestamp}', check=False)
    if commit.returncode != 0:
        print("[run] nothing changed, skipping push")
        return

    git('push', 'origin', f'HEAD:{branch}')
    print(f"[run] pushed update for {timestamp}")


def next_run_time(now):
    candidates = []
    for hour in RUN_HOURS_UTC:
        candidate = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if candidate <= now:
            candidate += timedelta(days=1)
        candidates.append(candidate)
    return min(candidates)


def main():
    while True:
        try:
            run_once()
        except Exception as exc:
            print(f"[run] scrape failed: {exc}", file=sys.stderr)

        if RUN_ONCE:
            return

        now = datetime.now(timezone.utc)
        target = next_run_time(now)
        sleep_seconds = (target - now).total_seconds()
        print(f"[run] sleeping {sleep_seconds:.0f}s until next run at {target.isoformat()}")
        time.sleep(sleep_seconds)


if __name__ == '__main__':
    main()
