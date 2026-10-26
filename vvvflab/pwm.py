"""Switching waveforms of a three-phase two-level SPWM inverter (natural sampling, sine-triangle comparison).

Conventions: voltages are in units of Vdc/2 and the pole voltage s_k is +1 or -1; the modulation index m is the ratio of the
reference amplitude to the triangle amplitude (m > 1 is overmodulation). The triangle is 0 and rising at fundamental phase 0, so for odd synchronous N the waveform has half-wave symmetry.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import NamedTuple

import numpy as np

TWO_PI = 2.0 * np.pi
SQRT3 = float(np.sqrt(3.0))
V1_SQUARE = 4.0 / np.pi  # fundamental amplitude of the pole voltage of a six-step square wave
M_CAP = 20.0  # upper limit of the reference amplitude in overmodulation (any larger is the same as a square wave)

# phase offset of the three references relative to phase a (rad), shape (3, 1)
PHASE_SHIFTS = np.array([0.0, -TWO_PI / 3.0, TWO_PI / 3.0])[:, None]


@dataclass(frozen=True)
class OperatingPoint:
    """Operating point on the fast path: the modulation settings at one fundamental frequency."""

    f1: float  # fundamental frequency [Hz]
    kind: str = "async"  # "async" | "sync" | "square"
    fc: float = 0.0  # carrier frequency [Hz]; n*f1 for sync, f1 for square (only a pitch reference)
    n: int = 0  # synchronous carrier ratio (only meaningful for sync)
    m: float = 0.0  # reference amplitude / carrier amplitude
    v1: float = 0.0  # fundamental amplitude of the pole voltage [Vdc/2]


class Waveforms(NamedTuple):
    t: np.ndarray  # time (n,)
    theta1: np.ndarray  # fundamental phase (n,)
    tri: np.ndarray  # triangle carrier (n,)
    ref: np.ndarray  # three-phase reference (3, n)
    s: np.ndarray  # three-phase pole voltages (3, n), ±1
    va: np.ndarray  # phase-a motor phase voltage (n,)
    vab: np.ndarray  # ab line-to-line voltage (n,)


def triangle(theta):
    """Unit triangle wave, period 2π, 0 and rising at θ=0, range [-1, 1]."""
    return (2.0 / np.pi) * np.arcsin(np.sin(theta))


def pole_states(theta1, theta_c, m):
    """Pole-voltage states of the three legs, shape (3, n), values ±1.

    theta1 is the fundamental phase array, theta_c the carrier phase array; m may be a scalar or an array as long as theta1.
    """
    ref = np.asarray(m) * np.sin(theta1[None, :] + PHASE_SHIFTS)
    return np.where(ref > triangle(theta_c)[None, :], 1.0, -1.0)


def square_states(theta1):
    """Pole-voltage states of a six-step square wave (single pulse), shape (3, n).

    A 1e-9 rad bias keeps samples that fall exactly on a zero crossing off sin = 0, so the positive and negative half-cycles are strictly symmetric.
    """
    return np.where(np.sin(theta1[None, :] + PHASE_SHIFTS + 1e-9) > 0.0, 1.0, -1.0)


def phase_voltages(s):
    """Motor phase voltage (floating neutral): v_k = s_k - mean(s), shape (3, n)."""
    return s - s.mean(axis=0, keepdims=True)


def line_voltage(s):
    """Line-to-line voltage v_ab = s_a - s_b."""
    return s[0] - s[1]


def fundamental_from_reference(m):
    """Fundamental amplitude of the pole voltage for an infinite carrier ratio (units of Vdc/2).

    Equal to m for m ≤ 1; grows with overmodulation for m > 1 and approaches 4/π for a square wave.
    """
    m = np.asarray(m, dtype=float)
    over = m > 1.0
    mo = np.where(over, m, 2.0)  # placeholder so elements with m ≤ 1 do not trigger invalid operations
    v = (2.0 / np.pi) * (mo * np.arcsin(1.0 / mo) + np.sqrt(1.0 - 1.0 / mo**2))
    return np.where(over, v, np.minimum(m, 1.0))


_M_GRID = np.concatenate([np.linspace(1.0, 3.0, 400, endpoint=False), np.geomspace(3.0, M_CAP, 400)])
_V_GRID = fundamental_from_reference(_M_GRID)


def reference_for_fundamental(v1):
    """Invert the above: reference amplitude for a target fundamental amplitude; m = v1 for v1 ≤ 1, and m is capped at M_CAP as v1 approaches 4/π."""
    v1 = np.asarray(v1, dtype=float)
    return np.where(v1 <= 1.0, v1, np.interp(v1, _V_GRID, _M_GRID))


def make_point(f1, kind, m=0.0, fc=0.0, n=0):
    """Build an operating point for a modulation kind, filling in the carrier frequency and fundamental amplitude."""
    if kind == "square":
        return OperatingPoint(f1, "square", fc=f1, n=0, m=M_CAP, v1=V1_SQUARE)
    v1 = float(fundamental_from_reference(m))
    if kind == "sync":
        return OperatingPoint(f1, "sync", fc=n * f1, n=n, m=m, v1=v1)
    return OperatingPoint(f1, "async", fc=fc, n=0, m=m, v1=v1)


def simulate(op, fs, n, t0=0.0, carrier_phase=0.0):
    """Generate the switching waveform of operating point op on [t0, t0 + n/fs)."""
    t = t0 + np.arange(n) / fs
    th1 = TWO_PI * op.f1 * t
    if op.kind == "square":
        tri = np.zeros(n)
        ref = np.sin(th1[None, :] + PHASE_SHIFTS)
        s = square_states(th1)
    else:
        if op.kind == "sync":
            thc = op.n * th1 + carrier_phase
        else:
            thc = TWO_PI * op.fc * t + carrier_phase
        tri = triangle(thc)
        ref = op.m * np.sin(th1[None, :] + PHASE_SHIFTS)
        s = np.where(ref > tri[None, :], 1.0, -1.0)
    return Waveforms(t, th1, tri, ref, s, phase_voltages(s)[0], line_voltage(s))
