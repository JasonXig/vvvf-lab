"""模式表：按基波频率分段的调制策略，以及按器件开关上限生成默认模式表的规则。"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

from .pwm import V1_SQUARE, OperatingPoint, make_point, reference_for_fundamental

HZ_PER_KMH = 1.2  # 演示用的换算：基波频率约为 1.2 Hz 每 km/h
SYNC_LADDER = (27, 21, 15, 9, 3)  # 同步调制的载波比，取 3 的奇数倍


@dataclass(frozen=True)
class Segment:
    """模式表的一段：基波频率落在 [f_start, f_end) 时使用的载波策略。"""

    f_start: float
    f_end: float  # 不含；最后一段为 inf
    kind: str  # "async" | "sync" | "square"
    fc: float = 0.0  # 异步载波 [Hz]
    n: int = 0  # 同步载波比

    def carrier_at(self, f1):
        """基波频率为 f1 时的载波频率（方波段取 f1，仅作音调参考）。"""
        if self.kind == "async":
            return self.fc
        if self.kind == "sync":
            return self.n * f1
        return f1


@dataclass(frozen=True)
class ModeMap:
    segments: tuple[Segment, ...]
    f_base: float  # 电压达到满调制（m = 1）的基波频率

    @property
    def f_square(self):
        """单脉冲（方波）开始的基波频率，由最后一段决定。"""
        return self.segments[-1].f_start

    def segment_at(self, f1):
        for seg in self.segments:
            if f1 < seg.f_end:
                return seg
        return self.segments[-1]

    def carrier_hz(self, f1):
        return self.segment_at(f1).carrier_at(f1)

    def v1_target(self, f1):
        """V/f 曲线：基波幅值先随频率线性上升，到 f_base 满调制，再过调制直到方波的 4/π。"""
        if f1 <= self.f_base:
            return f1 / self.f_base
        if f1 >= self.f_square:
            return V1_SQUARE
        x = (f1 - self.f_base) / (self.f_square - self.f_base)
        return 1.0 + (V1_SQUARE - 1.0) * x

    def operating_point(self, f1):
        seg = self.segment_at(f1)
        if seg.kind == "square":
            return make_point(f1, "square")
        m = float(reference_for_fundamental(self.v1_target(f1)))
        if seg.kind == "sync":
            return make_point(f1, "sync", m=m, n=seg.n)
        return make_point(f1, "async", m=m, fc=seg.fc)

    def check(self, f_max=None):
        """检查模式表是否合规，返回问题列表（空列表表示没有问题）。"""
        problems = []
        segs = self.segments
        if segs[0].f_start != 0.0:
            problems.append("第一段必须从 0 Hz 开始")
        if segs[-1].kind != "square" or not math.isinf(segs[-1].f_end):
            problems.append("最后一段必须是延伸到无穷的单脉冲（方波）段")
        for a, b in zip(segs, segs[1:]):
            if abs(a.f_end - b.f_start) > 1e-9:
                problems.append(f"{a.f_end:.2f} Hz 附近的分段不连续")
        for seg in segs:
            if seg.kind == "sync" and (seg.n % 2 == 0 or seg.n % 3 != 0):
                problems.append(f"同步载波比 N = {seg.n} 不是 3 的奇数倍，三相波形无法对称")
            if f_max is not None and seg.kind != "square" and seg.carrier_at(seg.f_end) > f_max * (1 + 1e-9):
                problems.append(f"{seg.f_end:.2f} Hz 处载波 {seg.carrier_at(seg.f_end):.0f} Hz 超过器件上限 {f_max:.0f} Hz")
        if not self.f_base < self.f_square:
            problems.append("f_base 必须小于单脉冲起始频率")
        return problems

    def polyline(self, f_end=160.0):
        """模式图折线（载波频率随基波频率），各段之间用 NaN 断开。"""
        xs, ys = [], []
        for seg in self.segments:
            if seg.f_start >= f_end:
                break
            b = min(seg.f_end, f_end)
            xs += [seg.f_start, b, math.nan]
            ys += [seg.carrier_at(seg.f_start), seg.carrier_at(b), math.nan]
        return np.array(xs), np.array(ys)


def synthesize(f_max, ladder=SYNC_LADDER, async_ratio=0.65, f_square=60.0, base_ratio=0.8):
    """按器件开关上限 f_max 生成默认模式表。

    规则：异步载波取 async_ratio·f_max，直到 ladder[0]·f1 追上它；之后同步段取使 N·f1 不超过
    f_max 的最大 N（依次为 ladder 中的各档）；基波频率到 f_square 起为单脉冲。
    """
    fc_async = async_ratio * f_max
    f_a = fc_async / ladder[0]
    segs = []
    if f_a < f_square:
        segs.append(Segment(0.0, f_a, "async", fc=fc_async))
        lo = f_a
        for n in ladder:
            hi = f_max / n
            if lo >= f_square:
                break
            segs.append(Segment(lo, min(hi, f_square), "sync", n=n))
            lo = hi
        if segs[-1].f_end < f_square:  # 上限太低，梯度走完仍未到电压饱和：延长最后一段
            segs[-1] = replace(segs[-1], f_end=f_square)
    else:
        segs.append(Segment(0.0, f_square, "async", fc=fc_async))
    segs.append(Segment(f_square, math.inf, "square"))
    return ModeMap(tuple(segs), f_base=base_ratio * f_square)


# 两个预设的开关频率上限取自 Nagoya 大学课件：新干线 300 系（GTO）420 Hz，N700 系（IGBT）1.5 kHz。
PRESETS = {
    "gto": synthesize(420.0),
    "igbt": synthesize(1500.0),
}
PRESET_LABELS = {
    "gto": "GTO 型（上限 420 Hz）",
    "igbt": "IGBT 型（上限 1.5 kHz）",
}
