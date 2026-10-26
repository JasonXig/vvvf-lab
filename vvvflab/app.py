"""VVVF Lab P1 bench: waveforms, spectra, mode map, spectrogram and real-time sound of a three-phase SPWM."""
from __future__ import annotations

import sys
import time

import numpy as np
import pyqtgraph as pg
from PySide6 import QtCore, QtWidgets

from .modes import HZ_PER_KMH, PRESET_LABELS, PRESETS
from .pwm import SQRT3, make_point, simulate
from .spectrum import amplitude_spectrum, double_fourier_lines, spectrogram_db
from .synth import DriveSynth

try:
    import sounddevice as sd
except Exception:  # without sounddevice or an audio device the UI still runs, just silently
    sd = None

MAX_SPEED = 130.0  # km/h
SWEEP_SECONDS = 18.0
SPEC_FMAX = 5000.0  # upper display limit of the spectrum and spectrogram [Hz]
SPEC_YMIN_DB = -80.0  # lower limit of the spectrum y axis
STEM_MIN_DB = -60.0  # lines below this level are not drawn: the edge-quantization noise of time-domain sampling is at this level
GRAM_FLOOR_DB = -90.0
SPEC_SYNC_SAMPLES = 3 * 8192  # sync/square: samples in one fundamental period (a multiple of 3)
SPEC_ASYNC_RATE = 200_000.0  # async: analysis sample rate [Hz]
SPEC_ASYNC_SECONDS = 0.4


class AudioEngine:
    """sounddevice output stream; `available` is False without a sound card or without sounddevice."""

    def __init__(self):
        self.stream = None
        self.error = None if sd is not None else "sounddevice is not installed"
        self.fs = 48000
        if sd is not None:
            try:
                self.fs = int(sd.query_devices(kind="output")["default_samplerate"])
            except Exception as exc:
                self.error = str(exc)
        self.synth = DriveSynth(self.fs)

    @property
    def available(self):
        return sd is not None and self.error is None

    @property
    def running(self):
        return self.stream is not None

    def start(self):
        if self.running:
            return True
        if not self.available:
            return False
        for channels in (1, 2):

            def callback(outdata, frames, time_info, status, channels=channels):
                block = self.synth.render(frames)
                outdata[:] = block[:, None] if channels == 1 else np.repeat(block[:, None], channels, axis=1)

            try:
                self.stream = sd.OutputStream(
                    samplerate=self.fs, channels=channels, dtype="float32", blocksize=1024, latency="low", callback=callback
                )
                self.stream.start()
                return True
            except Exception as exc:
                self.error = str(exc)
                self.stream = None
        return False

    def stop(self):
        if self.stream is not None:
            try:
                self.stream.stop()
                self.stream.close()
            finally:
                self.stream = None


class MainWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("VVVF Lab · P1 three-phase SPWM bench")
        self.audio = AudioEngine()
        self.synth = self.audio.synth
        self.speed = 30.0
        self.sweeping = False
        self._sweep_t0 = 0.0
        self._last_tick = time.perf_counter()
        self._key = None
        self._map_key = None
        self._ticks = 0
        self._build_ui()
        self._on_preset()
        self.timer = QtCore.QTimer(self)
        self.timer.timeout.connect(self.tick)
        self.timer.start(33)

    # ---- UI ------------------------------------------------------------------
    def _build_ui(self):
        root = QtWidgets.QWidget()
        self.setCentralWidget(root)
        layout = QtWidgets.QHBoxLayout(root)
        layout.addWidget(self._build_controls(), 0)
        layout.addWidget(self._build_plots(), 1)

    def _slider(self, lo, hi, value):
        s = QtWidgets.QSlider(QtCore.Qt.Orientation.Horizontal)
        s.setRange(lo, hi)
        s.setValue(value)
        return s

    def _build_controls(self):
        panel = QtWidgets.QWidget()
        panel.setFixedWidth(310)
        col = QtWidgets.QVBoxLayout(panel)

        box = QtWidgets.QGroupBox("Mode and speed")
        form = QtWidgets.QFormLayout(box)
        self.preset = QtWidgets.QComboBox()
        for key, label in PRESET_LABELS.items():
            self.preset.addItem(label, key)
        self.preset.addItem("Manual", "manual")
        self.preset.currentIndexChanged.connect(self._on_preset)
        form.addRow("Mode map", self.preset)
        self.speed_slider = self._slider(0, int(MAX_SPEED * 10), int(self.speed * 10))
        self.speed_slider.valueChanged.connect(self._on_speed)
        self.speed_label = QtWidgets.QLabel()
        form.addRow("Speed", self.speed_slider)
        form.addRow("", self.speed_label)
        self.sweep_button = QtWidgets.QPushButton("Auto-accelerate 0 → 130 km/h")
        self.sweep_button.clicked.connect(self._toggle_sweep)
        form.addRow(self.sweep_button)
        col.addWidget(box)

        self.manual_box = QtWidgets.QGroupBox("Manual settings (available when Manual is selected)")
        mform = QtWidgets.QFormLayout(self.manual_box)
        self.kind = QtWidgets.QComboBox()
        for label, key in (("Asynchronous (fixed carrier)", "async"), ("Synchronous (carrier = N·f1)", "sync"), ("Single pulse (square wave)", "square")):
            self.kind.addItem(label, key)
        self.m_slider = self._slider(0, 130, 80)
        self.fc_slider = self._slider(100, 3000, 1000)
        self.n_spin = QtWidgets.QSpinBox()
        self.n_spin.setRange(3, 99)
        self.n_spin.setSingleStep(6)  # 3, 9, 15, 21...: odd multiples of 3
        self.n_spin.setValue(15)
        self.m_label = QtWidgets.QLabel()
        self.fc_label = QtWidgets.QLabel()
        mform.addRow("Modulation", self.kind)
        mform.addRow("Modulation index m", self.m_slider)
        mform.addRow("", self.m_label)
        mform.addRow("Async carrier fc", self.fc_slider)
        mform.addRow("", self.fc_label)
        mform.addRow("Sync carrier ratio N", self.n_spin)
        for w in (self.kind, self.m_slider, self.fc_slider, self.n_spin):
            (w.currentIndexChanged if isinstance(w, QtWidgets.QComboBox) else w.valueChanged).connect(self._on_manual)
        col.addWidget(self.manual_box)

        sbox = QtWidgets.QGroupBox("Sound")
        sform = QtWidgets.QFormLayout(sbox)
        self.sound = QtWidgets.QCheckBox("Play sound")
        self.sound.toggled.connect(self._toggle_sound)
        self.volume = self._slider(0, 100, 30)  # low by default: people often wear headphones
        self.volume.valueChanged.connect(lambda v: self.synth.set_volume(v / 100))
        self.synth.set_volume(0.3)
        sform.addRow(self.sound)
        sform.addRow("Volume", self.volume)
        self.sound_note = QtWidgets.QLabel("")
        self.sound_note.setWordWrap(True)
        sform.addRow(self.sound_note)
        col.addWidget(sbox)

        self.info = QtWidgets.QLabel()
        self.info.setWordWrap(True)
        self.info.setTextFormat(QtCore.Qt.TextFormat.RichText)
        col.addWidget(self.info)
        col.addStretch(1)
        return panel

    def _build_plots(self):
        pg.setConfigOptions(antialias=True)
        glw = pg.GraphicsLayoutWidget()
        self.p_pole = glw.addPlot(row=0, col=0, title="Pole voltage s_a, reference, carrier")
        self.p_line = glw.addPlot(row=0, col=1, title="Line voltage v_ab (units of Vdc/2)")
        self.p_spec = glw.addPlot(row=1, col=0, title="Line-voltage spectrum (○ = analytic line)")
        self.p_map = glw.addPlot(row=1, col=1, title="Mode map: carrier frequency ≈ the pitch you hear")
        self.p_gram = glw.addPlot(row=2, col=0, colspan=2, title="Spectrogram (last 4 s)")

        self.c_tri = self.p_pole.plot(pen=pg.mkPen((150, 150, 150), width=1))
        self.c_ref = self.p_pole.plot(pen=pg.mkPen((90, 160, 255), width=1))
        self.c_pole = self.p_pole.plot(pen=pg.mkPen((255, 170, 60), width=2))
        self.p_pole.setYRange(-1.6, 1.6)
        self.p_pole.setLabel("bottom", "Time", units="ms")

        self.c_vab = self.p_line.plot(pen=pg.mkPen((120, 220, 140), width=2))
        self.p_line.setYRange(-2.4, 2.4)
        self.p_line.setLabel("bottom", "Time", units="ms")

        self.c_stems = pg.PlotCurveItem(pen=pg.mkPen((120, 190, 255), width=2), connect="pairs")
        self.p_spec.addItem(self.c_stems)
        self.s_theory = pg.ScatterPlotItem(symbol="o", size=10, pen=pg.mkPen((255, 120, 60), width=1.5), brush=None)
        self.p_spec.addItem(self.s_theory)
        self.p_spec.setXRange(0, SPEC_FMAX, padding=0)
        self.p_spec.setYRange(SPEC_YMIN_DB, 10, padding=0)
        self.p_spec.setLabel("bottom", "Frequency", units="Hz")
        self.p_spec.setLabel("left", "Amplitude", units="dB")

        self.c_map = self.p_map.plot(pen=pg.mkPen((160, 200, 255), width=2), connect="finite")
        self.s_dot = pg.ScatterPlotItem(size=13, brush=pg.mkBrush(255, 80, 80), pen=pg.mkPen("w", width=1.5))
        self.p_map.addItem(self.s_dot)
        self.p_map.setXRange(0, 160, padding=0)
        self.p_map.setLabel("bottom", "Fundamental frequency f1", units="Hz")
        self.p_map.setLabel("left", "Carrier frequency", units="Hz")

        self.img = pg.ImageItem()
        self.img.setColorMap(pg.colormap.get("inferno"))
        self.img.setLevels((-70.0, -10.0))
        self.p_gram.addItem(self.img)
        self.p_gram.setYRange(0, SPEC_FMAX, padding=0)
        self.p_gram.setLabel("bottom", "Time", units="s")
        self.p_gram.setLabel("left", "Frequency", units="Hz")
        glw.ci.layout.setRowStretchFactor(2, 1)
        return glw

    # ---- events --------------------------------------------------------------
    def _on_preset(self):
        self.manual_box.setEnabled(self.preset.currentData() == "manual")
        self._map_key = None
        self._key = None
        self._on_manual()

    def _on_manual(self, *_):
        self.m_label.setText(f"{self.m_slider.value() / 100:.2f}")
        self.fc_label.setText(f"{self.fc_slider.value()} Hz")
        self._key = None

    def _on_speed(self, value):
        self.speed = value / 10.0
        if self.sweeping:
            self._stop_sweep()

    def _sync_speed_widgets(self):
        self.speed_slider.blockSignals(True)
        self.speed_slider.setValue(int(round(self.speed * 10)))
        self.speed_slider.blockSignals(False)

    def _toggle_sweep(self):
        if self.sweeping:
            self._stop_sweep()
        else:
            self.sweeping = True
            self._sweep_t0 = time.perf_counter()
            self.sweep_button.setText("Stop auto-acceleration")

    def _stop_sweep(self):
        self.sweeping = False
        self.sweep_button.setText("Auto-accelerate 0 → 130 km/h")

    def _toggle_sound(self, on):
        if on:
            if not self.audio.start():
                self.sound_note.setText(f"Cannot open the audio device: {self.audio.error}")
                self.sound.blockSignals(True)
                self.sound.setChecked(False)
                self.sound.blockSignals(False)
            else:
                self.sound_note.setText("")
        else:
            self.audio.stop()

    def closeEvent(self, event):
        self.timer.stop()
        self.audio.stop()
        super().closeEvent(event)

    # ---- data ----------------------------------------------------------------
    def current_point(self):
        f1 = self.speed * HZ_PER_KMH
        key = self.preset.currentData()
        if key in PRESETS:
            return PRESETS[key].operating_point(f1)
        kind = self.kind.currentData()
        m = self.m_slider.value() / 100.0
        if kind == "square":
            return make_point(f1, "square")
        if kind == "sync":
            return make_point(f1, "sync", m=m, n=self.n_spin.value())
        return make_point(f1, "async", m=m, fc=float(self.fc_slider.value()))

    def tick(self):
        now = time.perf_counter()
        dt, self._last_tick = now - self._last_tick, now
        if self.sweeping:
            p = (now - self._sweep_t0) / SWEEP_SECONDS
            self.speed = MAX_SPEED * min(p, 1.0)
            self._sync_speed_widgets()
            if p >= 1.0:
                self._stop_sweep()
        op = self.current_point()
        self.synth.set_target(op)
        if not self.audio.running:  # with sound off, keep the synthesizer idling so the spectrogram still has data
            frames = min(int(dt * self.synth.fs), self.synth.fs // 5)
            if frames >= 16:
                self.synth.render(frames)
        self._update_info(op)
        key = (op.kind, round(op.f1, 2), round(op.m, 3), round(op.fc, 1), op.n)
        if key != self._key:
            self._key = key
            self._update_waveforms(op)
            self._update_spectrum(op)
            self._update_map(op)
        self._ticks += 1
        if self._ticks % 3 == 0:
            self._update_spectrogram()

    def _update_info(self, op):
        self.speed_label.setText(f"{self.speed:.1f} km/h → fundamental f1 = {op.f1:.1f} Hz")
        mode = {"async": "Asynchronous", "sync": f"Synchronous {op.n} pulses", "square": "Single pulse (square wave)"}[op.kind]
        self.info.setText(
            f"<b>{mode}</b><br>carrier ≈ {op.fc:.0f} Hz (the pitch you hear)<br>reference amplitude m = {op.m:.2f}, fundamental {op.v1:.2f}"
            if op.kind != "square"
            else f"<b>{mode}</b><br>carrier reference = f1 = {op.f1:.0f} Hz<br>fundamental {op.v1:.2f} (maximum)"
        )

    def _update_waveforms(self, op):
        span = float(np.clip(2.0 / max(op.f1, 1.0), 0.010, 0.030))  # show about 2 fundamental periods, limited to 10–30 ms
        n = 3000
        w = simulate(op, n / span, n)
        x = w.t * 1e3
        self.c_tri.setVisible(op.kind != "square")
        self.c_ref.setVisible(op.kind != "square")
        self.c_tri.setData(x, w.tri)
        self.c_ref.setData(x, np.clip(w.ref[0], -1.6, 1.6))
        self.c_pole.setData(x, w.s[0])
        self.c_vab.setData(x, w.vab)

    def _update_spectrum(self, op):
        f1 = max(op.f1, 2.0)
        analysis = make_point(f1, op.kind, m=op.m, fc=op.fc, n=op.n)
        if op.kind == "async":
            n, window, fs = int(SPEC_ASYNC_SECONDS * SPEC_ASYNC_RATE), "hann", SPEC_ASYNC_RATE
        else:  # one fundamental period is exactly an integer number of samples: lines fall on multiples of f1 and do not leak
            n, window, fs = SPEC_SYNC_SAMPLES, "rect", SPEC_SYNC_SAMPLES * f1
        w = simulate(analysis, fs, n)
        freqs, amps = amplitude_spectrum(w.vab, fs, window)
        floor = 10 ** ((STEM_MIN_DB + (10.0 if op.kind == "async" else 0.0)) / 20)  # window leakage raises the noise floor for async
        keep = (freqs <= SPEC_FMAX) & (amps > floor)
        f, a = freqs[keep], 20 * np.log10(amps[keep])
        xs = np.repeat(f, 2)
        ys = np.column_stack([np.full_like(a, SPEC_YMIN_DB), a]).ravel()
        self.c_stems.setData(xs, ys)
        if op.kind != "square" and op.m <= 1.0 and op.f1 >= 2.0:
            lines = [(f1, SQRT3 * op.m)] + [
                (fl, al) for fl, al, _, _ in double_fourier_lines(op.m, op.fc, op.f1) if al > floor
            ]
            lines = [(fl, 20 * np.log10(al)) for fl, al in lines if fl <= SPEC_FMAX and al > 0]
            self.s_theory.setData([fl for fl, _ in lines], [al for _, al in lines])
        else:
            self.s_theory.setData([], [])

    def _update_map(self, op):
        key = self.preset.currentData()
        if key != self._map_key:
            self._map_key = key
            if key in PRESETS:
                x, y = PRESETS[key].polyline(160.0)
                self.c_map.setData(x, y, connect="finite")
                self.p_map.setYRange(0, float(np.nanmax(y)) * 1.15, padding=0)
            else:
                self.c_map.setData([], [])
                self.p_map.setYRange(0, 3200, padding=0)
        self.s_dot.setData([op.f1], [op.fc])

    def _update_spectrogram(self):
        times, freqs, db = spectrogram_db(self.synth.recent(4.0), self.synth.fs, fmax=SPEC_FMAX, floor_db=GRAM_FLOOR_DB)
        if db.shape[1] < 2:
            return
        t = times - times[-1]
        self.img.setImage(db.T, autoLevels=False)
        self.img.setRect(QtCore.QRectF(t[0], freqs[0], t[-1] - t[0], freqs[-1] - freqs[0]))


def main():
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv)
    win = MainWindow()
    win.resize(1400, 920)
    win.show()
    code = app.exec()
    win.audio.stop()
    return code


if __name__ == "__main__":
    sys.exit(main())
