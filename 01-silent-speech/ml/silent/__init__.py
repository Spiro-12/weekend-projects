"""Silent Speech offline benchmark: same preprocessing as the JS app (PROTOCOL.md §5), then
DTW kNN (`dtw-py`), MiniRocket and a small 1D CNN scored with leave one out / leave one session out."""

from pathlib import Path

ML_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = ML_DIR.parent
RESULTS_DIR = ML_DIR / "results"
DEFAULT_DATA = PROJECT_DIR / "shared" / "fixtures" / "dataset.synthetic.json"
NONE = "none"
