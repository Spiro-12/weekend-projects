import pytest

from silent.metrics import METRICS_KEYS, compute_metrics, validate_metrics
from silent.models import Pred


def P(label, conf=1.0):
    return Pred(label, conf, [(label, conf)])


def test_hand_checked_metrics():
    y = ["a", "a", "b", "none", "none"]
    preds = [P("a"), P("b"), P("b"), P("a", 0.9), P("none")]
    m = compute_metrics("x", "loo", y, preds, 0.5, {"k": 3}, 1.5)
    assert set(m) == set(METRICS_KEYS)
    assert m["labels"] == ["a", "b", "none"]
    assert m["confusion"] == [[1, 1, 0], [0, 1, 0], [1, 0, 1]]  # rows true, cols predicted
    assert m["accuracy"] == pytest.approx(3 / 5)
    # F1 = 2tp / (2tp + fp + fn): a 2/4, b 2/3, none 2/3
    assert m["macroF1"] == pytest.approx((0.5 + 2 / 3 + 2 / 3) / 3)
    assert m["noneFalseAcceptRate"] == pytest.approx(0.5)  # 1 of 2 none clips fired an action
    assert m["nClips"] == 5 and m["inferMsPerClip"] == 1.5
    assert m["generatedAt"].endswith("Z")
    assert validate_metrics(m) == []


def test_low_confidence_is_not_a_false_accept():
    m = compute_metrics("x", "loo", ["none"], [P("a", 0.49)], 0.5, {}, 0)
    assert m["noneFalseAcceptRate"] == 0
    m = compute_metrics("x", "loo", ["none"], [P("a", 0.5)], 0.5, {}, 0)
    assert m["noneFalseAcceptRate"] == 1


def test_validate_metrics_catches_problems():
    m = compute_metrics("x", "loso", ["a"], [P("a")], 0.5, {}, 0)
    assert validate_metrics({**m, "protocol": "kfold"})
    assert validate_metrics({**m, "confusion": [[1, 0]]})
    assert validate_metrics({**m, "nClips": 3})
    assert validate_metrics({k: v for k, v in m.items() if k != "macroF1"}) == ["missing macroF1"]


def test_labels_sorted_union_of_true_and_predicted_like_js():
    y = ["volume_up", "none", "calendar"]
    preds = [P("volume_up"), P("help"), P("calendar")]  # "help" is only predicted
    m = compute_metrics("x", "loso", y, preds, 0.5, {}, 0)
    assert m["labels"] == ["calendar", "help", "none", "volume_up"]
    assert m["confusion"][2] == [0, 1, 0, 0]  # true none -> predicted help
    # macro F1 over all 4 labels (help and none score 0), like sklearn / the JS metricsFrom
    assert m["macroF1"] == 0.5
