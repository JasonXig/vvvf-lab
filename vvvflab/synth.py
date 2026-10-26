"""实时声音合成：开关波形 → 电流纹波（代理量）→ 音频。

声音模型（P1 的假设 A）：磁励力正比于电流谐波，可听频率等于谐波频率。
电机漏感把开关电压变成电流纹波：i_rip ∝ ∫(v - v1) dt，其中 v1 是基波（等价于反电势）。
为了让载波边沿落在音频采样点之间，先在 oversample 倍的采样率上逐点生成开关波形，再抽取。
"""
from __future__ import annotations

import numpy as np
from scipy import signal

from .pwm import TWO_PI, OperatingPoint, pole_states, square_states


class DriveSynth:
    """把工作点变成音频块。set_target 可在任意线程调用，render 在音频回调里调用。"""

    def __init__(
        self, fs=48000, oversample=4, hpf_hz=100.0, leak_hz=20.0, ripple_gain=1200.0, ring_seconds=8.0, soft_start=True
    ):
        self.fs = int(fs)
        self.os = int(oversample)
        fs_os = self.fs * self.os
        dt = 1.0 / fs_os
        self._dt = dt
        alpha = np.exp(-TWO_PI * leak_hz * dt)  # 带泄漏的积分器，避免直流漂移
        self._int_b = np.array([ripple_gain * dt])
        self._int_a = np.array([1.0, -alpha])
        self._zi_int = np.zeros(1)
        self._fir = signal.firwin(127, 0.45 * self.fs, fs=fs_os)  # 抽取前的抗混叠
        self._zi_fir = np.zeros(len(self._fir) - 1)
        self._sos = signal.butter(2, hpf_hz, "highpass", fs=self.fs, output="sos")
        self._zi_sos = np.zeros((self._sos.shape[0], 2))
        self._theta1 = 0.0
        self._theta_c = 0.0
        self._target: OperatingPoint | None = None
        self._cur: OperatingPoint | None = None
        self._volume = 0.5
        self._gain = 0.0 if soft_start else self._volume  # soft_start=False 时跳过起始的音量渐入（测试用）
        self.ring = np.zeros(int(ring_seconds * self.fs), dtype=np.float32)
        self._wpos = 0

    def set_target(self, op):
        if self._cur is None:
            self._cur = op
        self._target = op

    def set_volume(self, volume):
        self._volume = float(np.clip(volume, 0.0, 1.0))

    def recent(self, seconds):
        """最近 seconds 秒的输出（按时间顺序，副本），用于画声谱图。"""
        w, size = self._wpos, len(self.ring)
        n = min(int(seconds * self.fs), size, w)
        return self.ring[np.arange(w - n, w) % size].copy()

    def _push(self, x):
        size, n = len(self.ring), len(x)
        i = self._wpos % size
        if i + n <= size:
            self.ring[i : i + n] = x
        else:
            k = size - i
            self.ring[i:] = x[:k]
            self.ring[: n - k] = x[k:]
        self._wpos += n

    def render(self, frames):
        """生成 frames 个单声道样本（float32，幅度不超过 1）。"""
        op, cur = self._target, self._cur
        if op is None:
            out = np.zeros(frames, dtype=np.float32)
            self._push(out)
            return out
        n = frames * self.os
        ramp = np.arange(1, n + 1) / n  # 块内线性过渡，避免参数跳变产生的咔嗒声

        def lerp(a, b):
            return a + (b - a) * ramp

        f1 = lerp(cur.f1, op.f1)
        v1 = lerp(cur.v1, op.v1)
        th1 = self._theta1 + TWO_PI * np.cumsum(f1) * self._dt
        if op.kind == "square":
            s = square_states(th1)
        else:
            if op.kind == "sync":
                # 保持载波相位连续：换挡时只改变 N，不让载波相位跳变
                thc = op.n * th1 + (self._theta_c - op.n * self._theta1)
            else:
                thc = self._theta_c + TWO_PI * np.cumsum(lerp(cur.fc, op.fc)) * self._dt
            s = pole_states(th1, thc, lerp(cur.m, op.m))
            self._theta_c = float(thc[-1] % TWO_PI)
        self._theta1 = float(th1[-1] % TWO_PI)
        self._cur = op

        va = s[0] - s.mean(axis=0)  # a 相电机相电压
        u = va - v1 * np.sin(th1)  # 减去基波，剩下开关谐波
        y, self._zi_int = signal.lfilter(self._int_b, self._int_a, u, zi=self._zi_int)
        y, self._zi_fir = signal.lfilter(self._fir, [1.0], y, zi=self._zi_fir)
        y = y[self.os - 1 :: self.os]
        y, self._zi_sos = signal.sosfilt(self._sos, y, zi=self._zi_sos)

        gain_target = 0.0 if op.f1 < 0.5 else self._volume  # 停车时逆变器不开关，无声
        g = self._gain + (gain_target - self._gain) * (np.arange(1, frames + 1) / frames)
        self._gain = gain_target
        out = (g * np.tanh(y)).astype(np.float32)
        self._push(out)
        return out
