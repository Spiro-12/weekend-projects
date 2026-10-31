# Silent Speech: model benchmark

Made by `uv run python -m silent.report` from `ml/results/*/*.json`. Don't edit by hand.

- **LOO** = leave one clip out. **LOSO** = leave one session out (train on the other sessions, test on a
  new one: closest to real use, so the number that matters).
- **None false accept** = share of true `none` clips the model accepted as an action
  (label is not `none` and confidence >= threshold).
- **Infer ms** = per clip, preprocessing + predict, one clip at a time. JS (`dtw-knn`) is timed by its own runner.

| Model | Protocol | Clips | Accuracy | Macro F1 | None false accept | Infer ms/clip | Data |
|---|---|---:|---:|---:|---:|---:|---|
| dtw-py | LOO | 120 | 99.2% | 0.992 | 0.0% | 13.8 | `shared/fixtures/dataset.synthetic.json` |
| dtw-py | LOSO | 120 | 96.7% | 0.968 | 0.0% | 6.7 | `shared/fixtures/dataset.synthetic.json` |
| minirocket | LOO | 120 | 98.3% | 0.983 | 0.0% | 5.0 | `shared/fixtures/dataset.synthetic.json` |
| minirocket | LOSO | 120 | 99.2% | 0.992 | 0.0% | 10.0 | `shared/fixtures/dataset.synthetic.json` |
| cnn | LOO | 120 | 98.3% | 0.984 | 0.0% | 1.3 | `shared/fixtures/dataset.synthetic.json` |
| cnn | LOSO | 120 | 97.5% | 0.975 | 0.0% | 0.6 | `shared/fixtures/dataset.synthetic.json` |

Best LOO: **dtw-py** (99.2%).  
Best LOSO: **minirocket** (99.2%).  

## JS vs Python DTW cross check

Needs both `results/dtw-knn/` (JS, `scripts/eval-dtw.ts`) and `results/dtw-py/` for the same protocol.

## Confusion matrices

Rows = true label, columns = predicted.

### dtw-py

![dtw-py loo](results/dtw-py/confusion_loo.png)

![dtw-py loso](results/dtw-py/confusion_loso.png)

### minirocket

![minirocket loo](results/minirocket/confusion_loo.png)

![minirocket loso](results/minirocket/confusion_loso.png)

### cnn

![cnn loo](results/cnn/confusion_loo.png)

![cnn loso](results/cnn/confusion_loso.png)
