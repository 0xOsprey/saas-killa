#!/usr/bin/env bash
# dev-db.sh — local Postgres for development, bound to loopback only.
#
# Production points DATABASE_URL at a hosted Postgres (Supabase or Neon); this
# script exists so the app, the seed and the Playwright suite all run on a box
# with no cloud credentials. The container publishes on 127.0.0.1 exclusively —
# a 0.0.0.0 publish would expose the database to every device on the tailnet.
set -euo pipefail

NAME=sessionboard-pg
IMAGE=postgres:17-alpine
PORT=${SESSIONBOARD_PG_PORT:-5433}
PASSWORD=${SESSIONBOARD_PG_PASSWORD:-sessionboard}

case "${1:-up}" in
  up)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "✓ $NAME already running on 127.0.0.1:$PORT"
      exit 0
    fi
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
    else
      docker run -d --name "$NAME" \
        -e POSTGRES_PASSWORD="$PASSWORD" \
        -e POSTGRES_USER=sessionboard \
        -e POSTGRES_DB=sessionboard \
        -p "127.0.0.1:$PORT:5432" \
        "$IMAGE" >/dev/null
    fi
    printf '→ waiting for postgres'
    for _ in $(seq 1 60); do
      if docker exec "$NAME" pg_isready -U sessionboard -q 2>/dev/null; then
        echo ""
        echo "✓ $NAME ready on 127.0.0.1:$PORT"
        exit 0
      fi
      printf '.'
      sleep 1
    done
    echo ""
    echo "✗ postgres did not become ready in 60s" >&2
    exit 1
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "✓ $NAME removed"
    ;;
  *)
    echo "usage: dev-db.sh [up|down]" >&2
    exit 2
    ;;
esac
