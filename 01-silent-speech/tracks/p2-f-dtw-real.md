# Track F: DTW on real AirPods data

## Goal
Make the JS classifier as good and as safe as possible on Spiro's real recordings, and ship a public model.

## Owns
`web/src/ml/**`, `scripts/eval-dtw.ts`, `scripts/export-model.ts`, `scripts/golden-ml.py`, `tests/unit/ml/**`, `web/public/models/`, `ml/results/dtw-knn/`.

## Build
1. **Bud normalization** (PROTOCOL §5 step 0) in preprocessing: mirror right bud samples (`rr → [x, −y, −z]`, `ua → [−x, y, z]`) when `budNorm === 'mirror'`. Clip bud = `clip.loc`, set by the loader from `clip.loc ?? dataset.device.loc`. `predict(samples, ctx)` uses `ctx?.loc`. Templates are stored already normalized (no schema change). Unit tests, including that `'none'` is a no op.
2. **Data loading:** `web/src/ml/data.ts` fills `clip.loc` from the dataset when missing; `--exclude <file>` in `eval-dtw` and `export-model` (format PROTOCOL §3).
3. **Real data sweep** (`eval-dtw --sweep`, LOSO) on `data/raw/*.json --exclude data/raw/exclude.json`: channels (6 ch, rr only, ua only, rr + ua.y/z ...), L {48, 64, 96, 128}, band {0.05, 0.1, 0.2}, norm {global, clip}, k {1, 3}, budNorm {mirror, none}. Report three numbers per config: LOSO all 3 sessions, LOSO s2 + s3, and cross bud (train s2 + s3, test s1). Pick defaults by LOSO all 3 (tie break: cross bud). Change `DEFAULT_OPTS` only with evidence; explain in a comment.
4. **Threshold:** at the chosen config, sweep the accept threshold and report "correct accepted %" vs "none false accept %" and "wrong accepted %". Pick the default so wrong accepted ≤ 3% while keeping correct accepted as high as possible. Same safety checks as Phase 1 (synthetic safety tests must still pass).
5. **Public model:** `export-model` → `web/public/models/templates.json`, trained on **s1 + s2 only** (clean), with a `_meta` sidecar file `web/public/models/templates.meta.json` (`{ trainedOn: [...files], heldOut: 's3', opts, nTemplates, createdAt }`). Keep it under ~1.5 MB (round template values to 4 decimals if needed, check accuracy unchanged).
6. **Results:** write `ml/results/dtw-knn/{loo,loso}.json` from **real** data (all 3 sessions, exclude list, chosen defaults). Put the dataset file names in `params.datasets` and `params.sources: ['airpods']`.

## Gate
`npm run typecheck && npm test` green (golden scipy values still match; budNorm tests; Phase 1 safety tests). Report a table with the sweep's top 10, the chosen config, LOSO numbers, cross bud, threshold table, model size. CI green.
