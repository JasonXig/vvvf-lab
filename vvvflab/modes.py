"""Mode map: a modulation strategy split by fundamental frequency, and the rule for generating the default map from a device switching limit."""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

from .pwm import V1_SQUARE, OperatingPoint, make_point, reference_for_fundamental

HZ_PER_KMH = 1.2  # demo conversion: about 1.2 Hz of fundamental frequency per km/h
SYNC_LADDER = (27, 21, 15, 9, 3)  # synchronous carrier ratios, odd multiples of 3


@dataclass(frozen=True)
class Segment:
    """One segment of the mode map: the carrier strategy used while the fundamental frequency is in [f_start, f_end)."""

    f_start: float
    f_end: float  # exclusive; inf for the last segment
    kind: str  # "async" | "sync" | "square"
    fc: float = 0.0  # asynchronous carrier [Hz]
    n: int = 0  # synchronous carrier ratio

    def carrier_at(self, f1):
        """Carrier frequency at fundamental frequency f1 (square-wave segments use f1, only as a pitch reference)."""
        if self.kind == "async":
            return self.fc
        if self.kind == "sync":
            return self.n * f1
        return f1


@dataclass(frozen=True)
class ModeMap:
    segments: tuple[Segment, ...]
    f_base: float  # fundamental frequency at which the voltage reaches full modulation (m = 1)

    @property
    def f_square(self):
        """Fundamental frequency at which the single pulse (square wave) starts, determined by the last segment."""
        return self.segments[-1].f_start

    def segment_at(self, f1):
        for seg in self.segments:
            if f1 < seg.f_end:
                return seg
        return self.segments[-1]

    def carrier_hz(self, f1):
        return self.segment_at(f1).carrier_at(f1)

    def v1_target(self, f1):
        """V/f curve: the fundamental amplitude rises linearly with frequency, reaches full modulation at f_base, then overmodulates up to the 4/π of a square wave."""
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
        """Check that the mode map is valid; returns a list of problems (empty means none)."""
        problems = []
        segs = self.segments
        if segs[0].f_start != 0.0:
            problems.append("The first segment must start at 0 Hz")
        if segs[-1].kind != "square" or not math.isinf(segs[-1].f_end):
            problems.append("The last segment must be a single-pulse (square-wave) segment extending to infinity")
        for a, b in zip(segs, segs[1:]):
            if abs(a.f_end - b.f_start) > 1e-9:
                problems.append(f"Segments are not contiguous near {a.f_end:.2f} Hz")
        for seg in segs:
            if seg.kind == "sync" and (seg.n % 2 == 0 or seg.n % 3 != 0):
                problems.append(f"Synchronous carrier ratio N = {seg.n} is not an odd multiple of 3, so the three phases cannot be symmetric")
            if f_max is not None and seg.kind != "square" and seg.carrier_at(seg.f_end) > f_max * (1 + 1e-9):
                problems.append(f"At {seg.f_end:.2f} Hz the carrier {seg.carrier_at(seg.f_end):.0f} Hz exceeds the device limit {f_max:.0f} Hz")
        if not self.f_base < self.f_square:
            problems.append("f_base must be lower than the frequency where the single pulse starts")
        return problems

    def polyline(self, f_end=160.0):
        """Polyline of the mode map (carrier frequency vs fundamental frequency), segments separated by NaN."""
        xs, ys = [], []
        for seg in self.segments:
            if seg.f_start >= f_end:
                break
            b = min(seg.f_end, f_end)
            xs += [seg.f_start, b, math.nan]
            ys += [seg.carrier_at(seg.f_start), seg.carrier_at(b), math.nan]
        return np.array(xs), np.array(ys)


def synthesize(f_max, ladder=SYNC_LADDER, async_ratio=0.65, f_square=60.0, base_ratio=0.8):
    """Generate the default mode map for a device switching limit f_max.

    Rule: the asynchronous carrier is async_ratio·f_max until ladder[0]·f1 catches up with it; after that each synchronous segment uses the largest N with N·f1 not above
    f_max (the steps of the ladder in turn); from f_square on the fundamental frequency uses a single pulse.
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
        if segs[-1].f_end < f_square:  # the limit is so low that the ladder finishes before the voltage saturates: extend the last segment
            segs[-1] = replace(segs[-1], f_end=f_square)
    else:
        segs.append(Segment(0.0, f_square, "async", fc=fc_async))
    segs.append(Segment(f_square, math.inf, "square"))
    return ModeMap(tuple(segs), f_base=base_ratio * f_square)


# The switching limits of the two presets come from Nagoya University lecture notes: Shinkansen series 300 (GTO) 420 Hz, N700 (IGBT) 1.5 kHz.
PRESETS = {
    "gto": synthesize(420.0),
    "igbt": synthesize(1500.0),
}
PRESET_LABELS = {
    "gto": "GTO type (limit 420 Hz)",
    "igbt": "IGBT type (limit 1.5 kHz)",
}
