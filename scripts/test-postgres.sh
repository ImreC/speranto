#!/bin/sh
set -eu

COMPOSE_FILE="tests/docker-compose.yml"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  echo "Error: Docker Compose is required to run PostgreSQL tests." >&2
  exit 1
fi

$COMPOSE_CMD -f "$COMPOSE_FILE" up -d --wait postgres
LLM_API_KEY=test bun test tests/database/postgres.test.ts
