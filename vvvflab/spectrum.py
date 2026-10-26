"""Spectrum tools: FFT amplitude spectrum, double-Fourier (Bessel) analytic lines, short-time Fourier spectrogram."""
from __future__ import annotations

import numpy as np
from scipy.special import jv

from .pwm import SQRT3


def amplitude_spectrum(x, fs, window="rect"):
    """One-sided amplitude spectrum, returns (frequency, amplitude); the amplitude is corrected for the window's coherent gain and has the same unit as x."""
    n = len(x)
    w = np.hanning(n) if window == "hann" else np.ones(n)
    amps = np.abs(np.fft.rfft(x * w)) * 2.0 / w.sum()
    amps[0] /= 2.0
    if n % 2 == 0:
        amps[-1] /= 2.0
    return np.fft.rfftfreq(n, 1.0 / fs), amps


def double_fourier_lines(m, fc, f1, line_to_line=True, m_max=3, n_max=30):
    """Spectral lines of a naturally sampled three-phase SPWM, returns [(frequency Hz, amplitude Vdc/2, carrier order k, sideband order n), ...].

    Valid only in the linear region (m ≤ 1). Amplitude formula: A = (4/(πk))·|J_n(kπm/2)|, multiplied by √3 for the line voltage;
    k+n must be odd, and in the line voltage the lines whose n is a multiple of 3 (including the carrier itself, n=0) cancel.
    """
    scale = SQRT3 if line_to_line else 1.0
    lines = []
    for k in range(1, m_max + 1):
        for n in range(-n_max, n_max + 1):
            if (k + n) % 2 == 0:
                continue
            if line_to_line and n % 3 == 0:
                continue
            amp = scale * 4.0 / (np.pi * k) * abs(jv(n, k * np.pi * m / 2.0))
            lines.append((abs(k * fc + n * f1), float(amp), k, n))
    return lines


def spectrogram_db(x, fs, nperseg=2048, hop=512, fmax=5000.0, floor_db=-90.0):
    """Short-time Fourier amplitude spectrum (dB, 0 dB = full scale 1.0).

    Returns (times, freqs, db), db has shape (n_freq, n_time); returns empty arrays if there are fewer samples than one frame.
    """
    freqs = np.fft.rfftfreq(nperseg, 1.0 / fs)
    keep = freqs <= fmax
    if len(x) < nperseg:
        return np.zeros(0), freqs[keep], np.zeros((int(keep.sum()), 0))
    frames = np.lib.stride_tricks.sliding_window_view(x, nperseg)[::hop]
    w = np.hanning(nperseg)
    amp = np.abs(np.fft.rfft(frames * w, axis=1)) * 2.0 / w.sum()
    db = 20.0 * np.log10(np.maximum(amp[:, keep], 1e-9))
    times = (np.arange(frames.shape[0]) * hop + nperseg / 2) / fs
    return times, freqs[keep], np.maximum(db.T, floor_db)
