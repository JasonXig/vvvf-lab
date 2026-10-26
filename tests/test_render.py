import numpy as np
import pytest

from vvvflab.modes import HZ_PER_KMH, PRESETS
from vvvflab.render import render_sweep
from vvvflab.spectrum import spectrogram_db

SECONDS = 8.0
MAX_SPEED = 130.0


def predicted_lines(op):
    """工作点 op 应该出现的谱线频率：载波组 k·fc + n·f1（线性区），以及过调制和方波带来的低次谐波 6j±1。"""
    lines = {k * op.f1 for k in range(1, 40) if k % 6 in (1, 5)}
    if op.kind != "square":
        for k in (1, 2, 3):
            for n in range(-14, 15):
                if (k + n) % 2 == 1 and n % 3 != 0:
                    lines.add(abs(k * op.fc + n * op.f1))
    return lines


@pytest.mark.parametrize("key", ["gto", "igbt"])
def test_loudest_line_follows_the_mode_map_during_a_sweep(key):
    mm = PRESETS[key]
    audio, fs = render_sweep(mm, seconds=SECONDS, max_speed=MAX_SPEED)
    nperseg = 4096
    times, freqs, db = spectrogram_db(audio, fs, nperseg=nperseg, hop=1024, fmax=3500.0)
    bin_width = fs / nperseg
    hits = total = 0
    for j, t in enumerate(times):
        if t < 0.5 or t > SECONDS - 0.2:
            continue
        op = mm.operating_point(MAX_SPEED * HZ_PER_KMH * t / SECONDS)
        sel = freqs >= 150.0
        peak = freqs[sel][np.argmax(db[sel, j])]
        total += 1
        hits += min(abs(peak - f) for f in predicted_lines(op)) <= 1.5 * bin_width
    assert hits / total > 0.98


def test_sweep_audio_is_bounded_and_the_low_carrier_preset_is_louder():
    gto, _ = render_sweep(PRESETS["gto"], seconds=4.0)
    igbt, _ = render_sweep(PRESETS["igbt"], seconds=4.0)
    for audio in (gto, igbt):
        assert np.all(np.isfinite(audio)) and np.max(np.abs(audio)) <= 1.0
    assert np.sqrt(np.mean(gto.astype(float) ** 2)) > 1.5 * np.sqrt(np.mean(igbt.astype(float) ** 2))
