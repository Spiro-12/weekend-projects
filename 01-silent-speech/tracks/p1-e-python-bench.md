# Track E: Python benchmark (offline model shootout)

## Goal
A small `uv` Python project that loads our datasets, applies **the same preprocessing as JS** (`PROTOCOL.md` §5), and benchmarks DTW, MiniRocket and a small 1D CNN with honest LOO and LOSO scores. Phase 2 runs it on real data.

## Owns
`ml/**` except `ml/results/dtw-knn/` (Track D writes that).

## Build
- `ml/pyproject.toml` (Python 3.12 via `uv python install 3.12` if 3.13 gives trouble), deps: numpy, scipy, scikit-learn, aeon, matplotlib, pytest. **torch as an optional extra** (`[cnn]`): try `uv pip install torch` for at most 10 minutes (the PyTorch CPU index is blocked here; PyPI's Linux wheel is big but works on CPU). If it fails, implement the CNN with Keras 3 on JAX CPU, or skip CNN and say so.
- `silent/data.py`: load one or many `ss-dataset` files, validate basic shape, merge, session = `clip.session or dataset.session`.
- `silent/preprocess.py`: spec v1 exactly (uniform 25 Hz linear resample, channels, `scipy.signal.butter(2, 1.0, 'highpass', fs=25)` + `filtfilt`, resample to L=64, global z from train fold / per clip z with floor). Returns `(n, ch, L)` arrays.
- `silent/cv.py`: LOO and LOSO splitters.
- `silent/models/dtw.py`: own numpy DTW identical to the JS spec (dependent, squared Euclidean, Sakoe-Chiba radius round(0.1·L)), kNN k=3. Name it `dtw-py`. This is the cross check against the JS version.
- `silent/models/minirocket.py`: aeon `MiniRocketMultivariate` (or `MultiRocketMultivariate`) + `RidgeClassifierCV`.
- `silent/models/cnn.py`: tiny 1D CNN (2 to 3 conv blocks, global pooling), augmentation (time warp, scaling, jitter, shift), early stopping. Seeded.
- `silent/bench.py`: `uv run python -m silent.bench --model dtw-py|minirocket|cnn --protocol loo|loso --data <files...>` → `ml/results/<model>/<protocol>.json` (the `Metrics` schema in `PROTOCOL.md` §6, `model` field = model name) + `confusion_<protocol>.png`.
- `silent/report.py`: reads every `ml/results/*/*.json` (including `dtw-knn` from JS) → `ml/RESULTS.md` table (model × protocol: accuracy, macro F1, none false accept, infer ms) + confusion images.
- Use `../shared/fixtures/dataset.synthetic.json` as the default dev dataset.

## Gate
- `cd ml && uv run pytest` green: preprocessing matches a few hand checked values; high pass kills 0.2 Hz; splitters never leak a session in LOSO.
- On the synthetic fixture: all available models ≥ 0.9 LOSO. Results JSON + RESULTS.md written.
- Report the `dtw-py` LOO/LOSO numbers so the lead can compare with JS `dtw-knn` (must agree within 5 points).
