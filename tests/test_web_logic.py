"""Cross-check the mode tables and drivetrain model of the web page (web/js) against the Python version and independent formulas. The whole file is skipped if Node.js is not installed."""
import json
import math
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from vvvflab.modes import PRESETS

NODE = shutil.which("node")
SCRIPT = Path(__file__).resolve().parents[1] / "web" / "tests" / "dump_logic.js"

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")


def speed_for_f1(f1):
    """Vehicle speed for a fundamental frequency f1 with the default drivetrain of the page: the formula is written out independently and inverted by bisection."""

    def f1_at(v):
        rotor_rps = v / 3.6 / (math.pi * 0.86) * 5.6
        fr = 2 * rotor_rps
        x = min(1.0, max(0.0, (fr - 48.0) / (150.0 - 48.0)))
        return fr + 1.5 + 3.5 * x

    lo, hi = 0.0, 400.0
    for _ in range(60):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if f1_at(mid) < f1 else (lo, mid)
    return (lo + hi) / 2


@pytest.fixture(scope="module")
def js():
    result = subprocess.run([NODE, str(SCRIPT)], capture_output=True, text=True, encoding="utf-8", check=True, timeout=60)
    return json.loads(result.stdout)


@pytest.mark.parametrize("key", sorted(PRESETS))
def test_js_mode_table_equals_python(js, key):
    py, web = PRESETS[key], js["presets"][key]
    assert web["fBase"] == pytest.approx(py.f_base)
    assert web["fSquare"] == pytest.approx(py.f_square)
    assert len(web["segments"]) == len(py.segments)
    for a, b in zip(web["segments"], py.segments):
        assert a["kind"] == b.kind and a["n"] == b.n
        assert a["start"] == pytest.approx(b.f_start)
        assert (math.inf if a["end"] == "inf" else a["end"]) == pytest.approx(b.f_end)
        assert a["fc"] == pytest.approx(b.fc)


def test_js_operating_points_equal_python(js):
    assert len(js["points"]) > 20
    for p in js["points"]:
        mm = PRESETS[p["preset"]]
        seg = mm.segment_at(p["f1"])
        assert p["kind"] == seg.kind and p["n"] == seg.n
        assert p["fc"] == pytest.approx(seg.carrier_at(p["f1"]))
        assert p["v1"] == pytest.approx(mm.v1_target(p["f1"]))


def test_js_drive_model_matches_independent_formulas(js):
    wheel_d, gear = 0.86, 5.6  # default drivetrain parameters of the page
    for d in js["drive"]:
        rotor_rps = d["v"] / 3.6 / (math.pi * wheel_d) * gear
        fr = d["p"] * rotor_rps
        fs = 0.0
        if not d["synchronous"]:
            x = min(1.0, max(0.0, (fr - 48.0) / (150.0 - 48.0)))
            fs = 1.5 + (5.0 - 1.5) * x
        f1 = fr + fs
        assert d["nr"] == pytest.approx(rotor_rps * 60.0)
        assert d["f1"] == pytest.approx(f1)
        assert d["ns"] == pytest.approx(60.0 * f1 / d["p"] if f1 > 0 else 0.0)
        assert d["slip"] == pytest.approx(fs / f1 if f1 > 0 else 0.0)


def test_js_overmodulation_conversions_equal_python(js):
    from vvvflab.pwm import fundamental_from_reference, reference_for_fundamental

    for row in js["fund"]:
        assert row["v"] == pytest.approx(float(fundamental_from_reference(row["m"])), abs=1e-12)
    for row in js["ref"]:
        assert row["m"] == pytest.approx(float(reference_for_fundamental(row["v"])), abs=1e-9)


def test_js_table_presets_are_valid_and_follow_the_python_mode_maps(js):
    assert js["tables"]
    for key, entry in js["tables"].items():
        assert entry["problems"] == [], key
    # The GTO / IGBT tables generated from the Python rules must line up once converted to vehicle speed (independently inverted by bisection)
    for key in ("gto", "igbt"):
        table, mm = js["tables"][key]["table"], PRESETS[key]
        non_square = [s for s in mm.segments if s.kind != "square"]
        assert len(table["segments"]) == len(non_square) + 1
        for seg, ref in zip(table["segments"], non_square):
            assert seg["to"] == pytest.approx(speed_for_f1(ref.f_end), abs=0.06)
        assert table["segments"][-1]["kind"] == "square" and table["segments"][-1]["to"] == 160
        assert table["vBase"] == pytest.approx(speed_for_f1(mm.f_base), abs=0.06)


def test_js_reference_table_lookup(js):
    by_speed = {p["v"]: p for p in js["tablePoints"]}
    assert (by_speed[0]["kind"], by_speed[0]["fc"]) == ("async", 1050)
    assert by_speed[34.4]["kind"] == "async" and by_speed[34.5]["kind"] == "sync" and by_speed[34.5]["n"] == 9
    assert by_speed[36]["fc"] == pytest.approx(9 * by_speed[36]["f1"])
    assert by_speed[38]["kind"] == "sync" and by_speed[38]["n"] == 3  # wide 3-pulse
    assert by_speed[160]["n"] == 3 and by_speed[160]["m"] > 1  # overmodulation
    v1 = {row["v"]: row["v1"] for row in js["v1"]}
    assert v1[20] == pytest.approx(20 / 38) and v1[38] == pytest.approx(1.0)
    assert v1[110] == pytest.approx(4 / math.pi) and v1[160] == pytest.approx(4 / math.pi)
    assert 1.0 < v1[60] < 4 / math.pi


def pwm_fundamental(n, m, points=2_000_000):
    """Independent implementation: sample one fundamental period finely, compare the reference with the triangle directly, then correlate with sine and cosine to get the fundamental (in-phase and quadrature components)."""
    th = (np.arange(points) + 0.5) / points * 2 * np.pi
    x = n * th / (2 * np.pi)
    x -= np.floor(x)
    carrier = np.where(x < 0.25, 4 * x, np.where(x < 0.75, 2 - 4 * x, 4 * x - 4))
    p = np.where(m * np.sin(th) > carrier, 1.0, -1.0)
    return 2 / points * np.sum(p * np.sin(th)), 2 / points * np.sum(p * np.cos(th))


def test_js_sync_calibration_gives_the_commanded_fundamental(js):
    """With few pulses, "fundamental amplitude = reference amplitude" does not hold (3 pulses, m = 0.95 gives only 0.64).
    The page back-solves the reference amplitude so the actual fundamental equals the voltage command; verified here with an independent numerical integration, and the fundamental is confirmed to be in phase with the reference."""
    assert len(js["syncCal"]) == 30
    for row in js["syncCal"]:
        a, b = pwm_fundamental(row["n"], row["m"])
        assert abs(b) < 2e-3, row
        if row["v1"] < row["maxFundamental"] - 1e-6:
            assert a == pytest.approx(row["v1"], abs=3e-3), row
        else:  # asked for more than the maximum available: give the maximum
            assert row["m"] == 20 and a > row["maxFundamental"] - 3e-3, row


def test_js_three_pulse_mode_really_needs_the_calibration(js):
    """Without the back-solve (m = v1) the fundamental of 3 pulses falls well short. This test shows the back-solve above is not redundant."""
    from vvvflab.pwm import reference_for_fundamental

    m = float(reference_for_fundamental(0.95))
    a, _ = pwm_fundamental(3, m)
    assert a < 0.7 * 0.95


def test_js_sync_operating_points_hit_the_voltage_command(js):
    sync_points = [p for p in js["tablePoints"] if p["kind"] == "sync"]
    assert len(sync_points) >= 4
    for p in sync_points:
        a, b = pwm_fundamental(p["n"], p["m"])
        assert abs(b) < 2e-3, p
        assert a == pytest.approx(p["v1"], abs=0.02 if p["m"] >= 20 else 3e-3), p


def test_js_sync_pulse_count_must_be_odd_and_at_least_three(js):
    assert js["invalidTables"]["oddN"] == []
    assert js["invalidTables"]["evenN"] and "odd" in js["invalidTables"]["evenN"][0]


def test_js_braking_runs_the_field_slower_than_the_rotor(js):
    for row in js["brake"]:
        assert row["fs"] <= 0
        if row["v"] >= 10:
            assert row["f1"] == pytest.approx(row["fr"] + row["fs"]) and row["f1"] < row["fr"]
            assert row["slip"] < 0 and row["ns"] < row["nr"]


def test_js_train_dynamics_match_independent_formulas(js):
    for row in js["dyn"]:
        v, dt = row["v"], 0.1
        resist = 0.1 + 1.5e-5 * v * v
        if row["mode"] == "power":
            a = (3.0 if v <= 40 else 3.0 * 40 / v) - resist
        elif row["mode"] == "brake":
            a = -(3.5 + resist)
        else:
            a = -resist
        assert row["next"] == pytest.approx(min(160.0, max(0.0, v + a * dt)), abs=1e-9)


def test_js_notches_run_from_full_brake_to_full_power(js):
    notches = js["notches"]
    assert [n["id"] for n in notches] == ["B5", "B4", "B3", "B2", "B1", "N", "H", "P1", "P2", "P3", "P4"]
    assert notches[js["notchN"]]["id"] == "N" and notches[js["notchN"]]["mode"] == "coast"
    brake = [n["frac"] for n in notches if n["mode"] == "brake"]
    power = [n["frac"] for n in notches if n["mode"] == "power"]
    assert brake == sorted(brake, reverse=True) and brake[0] == 1.0  # B5 is full braking, getting smaller towards N
    assert power == sorted(power) and power[-1] == 1.0  # P4 is full power
    assert all(0 < f <= 1 for f in brake + power)


def test_js_slip_is_proportional_to_the_torque_command(js):
    full = {r["braking"]: r for r in js["load"] if r["load"] == 1}
    for r in js["load"]:
        assert r["fs"] == pytest.approx(r["load"] * full[r["braking"]]["fs"])
        assert r["f1"] == pytest.approx(r["fr"] + r["fs"])
        if r["load"] == 0:  # neutral: zero slip, the rotating field is exactly in sync with the rotor, no torque
            assert r["fs"] == 0 and r["f1"] == pytest.approx(r["fr"]) and r["slip"] == 0
    assert js["torque"] == [
        {"mode": "power", "frac": 0.5, "load": 0.5},
        {"mode": "coast", "frac": 0.7, "load": 0},
        {"mode": "hold", "frac": 0.1, "load": 0.1},
        {"mode": "brake", "frac": 0.8, "load": 0.8},
    ]


def test_js_dynamics_follow_the_notch(js):
    for row in js["dyn2"]:
        v, frac, dt = row["v"], row["frac"], 0.1
        resist = 0.1 + 1.5e-5 * v * v
        if row["mode"] == "power":
            a = (3.0 if v <= 40 else 3.0 * 40 / v) * frac - resist
        elif row["mode"] == "brake":
            a = -(3.5 * frac + resist)
        elif row["mode"] == "hold":
            a = 0.0  # hold: the tractive effort exactly cancels the resistance
        else:
            a = -resist
        assert row["next"] == pytest.approx(min(160.0, max(0.0, v + a * dt)), abs=1e-9)


def test_js_inverter_keeps_running_in_neutral_so_the_sound_continues(js):
    """In neutral (coasting) and hold the inverter keeps running (zero torque) so the sound continues; it only goes quiet when the train is almost stopped."""
    for r in js["run"]:
        if r["inv"] and r["mode"] in ("coast", "hold") and r["f1"] >= 0.5:
            assert r["run"], r
        if r["inv"] and r["mode"] in ("coast", "hold") and r["f1"] < 0.5:
            assert not r["run"] and r["why"] == "Inverter standby", r
        if r["inv"] and r["mode"] == "power":
            assert r["run"], r  # also running when starting off, while the fundamental frequency is still 0
        if r["inv"] and r["mode"] == "brake":
            assert r["run"] == (r["f1"] >= 1), r  # regenerative braking is released below 1 Hz of fundamental frequency
            assert r["run"] or r["why"] == "Regenerative brake released"


def test_js_no_inverter_means_no_traction_and_no_sound(js):
    for r in js["run"]:
        if not r["inv"]:
            assert not r["run"] and r["why"] == "Inverter off", r
            assert r["em"] == ("brake" if r["mode"] == "brake" else "coast")  # power and hold can only coast; braking becomes mechanical braking
        else:
            assert r["em"] == r["mode"]


def test_js_carrier_helper_agrees_with_the_operating_point(js):
    assert len(js["carrier"]) == 32
    for row in js["carrier"]:
        assert row["a"] == pytest.approx(row["b"]), row


def test_js_note_names_and_frequencies(js):
    n = js["notes"]
    assert n["A4"] == pytest.approx(440.0)
    assert n["C4"] == pytest.approx(440 * 2 ** (-9 / 12))  # 261.626 Hz
    assert n["F#3"] == pytest.approx(440 * 2 ** (-15 / 12))
    assert n["Bb4"] == pytest.approx(440 * 2 ** (1 / 12))
    assert n["c5"] == pytest.approx(440 * 2 ** (3 / 12))  # lower case is accepted too
    assert n["523.25 Hz"] == pytest.approx(523.25) and n["440"] == 440
    assert n["hello"] is None and n["H4"] is None and n[""] is None  # NaN is null in JSON
    for row in js["nearest"]:
        assert row["name"] == {440: "A4", 261.63: "C4", 523.25: "C5", 450: "A4"}[row["f"]]
    assert next(r for r in js["nearest"] if r["f"] == 450)["cents"] == pytest.approx(39, abs=1)  # 450 Hz is about 39 cents above A4


def test_js_scales(js):
    s = js["scales"]
    assert s["major"] == ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"]
    assert s["minor"] == ["A3", "B3", "C4", "D4", "E4", "F4", "G4", "A4"]
    assert s["pentatonic"] == ["C4", "D4", "E4", "G4", "A4", "C5"]
    assert s["chromatic"][0] == "B3" and s["chromatic"][1] == "C4" and s["chromatic"][-1] == "B4" and len(s["chromatic"]) == 13
    assert s["bad"] == []


def test_js_staircase_do_re_mi_in_the_first_15_kmh(js):
    """Keikyu 1000-style "do re mi": 8 asynchronous steps of rising carrier in the first 15 km/h, the segments after them kept as they were."""
    t, freqs = js["stair1"]["table"], js["stair1"]["freqs"]
    assert js["stair1"]["problems"] == []
    steps = t["segments"][:8]
    assert [s["kind"] for s in steps] == ["async"] * 8
    assert [s["fc0"] for s in steps] == freqs and [s["fc1"] for s in steps] == freqs  # each step has a constant carrier
    assert freqs == sorted(freqs) and len(set(freqs)) == 8  # low to high
    for k, s in enumerate(steps):  # 8 steps divide 0–15 km/h evenly (boundaries rounded to 0.1)
        assert s["to"] == pytest.approx(15 * (k + 1) / 8, abs=0.06)
    assert steps[-1]["to"] == 15
    rest = t["segments"][8:]  # the original first segment (async 1050 Hz) is left with only 15–34.5, the 9-pulse and wide 3-pulse segments after it are unchanged
    assert [(s["kind"], s["to"]) for s in rest] == [("async", 34.5), ("sync", 38), ("wide3", 160)]
    assert rest[0]["fc0"] == rest[0]["fc1"] == 1050


def test_js_staircase_leaves_the_carrier_curve_outside_the_range_untouched(js):
    """Replacing 10–20 km/h with steps: the carrier curve outside the range (including the truncated async ramp) must not change at all."""
    s = js["stair2"]
    assert s["problems"] == []
    for before, after in zip(s["before"], s["after"]):
        if before["v"] < 10 or before["v"] > 20:
            assert after["fc"] == pytest.approx(before["fc"], abs=0.2), before
    inside = [a["fc"] for a in s["after"] if 10 < a["v"] < 20]
    assert inside and all(fc in (200, 300, 400, 500) for fc in inside)
    assert [(g["kind"], g["to"]) for g in s["table"]["segments"]] == [("async", 10), ("async", 12.5), ("async", 15), ("async", 17.5), ("async", 20), ("async", 40), ("sync", 80), ("wide3", 160)]


def test_js_staircase_across_several_segments_and_up_to_the_top_speed(js):
    gto = js["stair3"]["gto"]
    assert gto["problems"] == []
    segs = gto["table"]["segments"]
    assert sum(1 for s in segs if s["kind"] == "async" and s["fc0"] == s["fc1"] and 150 <= s["fc0"] <= 500) >= 8
    assert segs[-1]["kind"] == "square" and segs[-1]["to"] == 160  # the later segments are still there
    tail = js["stair3"]["tail"]
    assert tail["problems"] == []
    assert [s["kind"] for s in tail["table"]["segments"]][-3:] == ["async"] * 3 and tail["table"]["segments"][-1]["to"] == 160


def test_js_staircase_rejects_unreasonable_requests_with_a_reason(js):
    e = js["stairErrors"]
    assert "At least one note" in e["empty"]
    assert "20 and 20000" in e["badFreq"]
    assert "Speed range" in e["reversed"] and "Speed range" in e["overMax"]
    assert "too narrow" in e["tooNarrow"]
    assert "too close" in e["tooCloseStart"] and "too close" in e["tooCloseEnd"]


def test_js_scale_preset_is_the_default_do_re_mi(js):
    """The do-re-mi preset: heard pitch C4–C5 (at low speed the heard pitch is twice the carrier, so the carrier is half of it), laid over 0–20 km/h."""
    t = js["scalePreset"]
    steps = t["segments"][:8]
    assert [s["kind"] for s in steps] == ["async"] * 8
    assert [s["fc0"] for s in steps] == pytest.approx([261.63 / 2, 293.66 / 2, 329.63 / 2, 349.23 / 2, 392.0 / 2, 440.0 / 2, 493.88 / 2, 523.25 / 2], abs=0.06)
    assert [s["to"] for s in steps] == [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20]
    assert [(s["kind"], s["to"]) for s in t["segments"][8:]] == [("sync", 30), ("sync", 42), ("wide3", 160)]


def test_rotor_speed_at_130_kmh_is_about_4500_rpm(js):
    row = next(d for d in js["drive"] if d["v"] == 130 and d["p"] == 2 and not d["synchronous"])
    assert row["nr"] == pytest.approx(4491, abs=2)
    assert 0.02 < row["slip"] < 0.05  # slip is about 3% in the field-weakening region
