FROM python:3.13-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Without this, stdout is block-buffered when not attached to a terminal (i.e.
# always, in Docker), so print() output can sit unflushed and never reach
# `docker logs` even while the process is running fine.
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scrape.py storage.py run.py ./

ENTRYPOINT ["python", "run.py"]
