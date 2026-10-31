import copy
import json
from collections import Counter

import pytest

from silent import DEFAULT_DATA
from silent.data import DatasetError, load_corpus, load_dataset, load_exclude, merge, validate_dataset
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


# ---------- bud (clip.loc ?? device.loc) ----------

def test_loc_falls_back_to_device_loc(tmp_path):
    d = load_dataset(TINY)
    d["device"]["loc"] = "right"
    d["clips"][1]["loc"] = "left"
    d["clips"][2]["loc"] = None  # like JS `??`: null falls back
    p = tmp_path / "d.json"
    p.write_text(json.dumps(d))
    c = load_corpus([p])
    assert [x.loc for x in c.clips[:3]] == ["right", "left", "right"]
    assert c.buds == {"s1": "mixed"}


def test_loc_unknown_when_device_has_none():
    d = load_dataset(TINY)
    del d["device"]["loc"]
    assert {c.loc for c in merge([d]).clips} == {"unknown"}
    d["device"]["loc"] = None
    assert validate_dataset(d) == []


@pytest.mark.parametrize("where", ["clip", "device"])
def test_bad_loc_is_rejected(where):
    d = load_dataset(TINY)
    (d["clips"][0] if where == "clip" else d["device"])["loc"] = "middle"
    assert any("loc" in e for e in validate_dataset(d))


def test_synthetic_is_left_bud(synthetic):
    assert synthetic.buds == {"s1": "left", "s2": "left", "s3": "left"} and synthetic.synthetic


# ---------- exclusion list (PROTOCOL §3) ----------

def _exclude_file(tmp_path, ids, **kw):
    p = tmp_path / "exclude.json"
    p.write_text(json.dumps({"format": "ss-exclude", "v": 1, "reason": "test", "ids": ids, **kw}))
    return p


def test_exclude_drops_ids_after_dedupe(tmp_path, synthetic):
    ids = [synthetic.clips[0].id, synthetic.clips[50].id, "not-in-the-data"]
    c = load_corpus([DEFAULT_DATA, DEFAULT_DATA], exclude=_exclude_file(tmp_path, ids))
    assert len(c.clips) == 118 and c.duplicates == 120
    assert c.excluded == ids[:2] and c.exclude_ids == ids  # unmatched ids are fine (a list covers many files)
    assert c.excluded_by_session == dict(sorted(Counter(synthetic.clips[i].session for i in (0, 50)).items()))
    assert not {x.id for x in c.clips} & set(ids)
    assert c.exclude_file.endswith("exclude.json")


@pytest.mark.parametrize("body", [{"format": "nope", "v": 1, "ids": []}, {"format": "ss-exclude", "v": 2, "ids": []},
                                  {"format": "ss-exclude", "v": 1, "ids": [1]}, {"format": "ss-exclude", "v": 1}])
def test_bad_exclude_file_raises(tmp_path, body):
    p = tmp_path / "x.json"
    p.write_text(json.dumps(body))
    with pytest.raises(DatasetError):
        load_exclude(p)


def test_select():
    c = load_corpus([DEFAULT_DATA])
    s = c.select(sessions=["s2"], labels=["help", "none"])
    assert {x.session for x in s.clips} == {"s2"} and {x.label for x in s.clips} == {"help", "none"}
    assert len(c.clips) == 120  # the original is untouched


# ---------- Spiro's real recordings (data/raw): only loading, no training ----------

def test_real_data_loads_as_documented(real):
    assert len(real.clips) == 342  # 3 x 120 minus 18 excluded
    assert real.buds == {"s1": "right", "s2": "left", "s3": "left"}  # data/raw/README.md
    assert real.excluded_by_session == {"s1": 15, "s2": 3}
    assert len(real.exclude_ids) == len(real.excluded) == 18  # every id in the list exists
    assert real.sources == ["airpods"] and real.subjects == ["spiro"] and not real.synthetic
    assert {x.label for x in real.clips if x.session == "s1"} == set(real.labels) - {"none"}  # all of s1's none takes are out
