import numpy as np
import pytest
from scipy.special import jv

from vvvflab.pwm import make_point, simulate
from vvvflab.spectrum import amplitude_spectrum, double_fourier_lines, spectrogram_db

CARRIER_PHASE = 1e-6


def one_cycle(n, m, f1=50.0, samples_per_carrier=6000):
    """时域采样把开关边沿量化到采样网格上，谱线误差与每个载波周期的采样点数成反比。"""
    spc = n * samples_per_carrier
    w = simulate(make_point(f1, "sync", m=m, n=n), spc * f1, spc, carrier_phase=CARRIER_PHASE)
    return spc, w


def strong_lines(m, n, f1, line_to_line, **kw):
    """幅值高于 -40 dBc（相对基波）的解析谱线。"""
    fund = (np.sqrt(3.0) if line_to_line else 1.0) * m
    lines = double_fourier_lines(m, n * f1, f1, line_to_line=line_to_line, **kw)
    return [line for line in lines if line[1] >= fund * 10 ** (-40 / 20)]


def test_amplitude_spectrum_is_calibrated():
    fs, n = 10000, 10000
    t = np.arange(n) / fs
    x = 0.7 * np.sin(2 * np.pi * 100 * t) + 0.2
    _, a = amplitude_spectrum(x, fs)
    assert a[100] == pytest.approx(0.7, rel=1e-9) and a[0] == pytest.approx(0.2, rel=1e-9)
    _, a = amplitude_spectrum(x, fs, "hann")
    assert a[100] == pytest.approx(0.7, rel=2e-3)


def test_line_voltage_lines_match_double_fourier_series():
    n, f1, m = 27, 50.0, 0.8
    spc, w = one_cycle(n, m, f1)
    freqs, amps = amplitude_spectrum(w.vab, spc * f1)
    lines = strong_lines(m, n, f1, True, m_max=3, n_max=40)
    assert len(lines) >= 8
    for f, a, k, nn in lines:
        idx = int(round(f / f1))
        assert freqs[idx] == pytest.approx(f, abs=1e-6)
        assert amps[idx] == pytest.approx(a, rel=0.01), (k, nn)


def test_pole_voltage_lines_match_double_fourier_series():
    n, f1, m = 27, 50.0, 0.6
    spc, w = one_cycle(n, m, f1)
    _, amps = amplitude_spectrum(w.s[0], spc * f1)
    lines = strong_lines(m, n, f1, False, m_max=2, n_max=20)
    assert len(lines) >= 6
    for f, a, k, nn in lines:
        assert amps[int(round(f / f1))] == pytest.approx(a, rel=0.01), (k, nn)


def test_carrier_line_cancels_in_line_voltage_but_not_in_pole_voltage():
    n, m, f1 = 27, 0.8, 50.0
    spc, w = one_cycle(n, m, f1)
    pole = np.abs(np.fft.rfft(w.s[0])) * 2.0 / spc
    line = np.abs(np.fft.rfft(w.vab)) * 2.0 / spc
    assert pole[n] == pytest.approx(4.0 / np.pi * jv(0, np.pi * m / 2.0), rel=0.02)
    assert line[n] < 1e-6


def test_triplen_harmonics_cancel_in_line_voltage_when_n_is_multiple_of_3():
    spc, w = one_cycle(9, 0.8)
    x = np.abs(np.fft.rfft(w.vab)) * 2.0 / spc
    assert all(x[k] < 1e-6 for k in range(3, 60, 3))


def test_line_selection_rules():
    for f, a, k, n in double_fourier_lines(0.8, 1000.0, 50.0, line_to_line=True):
        assert (k + n) % 2 == 1 and n % 3 != 0 and a >= 0.0 and f >= 0.0


def test_spectrogram_peak_level_and_frequency():
    fs, nperseg = 48000, 2048
    f0 = 40 * fs / nperseg  # 正好落在 bin 中心
    t = np.arange(fs) / fs
    x = 0.5 * np.sin(2 * np.pi * f0 * t)
    times, freqs, db = spectrogram_db(x, fs, nperseg=nperseg, hop=512, fmax=5000.0)
    assert db.shape == (len(freqs), len(times))
    k = int(np.argmax(db[:, 5]))
    assert freqs[k] == pytest.approx(f0, abs=1e-6)
    assert db[k, 5] == pytest.approx(20 * np.log10(0.5), abs=0.2)


def test_spectrogram_of_short_signal_is_empty():
    times, freqs, db = spectrogram_db(np.zeros(100), 48000)
    assert len(times) == 0 and db.shape[1] == 0
