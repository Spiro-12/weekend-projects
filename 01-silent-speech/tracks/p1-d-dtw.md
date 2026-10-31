# Track D: DTW + kNN classifier (JS)

## Goal
Implement the frozen API in `web/src/ml/index.ts` per `PROTOCOL.md` §5 + §6, fast enough to run live in the browser, plus CLI scripts.

## Owns
`web/src/ml/**` (split into `preprocess.ts`, `dtw.ts`, `knn.ts`, `eval.ts`, keep `index.ts` as the public API with the same exports/signatures), `tests/unit/ml/**`, `scripts/eval-dtw.ts`, `scripts/export-model.ts`, `ml/results/dtw-knn/`, `web/public/models/`.

## Build
- **preprocess**: follow `PROTOCOL.md` §5 **to the letter** (50 Hz grid formula (`GRID_HZ`), `filtfilt` with `padtype='odd', padlen=min(9, n-1)` and scipy's `lfilter_zi` initial conditions, resample positions, norm stats). Make **golden values** with real scipy (`uv run --with scipy --with numpy python ...`, script kept in `scripts/`) for a few inputs and commit them as `tests/unit/ml/golden.json`; your JS must match to 1e-6. Returns `Float32Array[]` [ch][L].
- **dtw**: dependent multivariate, squared Euclidean local cost summed over channels, Sakoe-Chiba radius `Math.max(1, Math.floor(band * L + 0.5))`, returns total cost. Two rolling rows, typed arrays, early abandon optional. Must be fast: `predict` < 20 ms with 120 templates.
- **knn**: k = 3, distance weighted. Define confidence in [0,1] and `top` (≤ 3, desc) sensibly (e.g. softmax over each class's nearest distance with a temperature from the data) and document it in a comment. `accepted = label !== 'none' && confidence >= threshold`.
- **train / loadModel / toJSON / add**: model JSON = `DtwKnnModelJSON` (templates already preprocessed so loading is instant).
- Merge inputs and **dedupe by clip `id`** before train/evaluate (`train`, `evaluate`, `eval-dtw`, `export-model`).
- **evaluate**: `loo` (leave one clip out) and `loso` (leave one session out; session = `clip.session`). Norm stats from the training fold only. Returns `Metrics` (`model: 'dtw-knn'`). Include `noneFalseAcceptRate` = share of true `none` clips that were `accepted`.
- **scripts/eval-dtw.ts**: `npx tsx scripts/eval-dtw.ts <dataset.json...> [--protocol loo|loso] [--opts '{"k":1}']` → prints a table, writes `ml/results/dtw-knn/<protocol>.json`. Supports `--sweep` (channels × L {48,64,96} × band {0.05,0.1,0.2} × norm × k {1,3}) printing a ranked table (Phase 2 uses it).
- **scripts/export-model.ts**: train on given datasets → `web/public/models/templates.json`.

## Gate
- `npm run typecheck && npm test` green. Unit tests: dtw(a,a)=0, symmetric, band 0 equals Euclidean, warped copy closer than different class; high pass removes a 0.2 Hz sine (> 90% power drop) but keeps 5 Hz (> 80% kept); preprocess output shape; `train`/`loadModel(toJSON())` give identical predictions.
- On `shared/fixtures/dataset.synthetic.json`: **LOSO accuracy ≥ 0.95**, LOO ≥ 0.95, predict < 20 ms (assert in test with some slack).
- Write `ml/results/dtw-knn/{loo,loso}.json` from the synthetic fixture.
