# Track G: model shootout on real data (Python)

## Goal
Honest, reproducible real-data numbers for the portfolio, across model families, plus a "luck test".

## Owns
`ml/**` except `ml/results/dtw-knn/` (Track F writes that).

## Build
1. Port PROTOCOL §5 step 0 (`budNorm` mirror, default on) and per clip `loc` (fallback `device.loc`) to `silent/preprocess.py` / `silent/data.py`; `--exclude data/raw/exclude.json` in `bench` and `report`.
2. Run dtw-py (k = 1 default, JS confidence port), MiniRocket and the CNN on `data/raw/*.json` with the exclude list: **LOSO (headline)**, LOO, and a **cross bud** split (train s2 + s3 → test s1, raw vs mirrored). Write `ml/results/<model>/{loo,loso,xbud}.json` (`protocol` field: `'loo' | 'loso' | 'xbud'`; report.py must handle `xbud`).
3. **Luck test** (idea from github.com/joeblau/subvox): for dtw-py and MiniRocket, LOSO accuracy vs 500 label shuffles (shuffle within each training fold; for DTW precompute the distance matrix once). Report p value and the shuffled mean. Write it into the results JSON (`params.permutation`).
4. `RESULTS.md`: a **Real AirPods data** section first (headline LOSO table with counts like 236/273, cross bud table, luck test, per class confusion PNGs), then the existing **Synthetic** section, still clearly labeled. Show which bud each session used.
5. JS cross check: once Track F pushes real-data `ml/results/dtw-knn/*.json` (poll `git fetch origin p2-f-dtw-real`), `report.py` compares; dtw-py and dtw-knn must agree on real data when options match (regenerate the JS snapshot test data if F's code changed predictions: see `ml/tests/data/js_dtw_knn_loso.json` `_from`).
6. Keep CI light (torch stays optional; real-data runs are not part of pytest, only a small smoke test on 2 sessions × 2 classes).

## Gate
`cd ml && uv run pytest` green, CI green. Report the real numbers table, the luck test, and anything surprising.
