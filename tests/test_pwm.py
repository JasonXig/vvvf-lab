import numpy as np
import pytest

from vvvflab.pwm import (
    M_CAP,
    V1_SQUARE,
    fundamental_from_reference,
    line_voltage,
    make_point,
    phase_voltages,
    reference_for_fundamental,
    simulate,
    triangle,
)

CARRIER_PHASE = 1e-6  # 避开参考波与载波恰好相等的并列点


def one_cycle(n, m, f1=50.0, samples_per_carrier=300):
    """同步调制 N 的一个完整基波周期；每周期样本数是 3 的倍数，三相时移才落在整数样本上。"""
    spc = n * samples_per_carrier
    w = simulate(make_point(f1, "sync", m=m, n=n), spc * f1, spc, carrier_phase=CARRIER_PHASE)
    return spc, w


def test_triangle_shape():
    th = np.linspace(0.0, 4.0 * np.pi, 1001)
    assert np.all(np.abs(triangle(th)) <= 1.0 + 1e-12)
    assert triangle(0.0) == pytest.approx(0.0)
    assert triangle(np.pi / 2) == pytest.approx(1.0)
    assert triangle(3 * np.pi / 2) == pytest.approx(-1.0)
    assert np.allclose(triangle(th), triangle(th + 2.0 * np.pi))


@pytest.mark.parametrize("n", [3, 9, 15, 27])
def test_sync_pulse_count_per_cycle(n):
    _, w = one_cycle(n, 0.8)
    s = w.s[0]
    assert np.sum(np.roll(s, -1) > s) == n  # 每个载波周期一个脉冲


@pytest.mark.parametrize("n", [9, 15, 27])
def test_half_wave_symmetry_for_odd_n(n):
    spc, w = one_cycle(n, 0.7)
    s = w.s[0]
    assert np.array_equal(s, -np.roll(s, spc // 2))


def test_phases_are_time_shifted_when_n_is_multiple_of_3():
    spc, w = one_cycle(9, 0.8)
    assert np.mean(w.s[1] != np.roll(w.s[0], spc // 3)) < 1e-3
    assert np.mean(w.s[2] != np.roll(w.s[0], -spc // 3)) < 1e-3


def test_phases_are_not_shifted_when_n_is_not_multiple_of_3():
    spc, w = one_cycle(11, 0.8)
    assert np.mean(w.s[1] != np.roll(w.s[0], spc // 3)) > 0.01


def test_phase_voltages_sum_to_zero_and_match_line_voltage():
    _, w = one_cycle(15, 0.9)
    v = phase_voltages(w.s)
    assert np.allclose(v.sum(axis=0), 0.0)
    assert np.allclose(line_voltage(w.s), v[0] - v[1])


def test_fundamental_of_line_voltage_is_sqrt3_m():
    n, m = 51, 0.7
    spc, w = one_cycle(n, m, samples_per_carrier=200)
    x = np.fft.rfft(w.vab) * 2.0 / spc
    assert abs(x[1]) == pytest.approx(np.sqrt(3.0) * m, rel=0.01)


def test_square_wave_has_only_odd_harmonics_with_fundamental_4_over_pi():
    spc = 3000
    w = simulate(make_point(50.0, "square"), spc * 50.0, spc)
    x = np.abs(np.fft.rfft(w.s[0])) * 2.0 / spc
    assert x[1] == pytest.approx(V1_SQUARE, rel=1e-3)
    assert x[2] < 1e-9 and x[4] < 1e-9


def test_fundamental_from_reference_matches_numeric_integration():
    th = np.linspace(0.0, np.pi, 200001)
    for m in (1.2, 2.0, 5.0, 15.0):
        y = np.clip(m * np.sin(th), -1.0, 1.0) * np.sin(th)
        numeric = (2.0 / np.pi) * np.sum((y[1:] + y[:-1]) / 2.0 * np.diff(th))
        assert float(fundamental_from_reference(m)) == pytest.approx(numeric, rel=1e-4)


def test_reference_for_fundamental_round_trip():
    for m in (0.3, 1.0, 1.5, 3.0, 10.0):
        v = fundamental_from_reference(m)
        assert float(reference_for_fundamental(v)) == pytest.approx(m, rel=2e-3)
    assert float(reference_for_fundamental(V1_SQUARE)) <= M_CAP


def test_make_point_fills_carrier_and_fundamental():
    sync = make_point(40.0, "sync", m=0.5, n=15)
    assert sync.fc == pytest.approx(600.0) and sync.v1 == pytest.approx(0.5)
    asyn = make_point(40.0, "async", m=0.5, fc=450.0)
    assert asyn.fc == 450.0 and asyn.n == 0
    sq = make_point(80.0, "square")
    assert sq.v1 == pytest.approx(V1_SQUARE) and sq.fc == 80.0
