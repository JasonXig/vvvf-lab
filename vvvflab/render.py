"""离线渲染：把模式表的一次加速扫频渲染成音频，不需要声卡和界面。

用法：python -m vvvflab.render gto gto.wav [--seconds 18]
"""
from __future__ import annotations

import argparse

import numpy as np
from scipy.io import wavfile

from .modes import HZ_PER_KMH, PRESETS
from .synth import DriveSynth


def render_sweep(mode_map, seconds=18.0, max_speed=130.0, fs=48000, block=480, volume=0.5):
    """速度从 0 匀速加到 max_speed（km/h），每 block 个样本更新一次工作点；返回 (音频, 采样率)。"""
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
    parser = argparse.ArgumentParser(description="把一次加速扫频渲染成 WAV")
    parser.add_argument("preset", choices=sorted(PRESETS))
    parser.add_argument("output")
    parser.add_argument("--seconds", type=float, default=18.0)
    args = parser.parse_args(argv)
    audio, fs = render_sweep(PRESETS[args.preset], seconds=args.seconds)
    wavfile.write(args.output, fs, np.round(audio * 32767).astype(np.int16))
    print(f"已写入 {args.output}：{len(audio) / fs:.1f} 秒，{fs} Hz")


if __name__ == "__main__":
    main()
