# VVVF Lab

**An interactive lab for train traction inverters (VVVF): pick the modulation mode for every speed range, see the switching waveform and spectrum, watch a 3D motor spin, and hear the inverter sound, all synthesized from the same PWM waveform.**
A Python desktop lab plus a zero-install browser demo (open `web/index.html`).

![Web demo: induction motor, power notch P3; the spectrogram shows async, sync and wide 3-pulse stepping up one after another](docs/web_desk_induction.png)

## Try it

**Live demo:** https://jasonxig.github.io/vvvf-lab/

**Web demo (recommended, nothing to install):** you can also download this repository and double-click `web/index.html` (on Windows, `run_web.bat` works too). Open it in Chrome or Edge (tested in Edge; Firefox and Safari are untested), click the page once to enable sound, and push the master controller to hear it.

- **Master controller:** B5 … B1, N, H, P1 … P4. Drag it, click a notch, or use the keyboard (↑ ↓ / W S, Space for neutral, H to hold speed). Move it back to neutral and the inverter keeps running, so the sound continues and the pitch follows the speed slowly.
- **Mode ruler:** the speedometer, a slider for jumping to a speed, and the editor of the mode tables in one. The two lanes are the power table and the brake table, each segment is coloured by modulation kind, and the white line is the carrier frequency curve. Drag the white vertical line to jump to any speed, drag a boundary to change a speed range, and click a segment to change its modulation kind, carrier frequency or pulse count, then press "Listen" to hear it at once.
- **Scale steps:** click the ♪ beside a lane name to lay a "do re mi" run of rising asynchronous modulations over the first 15 km/h in one click.
- **3D motor:** squirrel-cage induction, surface-mounted PM, interior PM and outer-rotor PM (direct drive) motors; the faster the rotor turns the more it blurs and streaks. A new motor type only needs one rotor file; one with another topology brings its own layout and parts.
- Top right: a spectrogram and the switching waveform of the phase-A leg. It works on a phone in portrait too.

All features, keyboard shortcuts, URL parameters and the code structure are in [web/README.md](web/README.md).

![Click a segment on the ruler: change the modulation kind, carrier frequency and pulse count, then press "Listen"](docs/web_ruler_editor.png)

**Listen first (no UI needed):** `examples/` has two 18-second acceleration sweeps (speed from 0 to 130 km/h, with the modes switching automatically according to the mode table).

- `gto_sweep.wav`: GTO type, switching limit 420 Hz, the pitch drops several times, louder.
- `igbt_sweep.wav`: IGBT type, limit 1.5 kHz, a wide and high async range with only two shifts, quieter.

## Python desktop lab (P1: three-phase SPWM bench)

Drag the speed and see the switching waveform and line voltage, the line-voltage spectrum (with the double-Fourier analytic lines overlaid), the mode map (the sawtooth of carrier frequency against fundamental frequency) and a spectrogram in real time, and hear the sound.

```bash
python -m venv .venv
.venv\Scripts\activate          # Linux / macOS: source .venv/bin/activate
pip install -r requirements-dev.txt
python -m vvvflab               # start the UI
python -m pytest                # run the tests
```

Once `.venv` is set up, on Windows you can also double-click `run.bat` to start the UI. To run only the core modules and the tests, `numpy`, `scipy` and `pytest` are enough; the UI dependencies (PySide6, pyqtgraph, sounddevice) are optional. The cross-check tests for the web demo need Node.js and are skipped automatically without it.

- **Mode map:** two presets, `GTO type` (switching limit 420 Hz) and `IGBT type` (1.5 kHz), whose limits come from Nagoya University lecture notes on Shinkansen series 300 and N700; or choose "Manual" and set async, synchronous N pulses or square wave yourself.
- **Auto-accelerate:** takes the speed from 0 to 130 km/h in 18 seconds with the modes switching automatically; turn on "Play sound" to hear the carrier climb with speed and drop when it hits the limit, the "shift sound". The default volume is 30%; check it before putting on headphones.
- **Plots:** pole voltage and carrier, line voltage, line-voltage spectrum (orange circles are analytic lines), mode map (the red dot is the current operating point), and a spectrogram of the last 4 seconds.
- To re-render the sweeps yourself: `python -m vvvflab.render gto my.wav --seconds 18` (run from the project directory).

## Code structure

| File | Contents |
| --- | --- |
| `vvvflab/pwm.py` | Switching waveforms of a three-phase two-level SPWM, operating points, conversion between fundamental and reference amplitude in overmodulation |
| `vvvflab/modes.py` | Mode tables (async / synchronous N pulses / square-wave segments), the V/f curve, and the rule that generates a default table from a device limit |
| `vvvflab/spectrum.py` | FFT amplitude spectrum, double-Fourier (Bessel) analytic lines, spectrogram |
| `vvvflab/synth.py` | Real-time sound synthesis: switching waveform → current ripple → audio, with a ring buffer for the spectrogram |
| `vvvflab/app.py` | PySide6 + pyqtgraph UI and sounddevice audio output |
| `web/` | The web demo: cab deck, mode tables split by speed, real-time sound synthesis (Web Audio), 3D motor (three.js); the logic layer and the synthesis core are cross-checked against the Python version |
| `tests/` | Automated tests: waveforms, spectra against analytic solutions, mode tables, the synthesizer, a UI smoke test, and cross-checks of the web logic and sound |

## Model and known limitations

This is a model for learning and listening, not a replica of any particular train: **the positions of the spectral lines in the sound are fixed strictly by the switching waveform and have been checked against independent formulas, but the realism of loudness and timbre has not been compared with recordings of real trains.**

- Voltages are in units of Vdc/2, three-phase two-level, naturally sampled sine-triangle comparison. N must be an odd multiple of 3 for the three phases to be 120° apart with half-wave symmetry (in the web demo each phase carrier is locked to its own reference, so any odd N keeps the three phases symmetric).
- The sound uses current ripple as a proxy for the magnetic exciting force: `i_rip ∝ ∫(v − v1) dt`, i.e. it assumes the force is proportional to the current harmonics and the audible frequency equals the harmonic frequency. This is only a first assumption and needs checking against real recordings.
- In the three-phase line voltage the carrier itself (n = 0) and the sidebands whose order is a multiple of 3 cancel, so what you hear is mainly sidebands such as `fc ± 2f1`, not the carrier.
- "Pitch ≈ carrier frequency" is only an approximation: when the modulation index m is small the second carrier group `2fc ± f1` is stronger than the first group `fc ± 2f1` (the two are equally loud at m ≈ 0.7), so at low speed the pitch you hear is about twice the carrier.
- When shifting (changing N) and when going from asynchronous to synchronous the carrier phase is kept continuous to avoid clicks (the web demo then glides the synchronous carrier phase to the symmetric position within 40 ms); real trains handle this differently, and P3 will compare several switching strategies.
- In the overmodulation and few-pulse regions the Python version approximates the fundamental amplitude with the "infinite carrier ratio" formula, which is off near 3 pulses (3 pulses at m = 0.95 give an actual fundamental of only 0.64). The web demo back-solves the reference amplitude numerically for synchronous segments with N ≤ 21 so the actual fundamental equals the voltage command; the Python version has not been changed yet.
- Time-domain sampling quantizes switching edges to the sample grid: for lines above −40 dBc the error is about 0.4% at 6000 points per carrier period and up to 5.8% at 480 points.
- The preset mode tables are sketches drawn from a generation rule and do not correspond to any specific train; the conversion between speed and fundamental frequency, the gear ratio and the train dynamics are also only simplified demo models.

## Roadmap

P1 three-phase SPWM bench → P2 induction motor steady state → P3 mode-table editor and shifting strategies (release v0.1) → P4 closed loop with train dynamics → P5 PM motors and vector control → P6 loss model and inferring the modes from recordings. The web demo already has the cab deck, the mode ruler, real-time sound and a 3D motor; custom motor forms have started with the outer rotor; axial flux and linear motors come next.

## License

[MIT](LICENSE). `web/vendor/three.min.js` is [three.js](https://threejs.org) r159 (MIT, copyright the three.js authors); its license text is in [web/vendor/LICENSE-three.txt](web/vendor/LICENSE-three.txt).
