"""网页版声音合成核心（web/js/synth.js）与 Python 版 DriveSynth 对账。没装 Node.js 时整个文件跳过。"""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from vvvflab.pwm import make_point
from vvvflab.spectrum import amplitude_spectrum, double_fourier_lines
from vvvflab.synth import DriveSynth

NODE = shutil.which("node")
SCRIPT = Path(__file__).resolve().parents[1] / "web" / "tests" / "dump_synth.js"
FS = 48000

pytestmark = pytest.mark.skipif(NODE is None, reason="没有安装 Node.js")


@pytest.fixture(scope="module")
def js(tmp_path_factory):
    out = tmp_path_factory.mktemp("jsaudio") / "audio.bin"
    result = subprocess.run([NODE, str(SCRIPT), str(out)], capture_output=True, text=True, encoding="utf-8", check=True, timeout=120)
    meta = json.loads(result.stdout)
    data = np.fromfile(out, dtype="<f4").astype(float)
    meta["audio"] = {c["name"]: data[i * meta["keep"] : (i + 1) * meta["keep"]] for i, c in enumerate(meta["cases"])}
    return meta


def python_reference(case):
    op = make_point(case["f1"], case["kind"], m=case["m"], fc=case["fc"], n=case["n"])
    synth = DriveSynth(FS, soft_start=False)
    synth.set_volume(0.5)
    synth._gain = 0.5
    synth.set_target(op)
    synth.render(FS // 2)
    return synth.render(FS).astype(float)


def peak(amps, f):
    i = int(round(f))
    return amps[i - 1 : i + 2].max()


def rms(x):
    return float(np.sqrt(np.mean(x**2)))


@pytest.mark.parametrize("name", ["async", "sync15", "sync9", "wide3", "square"])
def test_js_synth_matches_python_synth(js, name):
    case = next(c for c in js["cases"] if c["name"] == name)
    mine, ref = js["audio"][name], python_reference(case)
    assert rms(mine) == pytest.approx(rms(ref), rel=0.03)
    _, a_js = amplitude_spectrum(mine, FS, "hann")
    _, a_py = amplitude_spectrum(ref, FS, "hann")
    strongest = [i for i in np.argsort(a_py[:6000])[::-1][:8]]
    assert len(strongest) == 8
    for i in strongest:
        assert a_js[i - 1 : i + 2].max() == pytest.approx(a_py[i - 1 : i + 2].max(), rel=0.04), (name, i)


def test_js_async_carrier_is_heard_as_sidebands(js):
    case = next(c for c in js["cases"] if c["name"] == "async")
    _, amps = amplitude_spectrum(js["audio"]["async"], FS, "hann")
    f1, fc = case["f1"], case["fc"]
    assert peak(amps, fc - 2 * f1) > 5 * peak(amps, fc)
    assert peak(amps, fc + 2 * f1) > 5 * peak(amps, fc)


@pytest.mark.parametrize("name", ["sync15", "sync9"])
def test_js_sync_sidebands_are_present_and_the_carrier_itself_is_cancelled(js, name):
    case = next(c for c in js["cases"] if c["name"] == name)
    f1, n = case["f1"], case["n"]
    _, amps = amplitude_spectrum(js["audio"][name], FS, "hann")
    floor = np.median(amps[200:4000])
    for f in ((n - 2) * f1, (n + 2) * f1):
        assert peak(amps, f) > 20 * floor, (name, f)
    assert peak(amps, n * f1) < 0.1 * peak(amps, (n - 2) * f1)


def test_js_three_phase_is_balanced_for_n_not_multiple_of_3(js):
    """N = 7 不是 3 的倍数。每相的载波锁在自己的参考波上，三相仍然严格互差 120°：
    相电压里只有“奇次且不是 3 的倍数”的谐波，偶次和 3 的倍数次都消失。"""
    case = next(c for c in js["cases"] if c["name"] == "sync7")
    f1 = int(case["f1"])
    audio = js["audio"]["sync7"]  # 正好 45 个基波周期，谐波落在整数 bin 上
    spec = np.abs(np.fft.rfft(audio)) * 2 / len(audio)
    orders = range(5, 4000 // f1)  # 100 Hz 高通会滤掉低次，从 5 次起看
    allowed = [spec[h * f1] for h in orders if h % 2 == 1 and h % 3 != 0]
    forbidden = [spec[h * f1] for h in orders if h % 2 == 0 or h % 3 == 0]
    assert max(allowed) > 0
    assert max(forbidden) < 0.02 * max(allowed)


def test_js_three_pulse_fundamental_is_cancelled_only_with_calibrated_modulation(js):
    """宽 3 脉冲时，减掉的“基波”必须是输出里真实存在的那个，否则基波会以一条单独的谱线漏进声音里。
    cal 用反解出的参考波幅值（实际基波 = v1），raw 按大载波比的公式取 m = v1（实际基波只有 v1 的 2/3）。"""
    f1 = int(next(c for c in js["cases"] if c["name"] == "wide3cal")["f1"])  # 正好 150 个周期，谐波落在整数 bin 上

    def leak(name):
        spec = np.abs(np.fft.rfft(js["audio"][name])) * 2 / len(js["audio"][name])
        return spec[f1] / max(spec[5 * f1], spec[7 * f1])

    assert leak("wide3cal") < 0.01  # 比最强的谐波低 40 dB 以上
    assert leak("wide3raw") > 5 * leak("wide3cal")


def test_js_synth_is_fast_enough_for_real_time(js):
    assert js["renderSeconds"] < 0.5 * js["audioSeconds"]
