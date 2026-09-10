<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 视频工作台：把视频工厂（E:\video studio）的 TTS / 配乐 / 混音 / Remotion 渲染 / 多级质检 / 主题脚手架封装为 DSH 工具面
  inject: 'tools'（jobs 为可选增强，经 ctx.get 取用）
  tools: video_env,video_catalog,video_scaffold,video_render,video_tts,video_bgm,video_mix,video_qa,video_cover,video_run
  runtime: host-only
  envDeps: 本机视频工厂资产（tools/：tts-env、vlm-env、模型 ~9.7G、ffmpeg）+ Node
  boundary: 会写视频工厂目录（项目产物 out/、public/audio/、新项目目录）；不删除既有文件
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / DSH 0.1.5（可选服务走 ctx.get）
-->

# dsh-video-studio — 视频工作台插件

[![version](https://img.shields.io/badge/version-0.1.0-blue)](#)
<img src="https://img.shields.io/badge/License-MIT-green" alt="license">
<img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">

把 **`E:\video studio`**（AI 视频自动化工厂）接入 DSH：在会话内**造任意视频**——不限既有范式。

不是「快讯流水线封装」，而是把视频工厂还原成**通用原语**。原范式（日更 GitHub 快讯）只是其中一个用法；
你可以用任意主题建新项目、写自己的场景组件、喂任意 props 渲染出任意片子。

## 能力面（10 个工具）

| 工具 | 干什么 | 覆盖的范式边界 |
|------|--------|----------------|
| `video_env` | 环境体检：解释器/模型资产/ffmpeg/主题数/项目数/后台能力 | 先确认前提，再动手 |
| `video_catalog` | 能力清单：23 主题 + 已有项目及其组合 + 16 个脚本登记（id/解释器/参数/已知陷阱） | 「我能做什么」的自知面 |
| `video_scaffold` | **任意主题建新 Remotion 项目**（neon-cyber / swiss-ikb / terminal-green / newsroom …） | 跳出快讯形态的起点 |
| `video_render` | **渲染任意项目任意组合**，支持 props / 分辨率 / 帧率 / 编码 / 帧区间 | 写一次组件，喂不同数据出不同片 |
| `video_tts` | 文本（Markdown）→ 口播音频，可指定任意输入输出目录 | 不再绑定快讯项目 |
| `video_bgm` | AI 配乐：任意时长 / 风格 / 自定义 prompt / 种子 / 输出 | 风格不限于内置五种 |
| `video_mix` | 口播 + BGM ducking 混音（阈值/比率/淡出/EQ 可调） | 通用 |
| `video_qa` | 9 类质检：render / video / vlm / asr / aesthetic / rhythm / sensitive / bgm / sync | 质检面向任意产物 |
| `video_cover` | 封面 still + 尺寸/黑屏校验 | — |
| `video_run` | **逃生舱**：按登记契约跑任意脚本并原样追加参数 | 未封装的 flag 与新脚本不必等我改插件 |

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-video-studio.git
cd dsh-video-studio
npm install      # 只装 devDeps（.npmrc 已禁 peer 自动安装，避免模块双实例）
npm run build
```

挂载到 profile 后在 `config` 里给 `studioRoot`：

```yaml
- insert:
    - id: agent-video-studio
      name: dsh-video-studio
      config:
        studioRoot: E:/video studio
        defaultProject: projects/news-flash
```

## 配置

| 键 | 默认 | 说明 |
|----|------|------|
| `studioRoot` | `E:/video studio` | 视频工厂根目录 |
| `defaultProject` | `projects/news-flash` | 省略 `project` 参数时的默认项目 |
| `timeoutMs` | `600000` | 前台执行超时 |
| `outputLimitBytes` | `65536` | 单次返回的输出上限（防日志打爆上下文） |
| `enableLongJobs` | `true` | 长任务是否走 DSH 后台 job |

## 技术要点

- **长任务走 DSH 官方 `ctx.jobs`**：渲染/合成/脚手架/VLM 审片返回 `jobId`，用**既有** `job_output`/`job_kill` 收集与终止——不另造 job 协议。
- **`jobs` 是可选服务**：不进 `inject`（cordis 的 inject 是激活门），改用 `ctx.get('jobs')`；缺 jobs 时全部降级为前台执行。
- **一律 `spawn(command, argsArray)`**：工作空间路径含空格（`E:/video studio`），shell 拼接必踩引号地狱；数组传参零转义。
- **路径参数强制绝对化**：`generate-bgm.py` / `fetch-ai-news.py` 的 `--out` 按 **CWD** 解析，不绝对化就会写偏。
- **不复制 `@deepseek-ai/*` 到本地**：`.npmrc` 禁 peer 自动安装，运行时解析向上走到宿主链接层——避免「模块双实例」（一份代码两个 instanceof 世界）。
- **参数构造纯函数化**（`buildArgs`）：位置参数顺序、空值裁剪、`--flag value` 空格分隔（兼容手写 argv 的 `render-qa.py`）全部离线可测。

## 已知边界（诚实声明）

- **不是沙箱**：插件只负责调用视频工厂脚本，脚本自身的权限就是它的权限。
- **依赖本机资产**：`tools/`（约 9.7G 模型 + 两套 Python 环境）**不入 git**，换机须按该工作空间
  `tools/README.md` 重新获取；`video_env` 会如实报缺。
- **脚手架需 bash + npm + 网络**：`scaffold.sh` 依赖它们；WSL 不可用且无 git-bash 的环境下会明确报错。
- **退出码语义不统一**（源脚本如此，非本插件所致）：`render-qa` 无参=2、`rhythm-check` FAIL=2、
  `asr-check`/`sync-durations --check` 用非 0 表示「提示」。`video_qa` 原样透出 code，不替脚本重新解释。
- **`synthesize-qwen3-gpu.py` 尚无 CLI**：只有环境变量入口，须用 `video_run` 按其约定摆文件，或先给它加 argv。

## 生态

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life) —— 本插件是其中一员
- 本插件服务的视频工厂工作空间自带接手入口 `HANDOFF.md`（环境前提/命令/铁律/自检清单）

## License

MIT
