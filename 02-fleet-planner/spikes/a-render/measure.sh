#!/usr/bin/env bash
# Spike a measurement matrix (RESULTS.md). Run from 02-fleet-planner/ with nothing else running:
#   npx vite build --config spikes/a-render/vite.config.ts
#   npx tsx scripts/serve-gz.ts spikes/a-render/out/dist 5191 &
#   bash spikes/a-render/measure.sh [name ...]          (no names = the whole matrix)
#   PERF_FLAGS="--sync --seconds 12" PREFIX=spike-a-sync- bash spikes/a-render/measure.sh single-high split150-medium
# JSON lands in tests/perf/out/${PREFIX:-spike-a-}<name>.json (gitignored). Each line: name | query | extra harness flags.
set -uo pipefail
cd "$(dirname "$0")/../.."
BASE=${SPIKE_URL:-http://localhost:5191/weekend-projects/02-fleet-planner/}
PREFIX=${PREFIX:-spike-a-}
PERF_FLAGS=${PERF_FLAGS:-}
MATRIX=(
  "single-high|tier=high|"
  "single-medium|tier=medium|"
  "single-low|tier=low|"
  "split150-high|tier=high&view=split&robots=150&people=40|"
  "split150-medium|tier=medium&view=split&robots=150&people=40|"
  "split150-high15|tier=high&view=split&robots=150&people=40&dpr=1.5&bloomScale=0.5|"
  "split150-low|tier=low&view=split&robots=150&people=40|"
  "split60-high|tier=high&view=split&robots=60&people=16|"
  "people40-parts|tier=medium&people=40&peopleMode=parts|"
  "people40-skinned|tier=medium&people=40&peopleMode=skinned|"
  "phone|tier=low|--phone"
)
for row in "${MATRIX[@]}"; do
  IFS='|' read -r name query extra <<<"$row"
  if [ $# -gt 0 ] && [[ " $* " != *" $name "* ]]; then continue; fi
  echo "=== $name ($query $extra)"
  # shellcheck disable=SC2086
  npx tsx scripts/perf.ts --url "${BASE}?${query}" --out "tests/perf/out/${PREFIX}${name}.json" $extra $PERF_FLAGS 2>&1 | grep -E 'REFUSED|WARNING|ok:|NOISY|failed' || true
done
