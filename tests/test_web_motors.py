"""Build every 3D motor type of the web page in Node (web/tests/dump_motors.js) and check the result. Skipped if Node.js is not installed."""
import json
import math
import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
SCRIPT = Path(__file__).resolve().parents[1] / "web" / "tests" / "dump_motors.js"

pytestmark = pytest.mark.skipif(NODE is None, reason="Node.js is not installed")


@pytest.fixture(scope="module")
def js():
    result = subprocess.run([NODE, str(SCRIPT)], capture_output=True, text=True, encoding="utf-8", check=True, timeout=120)
    return json.loads(result.stdout)


def builds_of(js, motor_type):
    return [b for b in js["builds"] if b["type"] == motor_type]


def test_every_type_and_preset_builds(js):
    types = {t["type"] for t in js["types"]}
    assert {"induction", "pmsm", "ipmsm", "outer-rotor"} <= types
    for t in types:
        assert len(builds_of(js, t)) >= 2, f"{t}: the default and each preset, with the cut-away on and off"
    for b in js["builds"]:
        assert b["ok"], f"{b['name']} cutaway={b['cutaway']}: {b.get('error')}"
        assert b["finite"], f"{b['name']}: NaN or infinity in the geometry"
        assert b["meshes"] > 10
        assert all(label["finite"] for label in b["labels"]) and len(b["labels"]) >= 4


def test_motors_fit_the_camera_framing(js):
    # The camera frames each motor by its bounding sphere; keep every type within the size the layout and labels were designed for
    for b in js["builds"]:
        assert 0.9 < b["rMaxXY"] < 1.2, b["name"]
        assert 1.2 < b["zMax"] < 2.0, b["name"]


def test_inner_rotor_types_are_cut_in_their_geometry(js):
    # The stator and housing do not turn, so the notch is in their geometry: fewer meshes with the cut-away, and no clipping planes
    for t in ("induction", "pmsm", "ipmsm"):
        for b in builds_of(js, t):
            assert b["clipped"] == 0
        by_name = {}
        for b in builds_of(js, t):
            by_name.setdefault(b["name"], {})[b["cutaway"]] = b["meshes"]
        for name, m in by_name.items():
            assert m[True] < m[False], f"{name}: the cut-away should drop the end turns inside the notch"


def test_outer_rotor_is_cut_with_clipping_planes(js):
    # The drum turns, so the notch cannot be in its geometry: drum, end plate, every magnet and the rim markers are clipped in world space,
    # only with the cut-away on; the stator stays whole either way (same mesh count)
    for b in builds_of(js, "outer-rotor"):
        poles = b["spec"]["poles"]
        if b["cutaway"]:
            assert b["clipped"] == poles + 4, b["name"]  # magnets + drum + end plate + two markers
        else:
            assert b["clipped"] == 0, b["name"]
    meshes = {}
    for b in builds_of(js, "outer-rotor"):
        meshes.setdefault(b["name"], set()).add(b["meshes"])
    assert all(len(m) == 1 for m in meshes.values())


def test_outer_rotor_defaults(js):
    b = next(b for b in builds_of(js, "outer-rotor") if b["name"] == "outer-rotor (default)" and b["cutaway"])
    s = b["spec"]
    assert b["synchronous"] and b["polePairs"] == s["poles"] / 2 == 8
    assert s["drivetrain"]["gearRatio"] == 1, "direct drive"
    assert s["drivetrain"]["wheelDiameter"] == 0.86, "the rest of the drivetrain is the shared default"
    # radii from the axis outwards: spindle < stator support < slot bottoms < tooth tips < air gap < magnets < drum
    assert s["shaftRadius"] < s["statorInnerRadius"] < s["statorRadius"] - s["slotDepth"] < s["statorRadius"]
    assert s["statorRadius"] + s["airGap"] + s["magnetThickness"] < s["outerRadius"]
    assert math.isclose(b["rMaxXY"], s["outerRadius"] + 0.012, abs_tol=1e-6), "the blur shell is the outermost part"
    texts = [label["text"] for label in b["labels"]]
    assert any("spindle" in t for t in texts) and any("drum" in t for t in texts) and any("slots facing out" in t for t in texts)


def test_each_layout_has_only_its_own_dimensions(js):
    keys = js["defaultKeys"]
    for t in ("induction", "pmsm", "ipmsm"):
        assert "boreRadius" in keys[t] and "statorRadius" not in keys[t]
    assert "boreRadius" not in keys["outer-rotor"]
    assert {"statorRadius", "statorInnerRadius", "outerRadius"} <= set(keys["outer-rotor"])


@pytest.mark.parametrize(
    "key, words",
    [
        ("outerStatorTooBig", "will not fit"),
        ("outerYokeTooThin", "yoke is too thin"),
        ("outerSpindleTooBig", "room for the stator support"),
        ("outerDrumTooThin", "drum is too thin"),
        ("innerShaftTooBig", "rotor will not fit"),
        ("oddPoles", "even number"),
        ("unknownType", "outer-rotor"),
    ],
)
def test_bad_definitions_are_refused_with_a_message(js, key, words):
    msg = js["errors"][key]
    assert msg is not None, f"{key} should have been refused"
    assert words in msg
