"""频谱工具：FFT 幅值谱、双重傅里叶（贝塞尔）解析谱线、短时傅里叶声谱图。"""
from __future__ import annotations

import numpy as np
from scipy.special import jv

from .pwm import SQRT3


def amplitude_spectrum(x, fs, window="rect"):
    """单边幅值谱，返回 (频率, 幅值)；幅值按窗的相干增益校正，单位与 x 相同。"""
    n = len(x)
    w = np.hanning(n) if window == "hann" else np.ones(n)
    amps = np.abs(np.fft.rfft(x * w)) * 2.0 / w.sum()
    amps[0] /= 2.0
    if n % 2 == 0:
        amps[-1] /= 2.0
    return np.fft.rfftfreq(n, 1.0 / fs), amps


def double_fourier_lines(m, fc, f1, line_to_line=True, m_max=3, n_max=30):
    """自然采样三相 SPWM 的谱线，返回 [(频率 Hz, 幅值 Vdc/2, 载波阶 k, 边带阶 n), ...]。

    只在线性区（m ≤ 1）成立。幅值公式：A = (4/(πk))·|J_n(kπm/2)|，线电压再乘 √3；
    要求 k+n 为奇数，线电压中 n 为 3 的倍数的谱线（含载波本身，n=0）相互抵消。
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
    """短时傅里叶幅值谱（dB，0 dB = 满幅 1.0）。

    返回 (times, freqs, db)，db 形状为 (n_freq, n_time)；样本不足一帧时返回空数组。
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
