import math

import numpy as np
import pytest

from vvvflab.modes import PRESETS, ModeMap, Segment, synthesize
from vvvflab.pwm import M_CAP, V1_SQUARE


def test_gto_preset_follows_the_documented_generation_rule():
    segs = PRESETS["gto"].segments
    assert [s.kind for s in segs] == ["async"] + ["sync"] * 5 + ["square"]
    assert [s.n for s in segs if s.kind == "sync"] == [27, 21, 15, 9, 3]
    assert segs[0].fc == pytest.approx(273.0)
    assert [s.f_end for s in segs[:-1]] == pytest.approx([10.11, 15.56, 20.0, 28.0, 46.67, 60.0], abs=0.01)


def test_igbt_preset_follows_the_documented_generation_rule():
    segs = PRESETS["igbt"].segments
    assert [s.kind for s in segs] == ["async", "sync", "sync", "square"]
    assert [s.n for s in segs if s.kind == "sync"] == [27, 21]
    assert segs[0].fc == pytest.approx(975.0)
    assert [s.f_end for s in segs[:-1]] == pytest.approx([36.11, 55.56, 60.0], abs=0.01)


@pytest.mark.parametrize("key,f_max", [("gto", 420.0), ("igbt", 1500.0)])
def test_presets_are_valid_and_respect_the_device_limit(key, f_max):
    mm = PRESETS[key]
    assert mm.check(f_max) == []
    for f1 in np.linspace(0.0, 59.9, 600):
        assert mm.carrier_hz(f1) <= f_max * (1 + 1e-9)


@pytest.mark.parametrize("key", ["gto", "igbt"])
def test_carrier_is_continuous_where_async_hands_over_to_sync(key):
    segs = PRESETS[key].segments
    assert segs[1].carrier_at(segs[1].f_start) == pytest.approx(segs[0].fc, rel=1e-9)


def test_pulse_numbers_only_decrease_with_speed():
    ns = [s.n for s in PRESETS["gto"].segments if s.kind == "sync"]
    assert ns == sorted(ns, reverse=True) and len(set(ns)) == len(ns)


def test_modulation_index_rises_monotonically_and_saturates():
    mm = PRESETS["gto"]
    ms = [mm.operating_point(f).m for f in np.linspace(0.0, 100.0, 1001)]
    assert all(b >= a - 1e-12 for a, b in zip(ms, ms[1:]))
    assert mm.operating_point(mm.f_base).m == pytest.approx(1.0)
    assert mm.operating_point(mm.f_square).kind == "square"
    assert mm.operating_point(mm.f_square).m == M_CAP
    assert mm.operating_point(mm.f_square - 1e-6).v1 == pytest.approx(V1_SQUARE, abs=2e-3)


def test_fundamental_follows_the_v_over_f_target():
    mm = PRESETS["gto"]
    for f1 in (5.0, 20.0, mm.f_base, 50.0, 55.0):
        assert mm.operating_point(f1).v1 == pytest.approx(mm.v1_target(f1), abs=1e-3)


def test_operating_point_carries_the_segment_strategy():
    mm = PRESETS["gto"]
    low = mm.operating_point(5.0)
    assert (low.kind, low.fc) == ("async", pytest.approx(273.0))
    mid = mm.operating_point(24.0)
    assert (mid.kind, mid.n, mid.fc) == ("sync", 15, pytest.approx(360.0))
    assert mm.operating_point(100.0).kind == "square"


def test_check_reports_bad_tables():
    good = Segment(0.0, 20.0, "sync", n=9)
    tail = Segment(20.0, math.inf, "square")
    assert ModeMap((good, tail), f_base=16.0).check() == []
    assert any("N = 10" in p for p in ModeMap((Segment(0.0, 20.0, "sync", n=10), tail), 16.0).check())
    assert any("N = 12" in p for p in ModeMap((Segment(0.0, 20.0, "sync", n=12), tail), 16.0).check())
    gap = ModeMap((good, Segment(25.0, math.inf, "square")), f_base=16.0)
    assert any("不连续" in p for p in gap.check())
    assert any("超过器件上限" in p for p in ModeMap((good, tail), 16.0).check(f_max=100.0))
    assert any("方波" in p for p in ModeMap((good,), 16.0).check())


def test_synthesize_handles_a_very_low_limit_without_gaps():
    mm = synthesize(100.0)
    assert [p for p in mm.check() if "不连续" in p] == []
    assert mm.segments[-1].kind == "square"


def test_polyline_has_one_gap_per_segment():
    x, y = PRESETS["gto"].polyline()
    assert np.isnan(x).sum() == len(PRESETS["gto"].segments) == np.isnan(y).sum()
