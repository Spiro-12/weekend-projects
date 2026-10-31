import copy
import json

import pytest

from silent import DEFAULT_DATA
from silent.data import DatasetError, load_corpus, load_dataset, merge, validate_dataset
from tests.conftest import TINY


def test_load_synthetic(synthetic):
    assert len(synthetic.clips) == 120
    assert synthetic.sessions == ["s1", "s2", "s3"]
    assert synthetic.labels == ["calendar", "call_back", "demo_48h", "focus_music", "help", "none", "text_mom", "volume_up"]
    assert synthetic.duplicates == 0
    assert synthetic.sources == ["fake"] and synthetic.subjects == ["synthetic"]


def test_merge_dedupes_by_clip_id_first_wins():
    d = load_dataset(TINY)
    d2 = copy.deepcopy(d)
    d2["clips"][0]["label"] = "none"  # same id, different content: the first copy is kept
    c = merge([d, d2])
    assert len(c.clips) == len(d["clips"])
    assert c.duplicates == len(d["clips"])
    assert c.clips[0].label == d["clips"][0]["label"]


def test_loading_the_same_file_twice_dedupes():
    c = load_corpus([DEFAULT_DATA, DEFAULT_DATA])
    assert len(c.clips) == 120 and c.duplicates == 120


def test_session_falls_back_to_file_session_like_js_nullish(tmp_path):
    d = load_dataset(TINY)
    d["session"] = "file-session"
    del d["clips"][0]["session"]
    d["clips"][1]["session"] = "override"
    d["clips"][2]["session"] = ""  # JS `c.session ?? d.session` keeps an empty string
    d["clips"][3]["session"] = None  # ... and replaces null
    p = tmp_path / "d.json"
    p.write_text(json.dumps(d))
    c = load_corpus([p])
    assert [x.session for x in c.clips[:4]] == ["file-session", "override", "", "file-session"]


def test_merge_two_files_keeps_both_sessions(tmp_path):
    d = load_dataset(TINY)
    d2 = copy.deepcopy(d)
    for c in d2["clips"]:
        c["id"] = "b-" + c["id"]
        c["session"] = "s2"
    p = tmp_path / "b.json"
    p.write_text(json.dumps(d2))
    c = load_corpus([TINY, p])
    assert len(c.clips) == 2 * len(d["clips"])
    assert c.sessions == ["s1", "s2"]


@pytest.mark.parametrize(
    "mutate, msg",
    [
        (lambda d: d.update(format="nope"), "format"),
        (lambda d: d.update(v=2), "v must be 1"),
        (lambda d: d["clips"][0].update(label="mystery"), "unknown label"),
        (lambda d: d["clips"][0].update(samples=[]), "at least 2 samples"),
        (lambda d: d["clips"][0]["samples"][0].update(rr=[0, 0]), "samples invalid"),
        (lambda d: d.pop("clips"), "clips must be an array"),
    ],
)
def test_validation_rejects_broken_files(mutate, msg):
    d = load_dataset(TINY)
    mutate(d)
    errs = validate_dataset(d)
    assert any(msg in e for e in errs), errs


def test_bad_file_raises(tmp_path):
    p = tmp_path / "x.json"
    p.write_text("{not json")
    with pytest.raises(DatasetError):
        load_corpus([p])
    with pytest.raises(DatasetError):
        load_corpus([])
