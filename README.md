<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 视频工作台——把本机视频工厂（TTS / AI 配乐 / ducking 混音 / Remotion 渲染 / 9 类质检 / 主题脚手架 / 逃生舱）还原为 10 个通用原语工具，使模型能在会话内造任意视频而非复刻既有范式
  inject: 'tools'（jobs 是可选服务，刻意不进 inject——inject 是激活门；改用 ctx.get('jobs')，缺则降级前台）
  tools: video_env,video_catalog,video_scaffold,video_render,video_tts,video_bgm,video_mix,video_qa,video_cover,video_run
  runtime: host-only
  envDeps: 视频工厂工作空间资产（tools/：TS 与 VLM 两套 Python 环境 + ~9.7G 模型 + ffmpeg，不入 git）+ Node；脚手架另需 bash + npm + 网络
  boundary: 会写视频工厂目录（项目产物 out/、public/audio/、新项目目录、props 临时文件），**不删除既有文件**；**不是沙箱**——脚本自身的权限就是它的权限
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools ^0.1.0-rc.6（jobs 走 ctx.get 可选服务）
-->
# dsh-video-studio

<p align="center">
  <a href="https://github.com/jonah791/dsh-video-studio"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-22%20passed-brightgreen" alt="tests">
</p>

**一句话**：把本机「AI 视频自动化工厂」接进 DSH——10 个工具覆盖建项目、渲染任意 Remotion 组合、配音/配乐/混音、9 类质检、按登记契约跑任意脚本。

**为什么值得用**：把视频工厂当「流水线封装」用，就只能在既有范式里出片。本插件把它还原成**通用原语**——`video_scaffold` 用 23 个主题里任意一个建空骨架，`video_render` 把**任意 props** 喂给任意组合（写一次组件，喂不同数据出不同片），`video_run` 作为逃生舱让你按登记契约跑**未封装**的脚本与 flag。长任务走 DSH 官方 `ctx.jobs`（用既有 `job_output`/`job_kill` 收集，不另造 job 协议），参数一律数组传参（工作空间路径含空格，shell 拼接必踩引号地狱）。

## 能力

| 工具 | 用途（工具描述要点） |
|------|---------------------|
| `video_env` | 视频工厂环境体检：音频/视觉解释器、模型资产、技能真源是否就位，并列出可用主题数与已有项目。跑任何视频任务前用它确认前提（`tools/` 全部不入 git，换机需重新获取） |
| `video_catalog` | 能力清单：可用主题（建新项目用）、已有项目及其 Remotion 组合（渲染用）、全部脚本登记（id/用途/解释器/参数/已知陷阱）。这决定你能造出什么视频。`section` 可取 `all`/`themes`/`projects`/`scripts` |
| `video_scaffold` | 用任意主题新建一个 Remotion 视频项目（23 主题可选：neon-cyber / swiss-ikb / terminal-green / newsroom …）。这是「造任意视频」的起点：产出可编译的空骨架（含设计系统 tokens）。慢（`npx create-video` + `npm install`），默认后台执行 |
| `video_render` | 渲染任意项目的任意 Remotion 组合为 MP4。支持传入 props（同一组合渲染出不同内容）、指定分辨率/帧率/编码/帧区间。慢，默认后台执行 |
| `video_tts` | 文本（Markdown）→ 口播音频，可指定任意输入输出目录 |
| `video_bgm` | AI 配乐：任意时长/风格/自定义 prompt/种子/输出 |
| `video_mix` | 口播 + BGM ducking 混音（阈值/比率/淡出/EQ 可调） |
| `video_qa` | 9 类质检：`render` / `video` / `vlm` / `asr` / `aesthetic` / `rhythm` / `sensitive` / `bgm` / `sync` |
| `video_cover` | 封面 still + 尺寸/黑屏校验 |
| `video_run` | **逃生舱**：按登记契约跑任意脚本并原样追加参数——未封装的 flag 与新脚本不必等插件升级 |

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-video-studio": "link:<工作区>/self-plugins/dsh-video-studio"
```

**2) 挂组合**（agent 预设行；`studioRoot` 必须显式给——它是部署相关值，源码默认是空串）：

```yaml
- insert:
    - id: agent-video-studio
      name: dsh-video-studio
      config:
        studioRoot: <视频工厂根>
        defaultProject: projects/news-flash
```

**3) 30 秒验证**：

```
video_env
video_catalog section=themes
```

期望：`video_env` 返回解释器/模型/ffmpeg 的就位状态与 `missing` 清单（**缺失会如实报，不是故障**），并给出可用主题数；`video_catalog` 返回主题清单。这两步都很快、无副作用——**先体检再渲染**，别把 600s 的超时预算花在缺资产的渲染上。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `studioRoot` | `''`（空） | 视频工厂根目录。**刻意不设默认路径**（写死会在别的部署上静默指向错误目录）；未配置时工具返回明确错误而不是猜路径 |
| `defaultProject` | `'projects/news-flash'` | 省略 `project` 参数时的默认项目 |
| `timeoutMs` | `600000` | 前台执行超时（10 分钟） |
| `outputLimitBytes` | `65536` | 单次返回的输出上限（防日志打爆上下文） |
| `enableLongJobs` | `true` | 长任务是否走 DSH 后台 job |

## 落盘与自证（出问题时先看这里）

**本插件无侧车轨迹**（`<DSH_HOME>/video-studio-trace.jsonl` 之类尚不存在）：它的可观测面是**产物文件**与工具的返回值。

| 落点 | 说明 |
|------|------|
| `<projectDir>/out/<composition>-<stamp>.mp4` | `video_render` 默认输出（stamp = ISO 时间去符号取前 15 字） |
| `<projectDir>/.dsh-video-props.json` | `video_render` 的 props 临时文件（避免 argv 转义；写在项目目录内，注意别被 git 跟踪） |
| `<defaultProject>/public/audio/*` | `video_tts` 默认输出（输入默认 `docs/content/script.md`） |
| `docs/content/audio/bgm.wav` | `video_bgm` 默认输出 |
| 混音输出目录 | `video_mix` 自动 `mkdirSync` |
| 新项目目录 | `video_scaffold` 产出可编译骨架（含设计系统 tokens） |

**声明边界**：会写视频工厂目录，**不删除既有文件**。

**一条命令答五问**（无 trace 时的行为级等价物）：

```bash
ls -l <projectDir>/out/ | tail -3; cat <projectDir>/.dsh-video-props.json
# ① 线上跑的是哪个构建 → 无 build 字段：比 lib/index.js mtime 与 web 进程启动时间（见「生效判据」）
# ② 谁发起 / 跑的什么   → 无 caller 字段；`.dsh-video-props.json` + `out/*.mp4` 的命名（含组合名与时间戳）是唯一身份锚
# ③ 断在哪一段         → 阶段枚举由返回值给出：requireRoot(未配置根目录→明确错误) → 解释器/资产缺失(video_env 的 missing) → buildArgs(参数构造) → 子进程(前台 exitCode / 后台 jobId)
# ④ 结果质量           → 前台看 exitCode + stdout + truncated；后台看 jobId → job_output；渲染另看 out/*.mp4 大小（probe 按「非空文件」判定）
# ⑤ 耗时与预算         → 前台 timeoutMs=600000；后台走 DSH job（无本插件级耗时字段）
```

**退出码语义不统一是源脚本的属性**（非本插件所致）：`render-qa` 无参 = 2、`rhythm-check` FAIL = 2、`asr-check` / `sync-durations --check` 用非 0 表示「提示」。`video_qa` **原样透出** `code`，不替脚本重新解释——判定 PASS/FAIL 时请结合 `kind` 一起读。

## 生效判据与回退

**生效判据**（三选一）：
1. 行为级：`video_env` 可调用并返回体检结果（解释器/资产/主题数），10 个 `video_*` 工具都在工具面；
2. 产物级：`lib/index.js` 的 mtime **早于** web 进程启动时间 ⇒ 当前进程加载的是这份产物；
3. 生态级：`plugin_boot_status`（`dsh-plugin-bootreport`）的 `live` 含 `dsh-video-studio`、`stale` 为空 ⇒ 判据 2 的机器化版本。

> 注意：**重新构建 ≠ 生效**——`npm run build` 只是写了一个新产物，**进程启动时间必须晚于产物 mtime** 才算「在跑它」。缺这一条时不得宣称「已生效」。

**回退**：
- 源码级：`git -C self-plugins/dsh-video-studio revert <commit>` → 重新构建 → 预检 → 重启；
- 组合级：预设里给 `agent-video-studio` 行加 `disabled: true`（或移除该行）→ 哨兵重启；
- 运行期：本插件**只增不删**（不清既有文件），回退后已有产物仍可用；如需清理，手工删 `out/` 与 `.dsh-video-props.json` 即可。

## 测试

```bash
npm test        # = node --test tests/registry.test.mjs tests/schema.test.mjs（跑 lib/ 产物）
```

**22 例离线测试**（22/22 通过）：

- `tests/registry.test.mjs` —— 脚本契约与 argv 纯函数：`buildArgs` 的位置参数顺序、`0` 不被裁掉、`true` 渲染成裸 flag、数字以空格分隔（兼容手写 argv 的 `render-qa.py`）；**契约守卫**：三个易错点（`--out` 必须绝对路径、`fetch` 脚本恒返回 0、`--expect-lufs` 用空格分隔）仍被登记表标注——改动登记表若删掉这些标注，测试转红；`parseCompositions` / `summarizeEnv` 的退化输入（无声明 → 空数组，不抛）；
- `tests/schema.test.mjs` —— 工具面与返回值：注册恰 10 个工具且都在 `video_` 命名空间；**尸体样本**（前台返回、后台返回、最小返回）必须过自己的 `output.schema`；`truncated` / `label` 等边界字段齐全。

**离线单测不需要视频工厂资产、不需要 Python、不需要 ffmpeg、不需要网络、不需要 Node 以外的任何外部依赖**——纯函数 + schema 校验，任意环境可跑。**但插件的真实功能需要它们**：跑渲染/配音/配乐需要 `studioRoot` 指向的工作空间内 `tools/` 资产就位（约 9.7G 模型 + 两套 Python 环境，不入 git，换机须按该工作空间的 `tools/README.md` 重新获取），`video_scaffold` 另需 bash + npm + 网络。缺资产时 `video_env` 会**如实报缺**，不会静默失败。

## 设计要点

- **`jobs` 刻意不进 `inject`**：cordis 的 `inject` 是**激活门**（未提供则插件不激活）——把可选服务写进去，会让「没有 jobs 的部署」整个插件不激活。故改用 `ctx.get('jobs')`，缺 jobs 时全部降级为前台执行。**这是可选服务接入的标准姿势**。
- **长任务复用官方 job 协议**：渲染/合成/脚手架/VLM 审片返回 `jobId`，用**既有**的 `job_output` / `job_kill` 收集与终止——不另造 job 协议，避免生态里出现第二套任务语义。
- **一律 `spawn(command, argsArray)`**：工作空间路径含空格，shell 拼接必踩引号地狱；数组传参零转义。（源码里 `shell: true` 零命中，且 `rg "spawn\("` 只有数组形式两处。）
- **props 走临时文件而不是 argv**：结构化 props 经命令行传参会在跨层（Windows → bash → Python/Node）中被转义破坏，故写 `<projectDir>/.dsh-video-props.json` 让脚本自己读。
- **路径参数强制绝对化**：`generate-bgm.py` / `fetch-ai-news.py` 的 `--out` 按 **CWD** 解析，不绝对化就会写偏——这是登记表里被测试守卫锁住的一条契约。
- **不复制 `@deepseek-ai/*` 到本地**：`.npmrc` 禁 peer 自动安装，运行时解析向上走到宿主链接层——避免「模块双实例」（一份代码两个 `instanceof` 世界）。
- **参数构造纯函数化（`buildArgs`）**：位置参数顺序、空值裁剪、`--flag value` 空格分隔全在纯函数里，因此离线可测——新增脚本契约时把构造逻辑放这里，不要写进工具闭包。
- **`studioRoot` 默认空串是刻意设计**：部署相关值写死默认路径会在别的部署上**静默指向错误目录**；宁可返回明确错误。

### 已知边界（诚实声明）

- **不是沙箱**：插件只负责调用视频工厂脚本，脚本自身的权限就是它的权限。
- **依赖本机资产**：`tools/` 不入 git，换机须按该工作空间的 `tools/README.md` 重新获取；`video_env` 会如实报缺。
- **脚手架需 bash + npm + 网络**：`scaffold.sh` 依赖它们；WSL 不可用且无 git-bash 的环境下会明确报错。
- **退出码语义不统一**（源脚本如此）：见「落盘与自证」中的说明，`video_qa` 原样透出，不替脚本解释。
- **`synthesize-qwen3-gpu.py` 尚无 CLI**：只有环境变量入口，需用 `video_run` 按其约定摆文件，或先给它加 `argv`。
- **本工作空间自带接手入口**：视频工厂工作空间的 `HANDOFF.md`（环境前提/命令/铁律/自检清单）是换机接手的第一份材料。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语、契约（配置 + 产物与副作用 + 调用点清单）、可证伪验收清单（A1–A10）、未决问题（U1–U4） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `comfyui-guidance` / `plugin-maintainability` / `dsh-plugin-development` | 媒体生成体系操控、可维护性工程（五问判据）、插件开发契约 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
