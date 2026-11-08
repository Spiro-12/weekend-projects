#!/usr/bin/env bash
# One command per track (PLAN §8): typecheck (app + sim purity), unit, golden, e2e on your port, build checks.
# Usage: E2E_WEB_PORT=<your port> npm run gate
set -euo pipefail
cd "$(dirname "$0")/.."
PORT="${E2E_WEB_PORT:-5180}"
echo "── typecheck"; npm run -s typecheck
echo "── unit"; npx vitest run --project unit
echo "── golden"; npx vitest run --project golden --passWithNoTests
echo "── e2e (port $PORT; builds first)"; E2E_WEB_PORT="$PORT" npx playwright test
echo "── base path"; grep -q '/weekend-projects/02-fleet-planner/assets/' dist/index.html
echo "GATE OK"
