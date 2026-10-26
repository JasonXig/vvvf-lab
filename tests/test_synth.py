import numpy as np

from vvvflab.pwm import make_point
from vvvflab.spectrum import amplitude_spectrum
from vvvflab.synth import DriveSynth

FS = 48000


def steady_spectrum(op, seconds=1.0, volume=0.5):
    synth = DriveSynth(FS, soft_start=False)
    synth.set_volume(volume)
    synth._gain = volume
    synth.set_target(op)
    synth.render(FS // 2)  # let the filter state settle
    x = synth.render(int(seconds * FS)).astype(float)
    freqs, amps = amplitude_spectrum(x, FS, "hann")
    return x, freqs, amps


def line(amps, f):
    """Line amplitude near frequency f (the maximum over ±1 bin at 1 Hz resolution)."""
    i = int(round(f))
    return amps[i - 1 : i + 2].max()


def test_render_is_finite_bounded_float32():
    synth = DriveSynth(FS)
    synth.set_target(make_point(40.0, "sync", m=0.6, n=15))
    x = synth.render(4800)
    assert x.dtype == np.float32 and x.shape == (4800,)
    assert np.all(np.isfinite(x)) and np.max(np.abs(x)) <= 1.0


def test_silent_when_the_inverter_is_stopped():
    synth = DriveSynth(FS)
    synth.set_target(make_point(0.0, "async", m=0.0, fc=300.0))
    assert np.max(np.abs(synth.render(4800))) < 1e-6


def test_chunked_rendering_equals_single_rendering():
    op = make_point(40.0, "sync", m=0.6, n=15)
    a = DriveSynth(FS, soft_start=False)
    a.set_target(op)
    b = DriveSynth(FS, soft_start=False)
    b.set_target(op)
    whole = a.render(4800)
    parts = np.concatenate([b.render(480) for _ in range(10)])
    assert np.max(np.abs(whole - parts)) < 5e-3


def test_async_carrier_is_heard_as_sidebands_not_as_the_carrier_itself():
    f1, fc = 40.0, 1000.0
    _, _, amps = steady_spectrum(make_point(f1, "async", m=0.8, fc=fc))
    assert line(amps, fc - 2 * f1) > 5 * line(amps, fc)
    assert line(amps, fc + 2 * f1) > 5 * line(amps, fc)
    assert line(amps, fc - 2 * f1) > 0.01


def test_sync_lines_follow_the_fundamental_frequency():
    n = 15
    for f1 in (40.0, 60.0):
        _, _, amps = steady_spectrum(make_point(f1, "sync", m=0.6, n=n))
        floor = np.median(amps[200:4000])
        low, high = line(amps, (n - 2) * f1), line(amps, (n + 2) * f1)
        assert low > 20 * floor and high > 20 * floor
        assert line(amps, n * f1) < 0.1 * low


def test_square_mode_is_dominated_by_the_fifth_and_seventh_harmonics():
    f1 = 100.0
    _, _, amps = steady_spectrum(make_point(f1, "square"))
    assert line(amps, 5 * f1) > 10 * line(amps, 3 * f1)
    assert line(amps, 5 * f1) > 10 * line(amps, 2 * f1)
    assert line(amps, 7 * f1) > 10 * line(amps, 4 * f1)


def test_lower_carrier_is_louder_for_the_same_voltage():
    quiet = steady_spectrum(make_point(40.0, "async", m=0.8, fc=1500.0), volume=1.0)[0]
    loud = steady_spectrum(make_point(40.0, "async", m=0.8, fc=420.0), volume=1.0)[0]
    assert np.sqrt(np.mean(loud**2)) > 2 * np.sqrt(np.mean(quiet**2))


def test_ring_buffer_returns_the_most_recent_samples_across_wrap_around():
    synth = DriveSynth(FS, ring_seconds=1.0, soft_start=False)
    synth.set_target(make_point(50.0, "async", m=0.5, fc=800.0))
    chunks = [synth.render(7000) for _ in range(9)]  # 63000 > 48000, so the ring buffer wraps around
    tail = np.concatenate(chunks)[-480:]
    assert np.array_equal(synth.recent(0.01), tail)
    assert len(synth.recent(10.0)) == FS
