# 语义文档：dsh-video-studio（视频工作台）

> 能力名：dsh-video-studio（插件导出 `name = 'agent-video-studio'`，`src/index.ts:29`）
> 主副本路径：`self-plugins/dsh-video-studio/docs/semantic.md`（本文件）
> 实现落点：`self-plugins/dsh-video-studio/src/index.ts`（工具面 + 执行入口）· `src/registry.ts`（16 项脚本登记 + `buildArgs` 纯函数）· `src/exec.ts`（前台捕获 / 后台流式）· `src/probe.ts`（主题/项目/组合发现）
> 版本 v0.1.0（`package.json`） · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）

---

## 1 · 定位与反定位

**定位**：把本机视频工厂（组合配置的 `studioRoot`，当前部署 = `E:/video studio`）还原为 **10 个通用原语工具**——建项目、渲染任意 Remotion 组合、配音/配乐/混音、跑 9 类质检、按契约跑任意脚本，使模型能在会话内造任意视频而非复刻既有范式。

**反定位（本文不管什么）**：
- 不管视频工厂脚本自身的正确性（`scripts/**` 是外部资产，本插件只按登记契约调用）
- 不管 `tools/` 资产获取（~9.7G 模型 + 两套 Python 环境，不入 git；`video_env` 只如实报缺）
- 不管 job 协议本身（复用 DSH 官方 `ctx.jobs` + 既有 `job_output`/`job_kill`，不另造协议）
- **不是沙箱**：插件只负责调用视频工厂脚本，脚本自身的权限就是它的权限

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| studioRoot | 视频工厂根目录（组合层配置；未配置时工具返回明确错误，不猜路径） |
| 登记脚本（`ScriptDef`） | `src/registry.ts:39` `SCRIPTS` 中的 16 项 CLI 契约：`id/path/interpreter/positional/options/newsOnly/caveats` |
| 解释器档位 | `tts` = `<root>/tools/tts-env/Scripts/python.exe`；`vlm` = `<root>/tools/vlm-env/Scripts/python.exe`；`system` = `python`（`registry.ts:283` `interpreterPath`） |
| 组合（Composition） | Remotion 的 `<Composition/>` 声明，由 `probe.ts:31` `parseCompositions` 从项目 `src/Root.tsx` 做**属性级**解析 |
| outcome | 统一返回：前台 `{ok,background:false,exitCode,stdout,stderr,truncated}`；后台 `{ok,background:true,jobId,label}` |
| 逃生舱 | `video_run`：按登记契约取解释器与路径，argv 由调用者原样提供 |

## 3 · 概念模型

```
组合层(.dsh/profiles/web/cordis.patch.yml:246 id=agent-video-studio)
   └─ studioRoot=E:/video studio ──► apply(ctx, config)
          ├─ ctx.tools.register ×10  （video_env … video_run）
          └─ 每次工具调用 ──► run()（index.ts:169）
                 ├─ 前台：exec.runCapture（数组传参 + 超时 + 输出上限）
                 └─ 后台：ctx.jobs.start(kind='video') → spawnStreaming → job_output/job_kill
                        └─ 子进程 = 登记脚本 / npx remotion，cwd 恒为 studioRoot 或项目目录
```

不变量（invariants）：
1. **I1 零 shell 拼接**：一律 `spawn(command, [...args])`（`exec.ts:76`、`exec.ts:150`），无 `shell: true`——含空格路径 `E:/video studio` 天然可用
2. **I2 studioRoot 缺失即响亮失败**：`requireRoot()`（`index.ts:120`）抛错，不把相对路径解析到进程 cwd
3. **I3 输出有界**：单次 stdout/stderr 各 ≤ `outputLimitBytes`（默认 65536），头尾均保留并标注截断
4. **I4 返回 schema 严格**：`additionalProperties:false` + `OUTCOME_SCHEMA`（`index.ts:100`）必须与 `OutcomeFields` 逐字段对齐，漏声明字段会「执行成功后判 invalid output」
5. **I5 长任务可降级**：`jobsAvailable()`（`index.ts:158`）= `enableLongJobs && ctx.get('jobs') 可用`，不满足即前台执行

## 4 · 契约

### 4.1 配置契约（`src/index.ts:59` `Config`）
`studioRoot`（默认 `''`，**部署相关值必须由组合显式给**）｜`defaultProject`（默认 `projects/news-flash`）｜`timeoutMs`（默认 600000）｜`outputLimitBytes`（默认 65536）｜`enableLongJobs`（默认 true）。
当前部署实际值：`studioRoot: E:/video studio`、`defaultProject: projects/news-flash`（其余走默认）。

### 4.2 产物与副作用契约
- 渲染产物：`video_render` 默认写 `<projectDir>/out/<composition>-<stamp>.mp4`（时间戳 = ISO 去符号取前 15 字）
- props 临时文件：`<projectDir>/.dsh-video-props.json`（`index.ts:447`，避免 argv 转义）
- 音频产物：`video_tts` 默认 `docs/content/script.md` → `<defaultProject>/public/audio`；`video_bgm` 默认 `docs/content/audio/bgm.wav`；`video_mix` 输出目录自动 `mkdirSync`
- 声明边界：**会写视频工厂目录（项目产物 / public/audio / 新项目目录），不删除既有文件**

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| cordis 组合层 | `.dsh/profiles/web/cordis.patch.yml:246`（`id: agent-video-studio`，`studioRoot: E:/video studio`） | web 启动装配 |
| 插件 | `src/index.ts:29` `name='agent-video-studio'` / `:36` `inject=['tools']` | 装配与激活门 |
| 插件 | `src/index.ts:111` `apply(ctx, config)` → `:279/317/367/401/466/499/540/588/683/715` 十次 `ctx.tools.register` | apply 一次 |
| 模型 / 会话 | 工具面 `video_env` `video_catalog` `video_scaffold` `video_render` `video_tts` `video_bgm` `video_mix` `video_qa` `video_cover` `video_run` | 每次调用 |
| 插件内部 | `src/index.ts:136` `jobsService()` → `jobs.start({kind:'video',…})` | 长任务后台分支 |
| 插件内部 | `src/index.ts:251` `runScript()` → `registry.ts:258` `buildArgs` + `registry.ts:283` `interpreterPath` | 跑登记脚本 |
| 进程执行层 | `src/exec.ts:63` `runCapture`（前台）/ `src/exec.ts:132` `spawnStreaming`（后台流式） | 每次子进程 |
| 发现层 | `src/probe.ts:120` `probeEnv` / `:76` `listThemes` / `:90` `listProjects` / `:109` `readCompositions` | `video_env`/`video_catalog`/`video_render` |
| 配置读取 | `src/index.ts:114` `root()` / `:120` `requireRoot` / `:128` `abs` / `:129` `projectDir` / `:130` `scriptPath` | 每次工具调用 |
| 日志 | `src/index.ts:112` `ctx.logger('dsh-video-studio')` · `:758` `ctx.effect` 装配自报 | apply / 卸载 |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：本插件防的是「参数拼接错误、路径跑偏、输出打爆上下文」；**不防**被调用脚本自身的越权行为（那是脚本的权限）。
- 不越界清单：不下载/搬运 `tools/` 资产｜不删除既有文件｜不替脚本重新解释退出码语义（`video_qa` 原样透出 `exitCode`）｜不改写视频工厂源码。
- 失败面：`studioRoot` 缺失 → 工具抛可操作错误（提示写 `cordis.patch.yml`）；解释器缺失 → 抛「解释器缺失」（`index.ts:262`，`system` 档不检查）；文案/输入文件缺失 → `video_tts`/`video_mix` 抛错（`index.ts:492`、`:575`）；spawn 失败 → `spawnError` 落进文本（`renderOutcome`），不静默；超时 → 前台 `kill()` 后以非 0 码返回；未知 scriptId / 未知 QA kind → 抛错并提示用 `video_catalog` 查。
- 坏数据一律「拒绝 + 报错」：不做静默回退路径猜测。

## 6 · 与既有机制的关系

- **DSH 组合变更（AGENTS.md §5.11）**：改 `src/**` 属组合变更——`lib/index.js` 新于 web 进程启动时，`preflight_check` 会判定「有未验证构建」并强制完整试运行；本插件不自带预检，沿用该机制。
- **预检与哨兵**：装配改动经哨兵协议（预检 → kill+重启 → 唤醒）。`jobs` 是可选服务，刻意**不进 `inject`**（`inject` 是激活门，缺 `jobs` 会让插件整体不激活），改用 `ctx.get('jobs')`。
- **生态公约**：走 `plugin-ecosystem-convention`（组合优先/声明清晰/兼容优先）；`.npmrc` 禁 peer 自动安装，避免 `@deepseek-ai/*` 模块双实例。
- **质检语义**：`video_qa` 的 9 类映射见 `registry.ts:234` `QA_KINDS`，其中 `bgm→audio.check`、`sync→sync.durations` 是「非 qa.* 家族」的复用。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名/命令/日志行） | 状态 |
|---|-----------|------------------------------|------|
| A1 | 工具面恰好 10 个且都在 `video_` 命名空间 | `node --test tests/schema.test.mjs`：「插件注册了 10 个工具，且命名都在 video_ 命名空间」 | 待验收 |
| A2 | 执行成功后的返回值必能过自己的 schema（含 `truncated`/`label` 尸样本） | `tests/schema.test.mjs`：「尸体样本：前台返回…」「尸体样本：后台返回…」「健壮样本：最小返回值…」 | 待验收 |
| A3 | `buildArgs` 位置参数顺序/`0` 不被裁/`true` 渲染裸 flag/数字空格分隔 | `tests/registry.test.mjs`：`buildArgs:` 五条 | 待验收 |
| A4 | 三个易错点（`--out` 绝对路径、`fetch` 恒 0、`--expect-lufs` 空格）仍被登记表标注 | `tests/registry.test.mjs`：「契约守卫: 三个易错点仍在登记表中被标注」 | 待验收 |
| A5 | `parseCompositions`/`summarizeEnv` 纯函数行为（含无声明返回空数组不抛） | `tests/registry.test.mjs`：`parseCompositions:` ×2、`summarizeEnv:` ×2 | 待验收 |
| A6 | 子进程一律数组传参、无 `shell: true` | 源码：`rg -n "spawn\(" src/` → 仅 `exec.ts:76`/`:150` 的数组形式；`rg -n "shell:\s*true" src/` → 0 命中 | 已实测 |
| A7 | 本实例跑的就是当前构建（构建先于进程启动） | `lib/index.js` mtime = 2026-09-10 22:10:05 ＜ web 进程启动 = 2026-09-14 10:05:47（`.dsh/plugin-boot.jsonl` 末行 `processStartMs=1789351547742`） | 已实测 |
| A8 | 组合已挂载且无构建滞后 | `.dsh/plugin-boot.jsonl` 末行 `live[]` 含 `dsh-video-studio`、`stale[]` 为空 | 已实测 |
| A9 | `video_env` 能如实报环境齐备/缺失（含 `jobs` 可用性） | 线上跑 `video_env`：`note`/`missing` 与 `E:/video studio/tools/**` 实际存在性一致 | 待验收 |
| A10 | 渲染真能产出非空 mp4 | 线上跑 `video_render` 后 `dir` 下 `out/<composition>-*.mp4` 非空（`probe.ts:140` `nonEmptyFile`） | 待验收 |

## 8 · 与实现的关系

- 主实现：`src/index.ts`（工具面/执行路径）、`src/registry.ts`（脚本契约与 argv 纯函数）、`src/exec.ts`、`src/probe.ts`；构建产物 `lib/*.js`。
- 同语义副本：无（本文件为唯一主副本）。
- 未实现/未验证部分显式标注：`synthesize-qwen3-gpu.py`（`audio.clone`）**无 argparse**，只有环境变量入口，须走 `video_run` 摆文件；`fetch.news` 从不 `exit(1)`，判成败须解析 stdout。
- **生效判据**：① 代码改动后 `npm run build`，比对 `lib/index.js` 的 mtime 与 web 进程启动时刻（`.dsh/plugin-boot.jsonl` 末行 `processStartMs`）——产物早于进程启动即「本实例未加载新代码」；② 组合自报：`plugin_boot_status` 的 `stale` 清单为空；③ 工具级：会话内能答出 `video_env`（`studioRoot` 回显 + `jobs` 布尔）即表示插件已激活，否则多半被 `toolface` 收窄或未挂载；④ 产物级：`video_render` 后项目 `out/` 下 mp4 出现且非空。
- **回退**：① 代码回退 `git -C E:/alice/self-plugins/dsh-video-studio revert <sha>`（或 `checkout` 上一提交）+ 重新 `npm run build`，再经哨兵协议重启使新构建生效；② 版本回退按 package version 回滚（当前 `0.1.0`）；③ 结构性回退 `plugin_unmount`（插件名 `dsh-video-studio`）——工具面整体消失，视频工厂资产不受影响（插件只读不搬动）；④ 单点应急：组合配置里把 `enableLongJobs` 置 false 即退化为纯前台执行。

## 9 · 实践修订记录

（I3：每次事故/实践暴露的语义缺口当场回写）

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
  - 语义**被确认**：10 工具命名空间、`inject=['tools']` 而 `jobs` 走 `ctx.get`、16 项脚本登记表、`OUTCOME_SCHEMA` 与返回字段必须逐字段对齐
  - 语义**被补充**：`§5` 失败面按源码逐条列出（`index.ts:262/492/575`）；`§8` 生效判据与回退补上「产物级」与「单点开关」两条
  - 语义**被修正**：无（本轮为首次成文，未发现与实现冲突的旧表述）

## 10 · 未决问题

- **U1** `video_qa` 的退出码语义不统一（源脚本如此）：是否在文档层固化「各 kind 何码为 PASS」的判定表，还是继续原样透出由我判断？
- **U2** `props` 临时文件 `.dsh-video-props.json` 写在项目目录内，可能被 git 跟踪——是否需要改为系统临时目录或加 `.gitignore` 约定？
- **U3** `audio.clone`（Qwen3-TTS 克隆）缺 CLI，长期方案是给脚本加 `argparse` 还是本插件内置文件摆放协议？
- **U4** `video_catalog` 用 `json` 类型返回整表（16 脚本 × 参数），大项目下 `projects` 字段可能偏大——是否需要分页/按 section 强制？
