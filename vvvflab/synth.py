"""Real-time sound synthesis: switching waveform → current ripple (proxy) → audio.

Sound model (assumption A of P1): the magnetic exciting force is proportional to the current harmonics, and the audible frequency equals the harmonic frequency.
The motor leakage inductance turns the switching voltage into current ripple: i_rip ∝ ∫(v - v1) dt, where v1 is the fundamental (equivalent to the back-EMF).
So that the carrier edges can fall between audio samples, the switching waveform is generated point by point at oversample times the sample rate and then decimated.
"""
from __future__ import annotations

import numpy as np
from scipy import signal

from .pwm import TWO_PI, OperatingPoint, pole_states, square_states


class DriveSynth:
    """Turns an operating point into audio blocks. set_target may be called from any thread; render is called from the audio callback."""

    def __init__(
        self, fs=48000, oversample=4, hpf_hz=100.0, leak_hz=20.0, ripple_gain=1200.0, ring_seconds=8.0, soft_start=True
    ):
        self.fs = int(fs)
        self.os = int(oversample)
        fs_os = self.fs * self.os
        dt = 1.0 / fs_os
        self._dt = dt
        alpha = np.exp(-TWO_PI * leak_hz * dt)  # leaky integrator, avoids DC drift
        self._int_b = np.array([ripple_gain * dt])
        self._int_a = np.array([1.0, -alpha])
        self._zi_int = np.zeros(1)
        self._fir = signal.firwin(127, 0.45 * self.fs, fs=fs_os)  # anti-aliasing before decimation
        self._zi_fir = np.zeros(len(self._fir) - 1)
        self._sos = signal.butter(2, hpf_hz, "highpass", fs=self.fs, output="sos")
        self._zi_sos = np.zeros((self._sos.shape[0], 2))
        self._theta1 = 0.0
        self._theta_c = 0.0
        self._target: OperatingPoint | None = None
        self._cur: OperatingPoint | None = None
        self._volume = 0.5
        self._gain = 0.0 if soft_start else self._volume  # soft_start=False skips the initial volume fade-in (for tests)
        self.ring = np.zeros(int(ring_seconds * self.fs), dtype=np.float32)
        self._wpos = 0

    def set_target(self, op):
        if self._cur is None:
            self._cur = op
        self._target = op

    def set_volume(self, volume):
        self._volume = float(np.clip(volume, 0.0, 1.0))

    def recent(self, seconds):
        """The most recent `seconds` of output (in time order, a copy), used to draw the spectrogram."""
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
        """Generate `frames` mono samples (float32, amplitude at most 1)."""
        op, cur = self._target, self._cur
        if op is None:
            out = np.zeros(frames, dtype=np.float32)
            self._push(out)
            return out
        n = frames * self.os
        ramp = np.arange(1, n + 1) / n  # linear transition within the block, avoids clicks from parameter jumps

        def lerp(a, b):
            return a + (b - a) * ramp

        f1 = lerp(cur.f1, op.f1)
        v1 = lerp(cur.v1, op.v1)
        th1 = self._theta1 + TWO_PI * np.cumsum(f1) * self._dt
        if op.kind == "square":
            s = square_states(th1)
        else:
            if op.kind == "sync":
                # keep the carrier phase continuous: when shifting, only N changes and the carrier phase must not jump
                thc = op.n * th1 + (self._theta_c - op.n * self._theta1)
            else:
                thc = self._theta_c + TWO_PI * np.cumsum(lerp(cur.fc, op.fc)) * self._dt
            s = pole_states(th1, thc, lerp(cur.m, op.m))
            self._theta_c = float(thc[-1] % TWO_PI)
        self._theta1 = float(th1[-1] % TWO_PI)
        self._cur = op

        va = s[0] - s.mean(axis=0)  # phase-a motor phase voltage
        u = va - v1 * np.sin(th1)  # subtract the fundamental, leaving the switching harmonics
        y, self._zi_int = signal.lfilter(self._int_b, self._int_a, u, zi=self._zi_int)
        y, self._zi_fir = signal.lfilter(self._fir, [1.0], y, zi=self._zi_fir)
        y = y[self.os - 1 :: self.os]
        y, self._zi_sos = signal.sosfilt(self._sos, y, zi=self._zi_sos)

        gain_target = 0.0 if op.f1 < 0.5 else self._volume  # the inverter does not switch when the train is stopped, so no sound
        g = self._gain + (gain_target - self._gain) * (np.arange(1, frames + 1) / frames)
        self._gain = gain_target
        out = (g * np.tanh(y)).astype(np.float32)
        self._push(out)
        return out
