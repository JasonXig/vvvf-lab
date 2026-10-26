"""界面冒烟测试：用无界面平台把窗口跑起来。没装 PySide6 / pyqtgraph 时整个文件跳过。"""
import os
import time

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
pytest.importorskip("pyqtgraph")

from PySide6 import QtWidgets  # noqa: E402

from vvvflab import app as app_mod  # noqa: E402
from vvvflab.modes import HZ_PER_KMH  # noqa: E402


@pytest.fixture(scope="module")
def qapp():
    return QtWidgets.QApplication.instance() or QtWidgets.QApplication([])


@pytest.fixture
def window(qapp):
    win = app_mod.MainWindow()
    yield win
    win.timer.stop()
    win.audio.stop()
    win.close()


def tick_at(win, speed):
    win.speed = speed
    win.tick()


def test_every_mode_source_runs_at_every_speed(window):
    sources = [(0, None), (1, None)] + [(2, kind) for kind in ("async", "sync", "square")]
    for index, kind in sources:
        window.preset.setCurrentIndex(index)
        if kind is not None:
            window.kind.setCurrentIndex(window.kind.findData(kind))
        for speed in (0.0, 3.0, 30.0, 55.0, 100.0, 130.0):
            tick_at(window, speed)
            op = window.current_point()
            assert op.f1 == pytest.approx(speed * HZ_PER_KMH)
            x, y = window.s_dot.getData()
            assert x[0] == pytest.approx(op.f1) and y[0] == pytest.approx(op.fc)
            assert window.info.text()


def test_spectrum_shows_stems_and_theory_markers_in_the_linear_region(window):
    window.preset.setCurrentIndex(0)  # GTO 型
    tick_at(window, 20.0)  # f1 = 24 Hz，同步 15 脉冲，m < 1
    xs, ys = window.c_stems.getData()
    assert len(xs) > 10 and len(xs) == len(ys)
    tx, ty = window.s_theory.getData()
    assert len(tx) >= 6
    tick_at(window, 130.0)  # 方波：不画解析谱线
    assert len(window.s_theory.getData()[0]) == 0


def test_spectrogram_gets_data_even_when_sound_is_off(window):
    tick_at(window, 40.0)
    window.synth.render(window.synth.fs)
    window._update_spectrogram()
    assert window.img.image is not None and window.img.image.shape[0] > 10


def test_sweep_runs_to_the_end_and_stops_itself(window, monkeypatch):
    monkeypatch.setattr(app_mod, "SWEEP_SECONDS", 0.3)
    window.speed = 0.0
    window._toggle_sweep()
    assert window.sweeping
    deadline = time.perf_counter() + 5.0
    while window.sweeping and time.perf_counter() < deadline:
        window.tick()
        time.sleep(0.01)
    assert not window.sweeping and window.speed == pytest.approx(app_mod.MAX_SPEED)


def test_a_tick_is_cheap_enough_for_30_fps(window):
    window.preset.setCurrentIndex(0)
    window.speed = 5.0
    window.tick()
    start = time.perf_counter()
    for i in range(30):
        tick_at(window, 5.0 + i * 3.0)  # 每次换挡点不同，强制重算波形与频谱
    assert (time.perf_counter() - start) / 30 < 0.030
