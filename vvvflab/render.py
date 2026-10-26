"""Offline rendering: render one acceleration sweep of a mode map to audio, no sound card or GUI needed.

Usage: python -m vvvflab.render gto gto.wav [--seconds 18]
"""
from __future__ import annotations

import argparse

import numpy as np
from scipy.io import wavfile

from .modes import HZ_PER_KMH, PRESETS
from .synth import DriveSynth


def render_sweep(mode_map, seconds=18.0, max_speed=130.0, fs=48000, block=480, volume=0.5):
    """Accelerate uniformly from 0 to max_speed (km/h), updating the operating point every `block` samples; returns (audio, sample rate)."""
    synth = DriveSynth(fs)
    synth.set_volume(volume)
    n_blocks = int(seconds * fs / block)
    chunks = []
    for i in range(n_blocks):
        f1 = max_speed * HZ_PER_KMH * (i + 1) / n_blocks
        synth.set_target(mode_map.operating_point(f1))
        chunks.append(synth.render(block))
    return np.concatenate(chunks), fs


def main(argv=None):
    parser = argparse.ArgumentParser(description="Render an acceleration sweep to a WAV file")
    parser.add_argument("preset", choices=sorted(PRESETS))
    parser.add_argument("output")
    parser.add_argument("--seconds", type=float, default=18.0)
    args = parser.parse_args(argv)
    audio, fs = render_sweep(PRESETS[args.preset], seconds=args.seconds)
    wavfile.write(args.output, fs, np.round(audio * 32767).astype(np.int16))
    print(f"Wrote {args.output}: {len(audio) / fs:.1f} s, {fs} Hz")


if __name__ == "__main__":
    main()
