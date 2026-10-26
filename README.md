# VVVF Lab

**An interactive lab for train traction inverters (VVVF): pick the modulation mode for every speed range, see the switching waveform and spectrum, watch a 3D motor spin, and hear the inverter sound — all synthesized from the same PWM waveform.**
Python desktop lab + a zero-install browser demo (open `web/index.html`).

列车牵引变流器（VVVF）的交互式模拟与声谱分析平台：自己决定每个速度段用什么调制（异步载波、同步 N 脉冲、宽 3 脉冲、方波），实时看开关波形与频谱，看 3D 电机转起来，并听到由同一套开关波形合成的逆变器声音。

![网页版：笼型异步电机，牵引 P3，声谱图里能看到异步、同步、宽 3 脉冲依次换挡](docs/web_desk_induction.png)

## 试一试

**在线试玩**：https://jasonxig.github.io/vvvf-lab/

**网页版（推荐，不用装任何东西）**：也可以下载本仓库，双击 `web/index.html`（Windows 上也可以双击 `run_web.bat`）。用 Chrome 或 Edge 打开（Edge 里测过；Firefox 和 Safari 没测过），点一下页面启用声音，推一下主手柄就能听到。

- **主手柄**：B5 … B1、N、H、P1 … P4，拖动、点格子或用键盘（↑ ↓ / W S，空格回空档，H 定速）。松回空档，逆变器仍在运转，声音持续，音调随车速缓慢变化。
- **模式标尺**：既是速度表，也是拖动跳速的滑杆，还是模式表的编辑器。上下两条泳道是力行表和制动表，每段按调制方式上色，白线是载波频率曲线；拖白色竖线跳到任意车速，拖分界线改速度范围，点一段改调制方式、载波频率或脉冲数，按“试听”马上听到。
- **音阶台阶**：点泳道名旁的 ♪，一键在前 15 km/h 铺出“哆来咪”那样一级一级往上的异步调制。
- **3D 电机**：笼型异步、表贴式永磁、内置式永磁三种，转速越高转子越模糊并出现拖影；新增一种电机只需要写一个转子文件。
- 右上角是声谱图和 A 相桥臂的开关波形，手机竖屏也能用。

全部功能、键盘、网址参数和代码结构见 [web/README.md](web/README.md)。

![点标尺上的一段：改调制方式、载波频率、脉冲数，按“试听”马上听到](docs/web_ruler_editor.png)

**先听一听（不用开界面）**：`examples/` 里有两段 18 秒的加速扫频（速度从 0 加到 130 km/h，模式按模式表自动切换）。

- `gto_sweep.wav`：GTO 型，开关频率上限 420 Hz，音调多次骤降，音量更大。
- `igbt_sweep.wav`：IGBT 型，上限 1.5 kHz，异步段又宽又高，只换挡两次，音量更小。

## Python 桌面版（P1：三相 SPWM 实验台）

拖动速度，实时看到开关波形与线电压、线电压频谱（叠加双重傅里叶解析谱线）、模式图（载波频率随基波频率的锯齿）和声谱图，并听到声音。

```bash
python -m venv .venv
.venv\Scripts\activate          # Linux / macOS：source .venv/bin/activate
pip install -r requirements-dev.txt
python -m vvvflab               # 启动界面
python -m pytest                # 运行测试
```

装好 `.venv` 之后，Windows 上也可以直接双击 `run.bat` 启动界面。只想跑核心模块和测试时，装 `numpy`、`scipy`、`pytest` 就够了，界面依赖（PySide6、pyqtgraph、sounddevice）不是必须的；网页版的对账测试需要 Node.js，没装会自动跳过。

- **模式表**：`GTO 型`（开关频率上限 420 Hz）和 `IGBT 型`（1.5 kHz）两个预设，上限取自 Nagoya 大学 Furuhashi 课件里新干线 300 系与 N700 系的数据；也可以选“手动设置”，自己指定异步、同步 N 脉冲或方波。
- **自动加速**：18 秒内把速度从 0 拉到 130 km/h，模式按模式表自动切换，打开“播放声音”就能听到载波随速度爬升、触顶骤降的“换挡声”。默认音量 30%，戴耳机请先确认音量。
- **图**：极电压与载波、线电压、线电压频谱（橙色圆圈是解析谱线）、模式图（红点是当前工作点）、最近 4 秒的声谱图。
- 自己重新渲染扫频：`python -m vvvflab.render gto my.wav --seconds 18`（在项目目录里运行）。

## 代码结构

| 文件 | 内容 |
| --- | --- |
| `vvvflab/pwm.py` | 三相两电平 SPWM 开关波形、工作点、过调制时基波幅值与参考波幅值的换算 |
| `vvvflab/modes.py` | 模式表（异步 / 同步 N 脉冲 / 方波分段）、V/f 曲线、按器件上限生成默认模式表的规则 |
| `vvvflab/spectrum.py` | FFT 幅值谱、双重傅里叶（贝塞尔）解析谱线、声谱图 |
| `vvvflab/synth.py` | 实时声音合成：开关波形 → 电流纹波 → 音频，带环形缓冲供声谱图使用 |
| `vvvflab/app.py` | PySide6 + pyqtgraph 界面与 sounddevice 音频输出 |
| `web/` | 网页版：运转台、按车速分段的模式表、实时声音合成（Web Audio）、3D 电机（three.js）；逻辑层和声音合成核心与 Python 版互相对账 |
| `tests/` | 波形、频谱与解析解对照、模式表、合成器、界面冒烟、网页逻辑与声音对账的自动化测试 |

## 模型与已知限制

这是学习和试听用的模型，不是对某个具体车型的复刻：**声音的谱线位置由开关波形严格决定，已用独立公式核对；但响度和音色的真实感还没有拿真实车辆录音对比过。**

- 电压单位为 Vdc/2，三相两电平，自然采样的正弦–三角比较。N 取 3 的奇数倍，三相波形才互为 120° 平移且半波对称（网页版每相的载波锁在自己的参考波上，任意奇数 N 都能保持三相对称）。
- 声音取电流纹波作为磁励力的代理量：`i_rip ∝ ∫(v − v1) dt`，即假设磁励力正比于电流谐波、可听频率等于谐波频率。这只是第一个假设，要靠真实录音检验。
- 三相线电压里载波本身（n = 0）和 3 的倍数次边带相互抵消，所以可听的主要是 `fc ± 2f1` 这类边带，而不是载波。
- “音调 ≈ 载波频率”只是近似：调制比 m 很小时，第二载波组 `2fc ± f1` 比第一组 `fc ± 2f1` 更强（两组在 m ≈ 0.7 一样响），所以低速时听到的音高约是载波的 2 倍。
- 换挡（改变 N）和异步转同步时保持载波相位连续，避免咔嗒声（网页版随后还会把同步载波的相位在 40 ms 内滑到对称位置）；真实车辆的处理策略不同，P3 会比较几种切换策略。
- 过调制和低脉冲数区域，Python 版的基波幅值按“载波比趋于无穷”的公式近似，3 脉冲附近会有偏差（三脉冲、m = 0.95 时实际基波只有 0.64）。网页版对 N ≤ 21 的同步段数值反解参考波幅值，让实际基波等于电压指令；Python 版还没改。
- 时域采样把开关边沿量化到采样网格上：高于 −40 dBc 的谱线偏差在每载波周期 6000 点时约 0.4%，480 点时可达 5.8%。
- 预设模式表是按生成规则画出的示意，不对应任何具体车型；速度与基波频率的换算、传动比、列车动力学也只是演示用的简化。

## 路线

P1 三相 SPWM 实验台 → P2 感应电机稳态 → P3 模式表编辑器与切换策略（发布 v0.1）→ P4 列车动力学闭环 → P5 永磁电机与矢量控制 → P6 损耗模型与录音反推。网页版目前已有运转台、模式标尺、实时声音和 3D 电机，下一步是自定义电机形式（外转子、轴向磁通、直线）。

## 许可证

[MIT](LICENSE)。`web/vendor/three.min.js` 是 [three.js](https://threejs.org) r159（MIT，版权属于 three.js 作者），许可证文本见 [web/vendor/LICENSE-three.txt](web/vendor/LICENSE-three.txt)。
