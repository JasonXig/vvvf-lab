"""三相两电平 SPWM 的开关波形（自然采样，正弦–三角比较）。

约定：电压以 Vdc/2 为单位，极电压 s_k 取 +1 或 -1；调制比 m 是参考波幅值与三角载波幅值之比
（m > 1 即过调制）。三角载波在基波相位为 0 时为 0 并上升，所以同步调制的 N 取奇数时波形半波对称。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import NamedTuple

import numpy as np

TWO_PI = 2.0 * np.pi
SQRT3 = float(np.sqrt(3.0))
V1_SQUARE = 4.0 / np.pi  # 六阶梯方波的极电压基波幅值
M_CAP = 20.0  # 过调制时参考波幅值的上限（再大就等同于方波）

# 三相参考波相对 a 相的相位偏移 (rad)，形状 (3, 1)
PHASE_SHIFTS = np.array([0.0, -TWO_PI / 3.0, TWO_PI / 3.0])[:, None]


@dataclass(frozen=True)
class OperatingPoint:
    """快通道的工作点：某个基波频率下的调制设置。"""

    f1: float  # 基波频率 [Hz]
    kind: str = "async"  # "async" | "sync" | "square"
    fc: float = 0.0  # 载波频率 [Hz]；sync 时为 n*f1，square 时取 f1（仅作音调参考）
    n: int = 0  # 同步载波比（仅 sync 有意义）
    m: float = 0.0  # 参考波幅值 / 载波幅值
    v1: float = 0.0  # 极电压基波幅值 [Vdc/2]


class Waveforms(NamedTuple):
    t: np.ndarray  # 时间 (n,)
    theta1: np.ndarray  # 基波相位 (n,)
    tri: np.ndarray  # 三角载波 (n,)
    ref: np.ndarray  # 三相参考波 (3, n)
    s: np.ndarray  # 三相极电压 (3, n)，±1
    va: np.ndarray  # a 相电机相电压 (n,)
    vab: np.ndarray  # ab 线电压 (n,)


def triangle(theta):
    """单位三角波，周期 2π，θ=0 时为 0 并上升，值域 [-1, 1]。"""
    return (2.0 / np.pi) * np.arcsin(np.sin(theta))


def pole_states(theta1, theta_c, m):
    """三相桥臂的极电压状态，形状 (3, n)，取值 ±1。

    theta1 是基波相位数组，theta_c 是载波相位数组，m 可以是标量或与 theta1 等长的数组。
    """
    ref = np.asarray(m) * np.sin(theta1[None, :] + PHASE_SHIFTS)
    return np.where(ref > triangle(theta_c)[None, :], 1.0, -1.0)


def square_states(theta1):
    """六阶梯方波（单脉冲）的极电压状态，形状 (3, n)。

    加 1e-9 rad 的偏置，使恰好过零的采样点不再落在 sin = 0 上，正负半周才严格对称。
    """
    return np.where(np.sin(theta1[None, :] + PHASE_SHIFTS + 1e-9) > 0.0, 1.0, -1.0)


def phase_voltages(s):
    """电机相电压（中性点悬空）：v_k = s_k - mean(s)，形状 (3, n)。"""
    return s - s.mean(axis=0, keepdims=True)


def line_voltage(s):
    """ab 线电压 v_ab = s_a - s_b。"""
    return s[0] - s[1]


def fundamental_from_reference(m):
    """载波比趋于无穷时的极电压基波幅值（单位 Vdc/2）。

    m ≤ 1 时等于 m；m > 1 时随过调制增大，趋于方波的 4/π。
    """
    m = np.asarray(m, dtype=float)
    over = m > 1.0
    mo = np.where(over, m, 2.0)  # 占位值，避免对 m ≤ 1 的元素做无效运算
    v = (2.0 / np.pi) * (mo * np.arcsin(1.0 / mo) + np.sqrt(1.0 - 1.0 / mo**2))
    return np.where(over, v, np.minimum(m, 1.0))


_M_GRID = np.concatenate([np.linspace(1.0, 3.0, 400, endpoint=False), np.geomspace(3.0, M_CAP, 400)])
_V_GRID = fundamental_from_reference(_M_GRID)


def reference_for_fundamental(v1):
    """由目标基波幅值反求参考波幅值：v1 ≤ 1 时 m = v1，趋近 4/π 时 m 取上限 M_CAP。"""
    v1 = np.asarray(v1, dtype=float)
    return np.where(v1 <= 1.0, v1, np.interp(v1, _V_GRID, _M_GRID))


def make_point(f1, kind, m=0.0, fc=0.0, n=0):
    """按调制方式构造工作点，自动填好载波频率和基波幅值。"""
    if kind == "square":
        return OperatingPoint(f1, "square", fc=f1, n=0, m=M_CAP, v1=V1_SQUARE)
    v1 = float(fundamental_from_reference(m))
    if kind == "sync":
        return OperatingPoint(f1, "sync", fc=n * f1, n=n, m=m, v1=v1)
    return OperatingPoint(f1, "async", fc=fc, n=0, m=m, v1=v1)


def simulate(op, fs, n, t0=0.0, carrier_phase=0.0):
    """在 [t0, t0 + n/fs) 上生成工作点 op 的开关波形。"""
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
