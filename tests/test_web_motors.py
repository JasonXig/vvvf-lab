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
    assert {"induction", "pmsm", "ipmsm", "outer-rotor", "axial-flux"} <= types
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
        assert 0.8 < b["zMax"] < 2.0, b["name"]


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


def field_angle_from_slots(winding, currents, pole_pairs, sense):
    """Electrical angle of the stator's field from the slot currents, counted from rotor into stator; independent of the page's own calculation.

    Ampere around a loop through the gap and the iron: the field across the gap changes by the current enclosed, dH/dθ = -K/g for a
    conductor sheet K along +Z, wherever the conductors are. With K(θ) ≈ A cos(pθ - α), the outward field H peaks at pθ = α - 90°.
    An inner rotor counts outwards from rotor to stator (sense +1), an outer rotor inwards (sense -1).
    Axial flux: positive current runs radially outwards across the front face, the same loop through the front gap gives dHz/dθ = +K/g,
    and rotor to stator is towards -Z there, so it peaks at pθ = α - 90° as well (sense +1).
    """
    a = b = 0.0
    for slot in winding["slots"]:
        k = slot["s"] * currents[slot["ph"]]
        a += k * math.cos(pole_pairs * slot["angle"])
        b += k * math.sin(pole_pairs * slot["angle"])
    assert math.hypot(a, b) > 1
    outward = math.degrees(math.atan2(b, a)) - 90
    return outward if sense > 0 else outward + 180


FIELD_SENSE = {"induction": 1, "pmsm": 1, "ipmsm": 1, "outer-rotor": -1, "axial-flux": 1}


def test_winding_currents_put_the_stator_field_where_asked(js):
    checked = 0
    for b in js["builds"]:
        if b["cutaway"] or b["type"] not in FIELD_SENSE:
            continue
        w = b["winding"]
        assert len(w["slots"]) == b["spec"]["statorSlots"]
        for theta, currents in zip(w["thetas"], w["currents"]):
            angle = field_angle_from_slots(w, currents, b["polePairs"], FIELD_SENSE[b["type"]])
            assert abs((angle - theta + 180) % 360 - 180) < 1.0, f"{b['name']}: asked for {theta}, got {angle:.1f}"
            checked += 1
    assert checked >= 20


def test_load_angles_stay_below_the_pull_out_limit(js):
    # Past 90 electrical degrees a surface-magnet motor loses torque; the defaults and presets all stay below that
    for b in js["builds"]:
        if b["synchronous"]:
            assert 0 < b["spec"]["loadAngleDeg"] < 90, b["name"]


INNER_PIECES = ["stator", "winding", "shaft", "rotorCore", "{rotor}", "housing", "endBack", "endFront"]


def test_exploded_view_pieces_cover_every_part(js):
    # Every physical mesh belongs to exactly one piece of the exploded view (only the field ring and the blur shell are not parts),
    # so a new motor type cannot forget a part; and a piece is never inside another piece
    for b in js["builds"]:
        x = b["explode"]
        assert x["untagged"] == 0, f"{b['name']}: {x['untagged']} meshes are not in any piece"
        assert x["nested"] == 0, f"{b['name']}: a piece inside another piece"
        ids = [p["id"] for p in x["pieces"]]
        assert len(ids) == len(set(ids))


@pytest.mark.parametrize("motor_type, rotor_piece", [("induction", "cage"), ("pmsm", "magnets"), ("ipmsm", "magnets")])
def test_inner_rotor_pieces(js, motor_type, rotor_piece):
    for b in builds_of(js, motor_type):
        ids = [p["id"] for p in b["explode"]["pieces"]]
        assert ids == [rotor_piece if i == "{rotor}" else i for i in INNER_PIECES], b["name"]


def test_outer_rotor_pieces(js):
    for b in builds_of(js, "outer-rotor"):
        pieces = {p["id"]: p for p in b["explode"]["pieces"]}
        assert list(pieces) == ["stator", "winding", "drum", "magnets", "spindle"]
        assert pieces["spindle"]["dist"] == 0, "the spindle is the fixed part"
        assert pieces["drum"]["objects"] == 2, "the hub and markers come off with the drum"
        assert pieces["drum"]["dir"] == [0, 0, 1] and pieces["stator"]["dir"] == [0, 0, -1]


def test_axial_flux_pieces(js):
    for b in builds_of(js, "axial-flux"):
        pieces = {p["id"]: p for p in b["explode"]["pieces"]}
        assert list(pieces) == ["stator", "winding", "shaft", "discFront", "magnetsFront", "discBack", "magnetsBack", "housing", "endBack", "endFront"]
        assert pieces["stator"]["dist"] == 0
        # the stack comes apart along the axis, symmetrically: magnets first, then the discs further out, then the end shields
        for side, sign in (("Front", 1), ("Back", -1)):
            assert pieces["disc" + side]["dir"] == [0, 0, sign] and pieces["magnets" + side]["dir"] == [0, 0, sign]
            assert pieces["magnets" + side]["dist"] < pieces["disc" + side]["dist"] < pieces["end" + side]["dist"]
        assert "cannot be lifted off" in pieces["winding"]["info"]["note"]


def test_axial_flux_is_cut_through_the_front_disc_only(js):
    # The notch goes through the front disc and its magnets, which turn: clipping planes on one disc and one set of magnets; stator and back disc stay whole
    for b in builds_of(js, "axial-flux"):
        assert b["clipped"] == (b["spec"]["poles"] + 1 if b["cutaway"] else 0), b["name"]


def test_axial_flux_defaults(js):
    b = next(b for b in js["builds"] if b["name"] == "axial-flux (default)" and b["cutaway"])
    s = b["spec"]
    assert b["synchronous"] and b["polePairs"] == 8 and s["drivetrain"]["gearRatio"] == 1, "a direct drive"
    assert s["innerRadius"] / s["outerRadius"] == pytest.approx(1 / math.sqrt(3), abs=0.01), "the ratio that gives the most torque when current is limited at the inner radius"
    cards = {p["id"]: p["info"] for p in b["explode"]["pieces"]}
    assert cards["stator"]["facts"][0].startswith("48 slots on each face, 1 per pole per phase")
    assert cards["magnetsFront"]["facts"][0].startswith("16 magnets on this disc, so the rotor turns once every 8 cycles")
    assert cards["shaft"]["facts"][0] == f"Direct drive (gear ratio 1): {round(100 / 3.6 / (math.pi * 0.86) * 60)} rpm at 100 km/h"
    # a pancake: much wider than it is long, not counting the short shaft ends
    assert s["yokeThickness"] + 2 * (s["slotDepth"] + s["airGap"] + s["magnetThickness"] + s["discThickness"]) < s["outerRadius"]


def test_exploded_view_paths_and_cards(js):
    for b in js["builds"]:
        pieces = b["explode"]["pieces"]
        assert sum(p["dist"] == 0 for p in pieces) == 1, f"{b['name']}: exactly one piece stays put, the others come off it"
        for p in pieces:
            assert math.isclose(math.hypot(*p["dir"]), 1.0, abs_tol=1e-9)
            assert 0 <= p["dist"] < 6 and p["step"] in (0, 1, 2)
            assert p["name"] and len(p["info"]["role"]) > 40 and p["info"]["material"], f"{b['name']} / {p['id']}: the card needs a name, a role and a material"
            assert isinstance(p["info"]["facts"], list) and all(isinstance(f, str) and f for f in p["info"]["facts"])
        # what comes off first (step 0) goes further than what is inside it, so the covers are out of the way
        by_id = {p["id"]: p for p in pieces}
        if "rotorCore" in by_id:
            assert by_id["endFront"]["dist"] > by_id[next(i for i in ("cage", "magnets") if i in by_id)]["dist"] > by_id["rotorCore"]["dist"]


def test_exploded_view_cards_use_the_motor_definition(js):
    ind = next(b for b in js["builds"] if b["name"] == "induction (default)" and b["cutaway"])
    cards = {p["id"]: p["info"] for p in ind["explode"]["pieces"]}
    assert cards["stator"]["facts"][0] == "36 slots"
    assert cards["stator"]["facts"][1].startswith("3 slots per pole per phase")
    assert cards["cage"]["facts"][0].startswith("28 bars against 36 stator slots")
    assert "cannot be pulled out" in cards["cage"]["note"], "the card says where the exploded view is not literal"
    # 100 km/h with the 0.86 m wheel and gear ratio 5.6: written out independently
    rpm = round(100 / 3.6 / (math.pi * 0.86) * 5.6 * 60)
    assert cards["shaft"]["facts"][0].startswith(f"At 100 km/h it turns at {rpm} rpm")
    outer = next(b for b in js["builds"] if b["name"] == "outer-rotor (default)" and b["cutaway"])
    cards = {p["id"]: p["info"] for p in outer["explode"]["pieces"]}
    assert cards["drum"]["facts"][0] == f"Direct drive (gear ratio 1): {round(100 / 3.6 / (math.pi * 0.86) * 60)} rpm at 100 km/h"
    assert cards["magnets"]["facts"][0].startswith("16 magnets, so the rotor turns once every 8 cycles")


@pytest.mark.parametrize(
    "key, words",
    [
        ("outerStatorTooBig", "will not fit"),
        ("outerYokeTooThin", "yoke is too thin"),
        ("outerSpindleTooBig", "room for the stator support"),
        ("outerDrumTooThin", "drum is too thin"),
        ("innerShaftTooBig", "rotor will not fit"),
        ("oddPoles", "even number"),
        ("loadAngleTooBig", "electrical degrees"),
        ("axialTooNarrow", "active ring is too narrow"),
        ("axialShaftTooBig", "below innerRadius"),
        ("unknownType", "outer-rotor"),
    ],
)
def test_bad_definitions_are_refused_with_a_message(js, key, words):
    msg = js["errors"][key]
    assert msg is not None, f"{key} should have been refused"
    assert words in msg
