/**
 * dsh-video-studio — 视频工作台插件（2026-09-10 主人指令）
 *
 * 目标（主人原话）：**「通过这个插件创造出任何你想要的视频」** —— 不限既有范式。
 * 因此本插件不封装「快讯流水线」，而把视频工厂还原为**通用原语**：
 *
 *   自知面：video_env（环境体检）· video_catalog（主题/项目/组合/脚本能力清单）
 *   创造面：video_scaffold（任意主题建新项目）· video_render（渲染任意项目任意组合，支持 props）
 *   音频面：video_tts（文本→口播）· video_bgm（生成配乐）· video_mix（混音）
 *   检验面：video_qa（9 类质检）· video_cover（封面 still）
 *   逃生舱：video_run（按登记契约跑任意脚本 + 任意参数）
 *
 * 设计约束：
 * - 长任务（渲染/合成/脚手架/VLM 审片）走 DSH 官方 `ctx.jobs`——返回 job id，
 *   用既有 `job_output`/`job_kill` 收集与终止（不另造一套 job 协议）
 * - 子进程一律 spawn(数组) 传参：工作空间路径含空格（`E:/video studio`），shell 拼接必踩引号地狱
 * - `tools/` 资产不入 git；本插件只读它们，不搬动
 * - 路径参数一律解析为**绝对路径**再交给脚本（generate-bgm / fetch 的 --out 按 CWD 解析，会跑偏）
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { runCapture, spawnStreaming } from './exec.ts'
import { entryOf, listProjects, listThemes, nonEmptyFile, parseCompositions, probeEnv, readCompositions } from './probe.ts'
import { QA_KINDS, SCRIPTS, buildArgs, findScript, interpreterPath, type InterpreterKind } from './registry.ts'

export const name = 'agent-video-studio'
/**
 * 只声明必需注入 `tools`。
 * `jobs` 刻意**不**进 inject：cordis 的 inject 是激活门（未提供则不激活插件），
 * 而长任务后台能力在本插件里是**可选增强**（缺 jobs 时降级为前台执行）。
 * 故按 packages/AGENTS.md 的「可选服务用 ctx.get」规则取值——见 `jobsService()`。
 */
export const inject = ['tools'] as const

/**
 * 长任务 kind = 'video'。
 * 官方 `JobKindMap` 是可声明合并的类型映射，但本插件按**结构类型**调用 registry
 * （见下方 `run()` 的 jobs 结构断言），故不引入 `@deepseek-ai/dsh-jobs` 的类型依赖——
 * 好处：插件不在本地 node_modules 复制该包，杜绝「模块双实例」隐患；运行时
 * registry 把 kind 当不透明字符串，'video' 与既有 `job_output`/`job_kill` 天然兼容。
 */
const JOB_KIND = 'video'

export interface Config {
  /** 视频工厂根目录（部署相关值：**必须由组合显式配置**，不给硬编码默认） */
  studioRoot: string
  /** 默认项目（相对 studioRoot） */
  defaultProject: string
  /** 前台执行超时（ms） */
  timeoutMs: number
  /** 单次工具返回的最大输出字节（截断保护） */
  outputLimitBytes: number
  /** 是否允许长任务走后台 job（关掉则一律前台，受 timeoutMs 约束） */
  enableLongJobs: boolean
}
export const Config = z.object({
  // 不设具体路径默认值（部署相关，见 AGENTS.md「No hardcoded tunables in plugins」）：
  // studioRoot 指向某台机器的具体工作空间，写死会在别的部署上静默指向错误目录。
  // 由组合层 cordis.patch.yml 显式提供；未配置时工具返回明确错误，而不是猜一个路径。
  studioRoot: z.string().default(''),
  defaultProject: z.string().default('projects/news-flash'),
  timeoutMs: z.number().default(600000),
  outputLimitBytes: z.number().default(65536),
  enableLongJobs: z.boolean().default(true),
})

/** 后台 job 可用性（jobs 服务未挂载时降级为前台）。 */
interface JobEnvelope {
  kind: 'background'
  jobId: string
  label: string
  note: string
}

/** 统一返回结构：前台结果 / 后台句柄二选一。 */
type RunOutcome =
  | { mode: 'foreground'; code: number; stdout: string; stderr: string; truncated: boolean; spawnError?: string }
  | { mode: 'background'; job: JobEnvelope }

/** 工具返回的公共字段（强类型，供各工具展开；ok/background 恒存在）。 */
interface OutcomeFields {
  ok: boolean
  background: boolean
  jobId?: string
  label?: string
  exitCode?: number
  stdout?: string
  stderr?: string
  truncated?: boolean
}

/**
 * 各工具 `output.schema.properties` 共享的公共字段声明——必须与 `OutcomeFields` 逐字段对齐。
 * defineTool 以 `additionalProperties: false` 严格校验返回值：漏声明一个字段，
 * 会导致**执行成功之后**被判 invalid output（2026-09-10 实测踩过：漏了 truncated/label）。
 */
const OUTCOME_SCHEMA = {
  ok: { type: 'boolean' as const, required: true as const },
  background: { type: 'boolean' as const, required: true as const },
  jobId: { type: 'string' as const },
  label: { type: 'string' as const },
  exitCode: { type: 'number' as const },
  stdout: { type: 'string' as const },
  stderr: { type: 'string' as const },
  truncated: { type: 'boolean' as const },
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-video-studio')

  const root = (): string => config.studioRoot.replace(/[\\/]+$/, '')
  /**
   * 取 studioRoot（未配置即抛，不静默猜路径）。
   * 部署相关值由组合层提供；缺失时给出可操作的错误，而不是把相对路径解析到进程 cwd。
   * @returns 规范化后的根目录
   */
  const requireRoot = (): string => {
    const r = root()
    if (r === '') {
      throw new Error('studioRoot 未配置——请在 profile 的 cordis.patch.yml 为该插件设置 studioRoot（如 studioRoot: /path/to/video-studio）')
    }
    return r
  }
  /** 相对路径一律解析到 studioRoot 下；绝对路径原样使用。 */
  const abs = (p: string): string => (isAbsolute(p) ? p : resolvePath(requireRoot(), p))
  const projectDir = (p?: string): string => abs(p === undefined || p === '' ? config.defaultProject : p)
  const scriptPath = (rel: string): string => join(requireRoot(), rel)
  if (root() === '') {
    logger.warn('studioRoot 未配置——video_* 工具将返回明确错误；请在 profile 的 cordis.patch.yml 中设置 studioRoot')
  }

  /** 取 jobs 服务（可选；用 ctx.get 而非 ctx.jobs——后者只留给已声明注入）。 */
  const jobsService = (): {
    start: (spec: {
      kind: string
      label: string
      owner?: unknown
      outputLimitBytes?: number
      run: () => {
        cancel: (reason?: string) => void
        done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
        readOutput?: () => string
      }
    }) => string
  } | undefined => {
    try {
      const getter = (ctx as unknown as { get?: (name: string) => unknown }).get
      if (typeof getter !== 'function') return undefined
      return getter.call(ctx, 'jobs') as ReturnType<typeof jobsService>
    } catch {
      return undefined
    }
  }

  const jobsAvailable = (): boolean => config.enableLongJobs && jobsService() !== undefined

  /**
   * 统一执行入口：慢任务可交后台 job（返回 job id，用 job_output 收集）。
   * @param label - 面向模型的一行标签
   * @param command - 可执行文件
   * @param args - 参数数组
   * @param cwd - 工作目录
   * @param opts - 后台开关 / 超时 / owner
   * @returns 前台结果或后台句柄
   */
  const run = async (
    label: string,
    command: string,
    args: readonly string[],
    cwd: string,
    opts: { background?: boolean; owner?: unknown; timeoutMs?: number } = {},
  ): Promise<RunOutcome> => {
    const wantBackground = opts.background === true && jobsAvailable()
    if (wantBackground) {
      const jobs = jobsService()
      if (jobs === undefined) {
        throw new Error('jobs 服务不可用（enableLongJobs=' + String(config.enableLongJobs) + '）')
      }
      let cancelled = false
      const jobId = jobs.start({
        kind: JOB_KIND,
        label,
        ...(opts.owner === undefined ? {} : { owner: opts.owner }),
        outputLimitBytes: config.outputLimitBytes,
        run: () => {
          const handle = spawnStreaming({ command, args, cwd, outputLimitBytes: config.outputLimitBytes })
          return {
            cancel: (): void => { cancelled = true; handle.cancel() },
            done: handle.done.then((r) => ({
              status: r.code === 0 ? ('completed' as const) : cancelled ? ('killed' as const) : ('failed' as const),
              detail: r.spawnError !== undefined ? r.spawnError : 'exit code: ' + String(r.code),
            })),
            readOutput: (): string => handle.readDelta(),
          }
        },
      })
      return {
        mode: 'background',
        job: {
          kind: 'background',
          jobId,
          label,
          note: '长任务已在后台启动（' + jobId + '）。用 job_output 读进度/结果，job_kill 终止。',
        },
      }
    }
    const r = await runCapture({
      command,
      args,
      cwd,
      timeoutMs: opts.timeoutMs ?? config.timeoutMs,
      outputLimitBytes: config.outputLimitBytes,
    })
    return {
      mode: 'foreground',
      code: r.code ?? -1,
      stdout: r.stdout,
      stderr: r.stderr,
      truncated: r.truncated,
      ...(r.spawnError === undefined ? {} : { spawnError: r.spawnError }),
    }
  }

  /** 把执行结果压成模型可读的紧凑文本。 */
  const renderOutcome = (o: RunOutcome): string => {
    if (o.mode === 'background') return o.job.note
    if (o.spawnError !== undefined) return '[spawn 失败] ' + o.spawnError
    const tail = (o.stdout + (o.stderr.length > 0 ? '\n[stderr]\n' + o.stderr : '')).trim()
    return 'exit code: ' + String(o.code) + (o.truncated ? '（输出已截断）' : '') + '\n' + tail
  }

  /** 结果对象（前台带 code，后台带 jobId）。 */
  const outcomeValue = (o: RunOutcome): OutcomeFields => {
    if (o.mode === 'background') {
      return { ok: true, background: true, jobId: o.job.jobId, label: o.job.label }
    }
    return {
      ok: o.code === 0,
      background: false,
      exitCode: o.code,
      stdout: o.stdout,
      stderr: o.stderr,
      truncated: o.truncated,
    }
  }

  /** 跑一个登记脚本（按契约解释器 + 绝对路径）。 */
  const runScript = async (
    scriptId: string,
    positional: readonly string[],
    options: Readonly<Record<string, string | number | boolean | undefined>>,
    extraArgs: readonly string[] = [],
    overrides: { cwd?: string; background?: boolean; owner?: unknown; label?: string } = {},
  ): Promise<{ outcome: RunOutcome; argv: string[] }> => {
    const def = findScript(scriptId)
    if (def === undefined) throw new Error('未登记的脚本 id：' + scriptId + '（用 video_catalog 查看全部 id）')
    const interp: InterpreterKind = def.interpreter
    const command = interpreterPath(requireRoot(), interp)
    if (interp !== 'system' && !existsSync(command)) {
      throw new Error('解释器缺失：' + command + '（' + interp + ' 档；确认 tools/ 资产是否就位）')
    }
    const argv = [...buildArgs(def, positional, options), ...extraArgs]
    const label = overrides.label ?? def.id + (argv.length > 0 ? ' ' + argv.join(' ') : '')
    const outcome = await run(
      label,
      command,
      [scriptPath(def.path), ...argv],
      overrides.cwd === undefined ? requireRoot() : abs(overrides.cwd),
      { background: overrides.background, owner: overrides.owner },
    )
    return { outcome, argv }
  }

  // ═══════════════ 1. 自知面：环境 + 能力清单 ═══════════════

  ctx.tools.register(defineTool({
    name: 'video_env',
    description: '视频工厂环境体检：音频/视觉解释器、模型资产、技能真源是否就位，并列出可用主题数与已有项目。跑任何视频任务前用它确认前提（tools/ 全部不入 git，换机需重新获取）。',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          studioRoot: { type: 'string', required: true },
          note: { type: 'string', required: true },
          missing: { type: 'array', items: { type: 'string' }, required: true },
          themes: { type: 'number', required: true },
          projects: { type: 'array', items: { type: 'string' }, required: true },
          jobs: { type: 'boolean', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: (v.ok ? '✅ ' : '⚠ ') + v.note
          + '\n主题 ' + v.themes + ' 个 · 项目 ' + (v.projects.length > 0 ? v.projects.join(' / ') : '无')
          + '\n长任务后台：' + (v.jobs ? '可用（ctx.jobs）' : '不可用（降级前台）'),
      }],
    },
    async execute() {
      const e = probeEnv(requireRoot())
      return {
        ok: e.summary.ok,
        studioRoot: requireRoot(),
        note: e.summary.note,
        missing: e.summary.missing,
        themes: e.themes,
        projects: e.projects,
        jobs: jobsAvailable(),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_catalog',
    description: '视频工厂能力清单：可用主题（建新项目用）、已有项目及其 Remotion 组合（渲染用）、全部脚本登记（id/用途/解释器/参数/已知陷阱）。想知道「我能做什么、怎么调」时用它——这决定你能造出什么视频。',
    parameters: {
      section: { type: 'string', enum: ['all', 'themes', 'projects', 'scripts'], description: '只取一节（缺省 all）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          themes: { type: 'array', items: { type: 'string' }, required: true },
          projects: { type: 'json', required: true },
          scripts: { type: 'json', required: true },
        },
      },
      render: (_a: unknown, v: any) => {
        const lines: string[] = []
        if (v.themes.length > 0) lines.push('主题（' + v.themes.length + '）：' + v.themes.join(' · '))
        for (const p of v.projects) {
          lines.push('项目 ' + p.name + '：组合 ' + (p.compositions.length > 0
            ? p.compositions.map((c: any) => c.id + '(' + (c.width ?? '?') + 'x' + (c.height ?? '?') + '@' + (c.fps ?? '?') + ')').join(' / ')
            : '（未解析到声明）'))
        }
        lines.push('脚本 ' + v.scripts.length + ' 个：' + v.scripts.map((s: any) => s.id).join(' · '))
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: { section?: string }) {
      const section = args.section ?? 'all'
      const themes = section === 'projects' || section === 'scripts' ? [] : listThemes(requireRoot())
      const projects = section === 'themes' || section === 'scripts'
        ? []
        : listProjects(requireRoot()).map((p) => {
            const dir = join(requireRoot(), 'projects', p)
            return { name: p, dir, entry: entryOf(dir), compositions: readCompositions(dir) }
          })
      const scripts = section === 'themes' || section === 'projects'
        ? []
        : SCRIPTS.map((s) => ({
            id: s.id, path: s.path, interpreter: s.interpreter, desc: s.desc,
            positional: [...s.positional], options: { ...s.options }, newsOnly: s.newsOnly,
            caveats: [...(s.caveats ?? [])],
          }))
      return { ok: true, themes, projects, scripts }
    },
  }))

  // ═══════════════ 2. 创造面：脚手架 + 渲染 ═══════════════

  ctx.tools.register(defineTool({
    name: 'video_scaffold',
    description: '用任意主题新建一个 Remotion 视频项目（23 主题可选：neon-cyber / swiss-ikb / terminal-green / newsroom …）。这是「造任意视频」的起点：脚手架产出可编译的空骨架（含设计系统 tokens），随后你写场景组件即可。慢（npx create-video + npm install），默认后台执行。',
    parameters: {
      target: { type: 'string', required: true, description: '目标目录（相对视频工厂根，或绝对路径）' },
      theme: { type: 'string', description: '主题 id（缺省 midnight-press；用 video_catalog 看全部）' },
      background: { type: 'boolean', description: '后台执行（缺省 true；脚手架含 npm install，很慢）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA,
          targetDir: { type: 'string', required: true },
          theme: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '脚手架已后台启动（' + v.jobId + '）：' + v.theme + ' → ' + v.targetDir + '。用 job_output 看进度（npm install 较久）。'
          : '脚手架 ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + '：' + v.theme + ' → ' + v.targetDir + '\n' + (v.stderr || v.stdout || '').slice(-1500),
      }],
    },
    async execute(args: { target: string; theme?: string; background?: boolean }, exec: any) {
      const theme = args.theme ?? 'midnight-press'
      const targetDir = abs(args.target)
      const bg = args.background !== false && jobsAvailable()
      const r = await runScript('project.scaffold', [targetDir], { '--theme': theme }, [],
        { background: bg, owner: exec?.agent, label: 'scaffold ' + theme + ' → ' + targetDir })
      return { ...outcomeValue(r.outcome), targetDir, theme }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_render',
    description: '渲染任意项目的任意 Remotion 组合为 MP4。支持传入 props（同一组合渲染出不同内容——这是「不限范式」的关键：写一次组件，喂不同数据出不同片）、指定分辨率/帧率/编码/帧区间。慢，默认后台执行。',
    parameters: {
      project: { type: 'string', description: '项目（相对视频工厂根或绝对路径；缺省默认项目）' },
      composition: { type: 'string', description: '组合 id（缺省该项目第一个组合）' },
      output: { type: 'string', description: '输出 mp4（相对项目目录；缺省 out/<组合>-<时间戳>.mp4）' },
      props: { type: 'json', description: '传给组合的 props（对象；写入临时文件避免转义问题）' },
      codec: { type: 'string', description: '编码（h264 / h265 / vp8 / prores…，缺省 h264）' },
      crf: { type: 'number', description: '质量（CRF，越小越清晰；缺省 Remotion 默认）' },
      scale: { type: 'number', description: '缩放（如 0.5 = 半分辨率出预览）' },
      frames: { type: 'string', description: '只渲染帧区间（如 "0-100"）' },
      concurrency: { type: 'number', description: '并发数（缺省 Remotion 自定）' },
      background: { type: 'boolean', description: '后台执行（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA,
          projectDir: { type: 'string', required: true },
          composition: { type: 'string', required: true },
          outputPath: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '渲染已后台启动（' + v.jobId + '）：' + v.composition + ' → ' + v.outputPath + '。用 job_output 看进度。'
          : '渲染 ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + '：' + v.composition + ' → ' + v.outputPath + '\n' + (v.stderr || v.stdout || '').slice(-1500),
      }],
    },
    async execute(args: {
      project?: string; composition?: string; output?: string; props?: unknown; codec?: string
      crf?: number; scale?: number; frames?: string; concurrency?: number; background?: boolean
    }, exec: any) {
      const dir = projectDir(args.project)
      const comps = readCompositions(dir)
      const composition = args.composition ?? comps[0]?.id ?? 'Main'
      const entry = entryOf(dir)
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
      const outRel = args.output ?? ('out/' + composition + '-' + stamp + '.mp4')
      const outAbs = isAbsolute(outRel) ? outRel : join(dir, outRel)

      const argv: string[] = ['remotion', 'render', entry, composition, outAbs]
      if (args.props !== undefined) {
        const propsFile = join(dir, '.dsh-video-props.json')
        writeFileSync(propsFile, JSON.stringify(args.props, null, 2), 'utf8')
        argv.push('--props=' + propsFile)
      }
      if (args.codec !== undefined) argv.push('--codec=' + args.codec)
      if (args.crf !== undefined) argv.push('--crf=' + String(args.crf))
      if (args.scale !== undefined) argv.push('--scale=' + String(args.scale))
      if (args.frames !== undefined) argv.push('--frames=' + args.frames)
      if (args.concurrency !== undefined) argv.push('--concurrency=' + String(args.concurrency))

      const bg = args.background !== false && jobsAvailable()
      const outcome = await run('render ' + composition + ' → ' + outRel, 'npx', argv, dir,
        { background: bg, owner: exec?.agent })
      return { ...outcomeValue(outcome), projectDir: dir, composition, outputPath: outAbs }
    },
  }))

  // ═══════════════ 3. 音频面：TTS / BGM / 混音 ═══════════════

  ctx.tools.register(defineTool({
    name: 'video_tts',
    description: '文本 → 口播音频（Qwen3-TTS CustomVoice，serena 预设音色）。文案为 Markdown（用 --- 分段），输出 seg-N.wav + audio-segments.json + voice-full.wav。可指定任意输入/输出目录（不限于快讯项目）。慢，默认后台。',
    parameters: {
      script: { type: 'string', description: '文案路径（相对根或绝对；缺省 docs/content/script.md）' },
      outDir: { type: 'string', description: '输出目录（缺省默认项目的 public/audio）' },
      background: { type: 'boolean', description: '后台执行（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA,
          scriptPath: { type: 'string', required: true }, outDir: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? 'TTS 已后台启动（' + v.jobId + '）：' + v.scriptPath + ' → ' + v.outDir
          : 'TTS ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + '：' + v.outDir + '\n' + (v.stderr || v.stdout || '').slice(-1500),
      }],
    },
    async execute(args: { script?: string; outDir?: string; background?: boolean }, exec: any) {
      const scriptAbs = abs(args.script ?? 'docs/content/script.md')
      const outAbs = abs(args.outDir ?? join(config.defaultProject, 'public', 'audio'))
      if (!existsSync(scriptAbs)) throw new Error('文案不存在：' + scriptAbs)
      const r = await runScript('tts.news', [], { '--script': scriptAbs, '--out-dir': outAbs } as Readonly<Record<string, string>>, [],
        { background: args.background !== false, owner: exec?.agent, label: 'tts → ' + outAbs })
      return { ...outcomeValue(r.outcome), scriptPath: scriptAbs, outDir: outAbs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_bgm',
    description: '生成 AI 配乐（Stable Audio 3 w8a32 TFLite + loudnorm）。可指定任意时长/风格/自定义 prompt/种子/输出路径——风格不限于内置五种。慢，默认后台。',
    parameters: {
      duration: { type: 'number', description: '时长秒数（缺省 60）' },
      style: { type: 'string', description: 'tech / upbeat / minimal / cinematic / lofi（缺省 tech）' },
      prompt: { type: 'string', description: '自定义 prompt（覆盖 style；描述乐器与氛围）' },
      seed: { type: 'number', description: '随机种子（可复现）' },
      out: { type: 'string', description: '输出 wav（相对根或绝对；缺省 docs/content/audio/bgm.wav）' },
      background: { type: 'boolean', description: '后台执行（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA, outPath: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? 'BGM 生成已后台启动（' + v.jobId + '）→ ' + v.outPath
          : 'BGM ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + ' → ' + v.outPath + '\n' + (v.stderr || v.stdout || '').slice(-1200),
      }],
    },
    async execute(args: { duration?: number; style?: string; prompt?: string; seed?: number; out?: string; background?: boolean }, exec: any) {
      const outAbs = abs(args.out ?? 'docs/content/audio/bgm.wav')
      mkdirSync(join(outAbs, '..'), { recursive: true })
      const opts: Record<string, string | number | undefined> = {
        '--out': outAbs,
        '--duration': args.duration ?? 60,
        '--style': args.prompt === undefined ? (args.style ?? 'tech') : undefined,
        '--prompt': args.prompt,
        '--seed': args.seed,
      }
      const r = await runScript('bgm.generate', [], opts, [],
        { background: args.background !== false, owner: exec?.agent, label: 'bgm → ' + outAbs })
      return { ...outcomeValue(r.outcome), outPath: outAbs }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_mix',
    description: '口播 + BGM 混音（sidechain ducking + loudnorm）。三个路径参数必填：口播轨、BGM、输出。可调 ducking 阈值/比率、BGM 音量、淡出、高低架 EQ。快（ffmpeg 单次），默认前台。',
    parameters: {
      voice: { type: 'string', required: true, description: '口播轨 wav（相对根或绝对）' },
      bgm: { type: 'string', required: true, description: 'BGM wav' },
      out: { type: 'string', required: true, description: '输出 wav' },
      bgmVolume: { type: 'number', description: 'BGM 音量（缺省 0.35）' },
      duckThresh: { type: 'number', description: 'ducking 阈值（缺省 0.04，以代码为准）' },
      duckRatio: { type: 'number', description: 'ducking 比率（缺省 8.0）' },
      bgmFadeDur: { type: 'number', description: '片尾淡出秒数（缺省 2.0）' },
      bgmHighshelf: { type: 'number', description: '高架 EQ 增益 dB（缺省 0）' },
      bgmLowshelf: { type: 'number', description: '低架 EQ 增益 dB（缺省 0）' },
      background: { type: 'boolean', description: '后台执行（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA, outPath: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '混音已后台启动（' + v.jobId + '）→ ' + v.outPath
          : '混音 ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + ' → ' + v.outPath + '\n' + (v.stderr || v.stdout || '').slice(-1200),
      }],
    },
    async execute(args: {
      voice: string; bgm: string; out: string; bgmVolume?: number; duckThresh?: number
      duckRatio?: number; bgmFadeDur?: number; bgmHighshelf?: number; bgmLowshelf?: number; background?: boolean
    }, exec: any) {
      const voiceAbs = abs(args.voice); const bgmAbs = abs(args.bgm); const outAbs = abs(args.out)
      for (const [k, p] of [['voice', voiceAbs], ['bgm', bgmAbs]] as const) {
        if (!existsSync(p)) throw new Error(k + ' 不存在：' + p)
      }
      mkdirSync(join(outAbs, '..'), { recursive: true })
      const r = await runScript('audio.mix', [voiceAbs, bgmAbs, outAbs], {
        '--bgm-volume': args.bgmVolume, '--duck-thresh': args.duckThresh, '--duck-ratio': args.duckRatio,
        '--bgm-fade-dur': args.bgmFadeDur, '--bgm-highshelf': args.bgmHighshelf, '--bgm-lowshelf': args.bgmLowshelf,
      }, [], { background: args.background === true, owner: exec?.agent, label: 'mix → ' + outAbs })
      return { ...outcomeValue(r.outcome), outPath: outAbs }
    },
  }))

  // ═══════════════ 4. 检验面：质检 + 封面 ═══════════════

  ctx.tools.register(defineTool({
    name: 'video_qa',
    description: '对任意产物跑质检（9 类）：render 技术(LUFS/电平) · video 画面经典 · vlm VLM 审片(MiniCPM-V 事实描述) · asr 台词回听 · aesthetic 音频审美四轴(PQ/CE) · rhythm 节奏对齐 · sensitive 敏感词 · bgm 配乐存在性与 ducking 实效 · sync 音画帧数一致。各脚本退出码语义不同，结果里一并给出。',
    parameters: {
      kind: { type: 'string', required: true, enum: ['render', 'video', 'vlm', 'asr', 'aesthetic', 'rhythm', 'sensitive', 'bgm', 'sync'], description: '检查类型' },
      target: { type: 'string', description: '被测产物路径（视频/音频/文案；sync 与 bgm 见说明）' },
      compare: { type: 'string', description: 'bgm 类的第二路径（混音轨；bgm 需 target=纯口播、compare=混音）' },
      script: { type: 'string', description: 'asr 类：对照文案路径' },
      segments: { type: 'string', description: 'rhythm 类：audio-segments.json 路径' },
      project: { type: 'string', description: 'sync 类：项目目录' },
      expectLufs: { type: 'number', description: 'render 类：期望 LUFS（缺省 -14.0）' },
      expectDuration: { type: 'number', description: 'render 类：期望时长（秒）' },
      sampleEvery: { type: 'number', description: 'video 类：每 N 帧采样（缺省 15）' },
      frames: { type: 'number', description: 'vlm 类：采样帧数' },
      thresholdPq: { type: 'number', description: 'aesthetic 类：PQ 门槛（缺省 6.0）' },
      thresholdCe: { type: 'number', description: 'aesthetic 类：CE 门槛（缺省 5.5）' },
      check: { type: 'boolean', description: 'sync 类：只校验不写入（缺省 true）' },
      background: { type: 'boolean', description: '后台执行（vlm/rhythm/asr 慢，缺省自动）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA,
          kind: { type: 'string', required: true }, scriptId: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '质检（' + v.kind + '）已后台启动（' + v.jobId + '）。用 job_output 读结果。'
          : '质检 ' + v.kind + '（' + v.scriptId + '）：exit ' + v.exitCode + ' → ' + (v.ok ? 'PASS' : 'FAIL/WARN（注意各脚本退出码语义不同）')
            + '\n' + (v.stderr || v.stdout || '').slice(-2000),
      }],
    },
    async execute(args: {
      kind: string; target?: string; compare?: string; script?: string; segments?: string; project?: string
      expectLufs?: number; expectDuration?: number; sampleEvery?: number; frames?: number
      thresholdPq?: number; thresholdCe?: number; check?: boolean; background?: boolean
    }, exec: any) {
      const scriptId = QA_KINDS[args.kind]
      if (scriptId === undefined) throw new Error('未知检查类型：' + args.kind)
      const t = args.target === undefined ? undefined : abs(args.target)
      const positional: string[] = []
      const options: Record<string, string | number | boolean | undefined> = {}
      let slow = false
      switch (args.kind) {
        case 'render':
          if (t === undefined) throw new Error('render 质检需要 target（成片 mp4）')
          positional.push(t)
          options['--expect-lufs'] = args.expectLufs ?? -14.0
          options['--expect-duration'] = args.expectDuration
          break
        case 'video':
          if (t === undefined) throw new Error('video 质检需要 target（成片 mp4）')
          positional.push(t); options['--sample-every'] = args.sampleEvery ?? 15
          break
        case 'vlm':
          if (t === undefined) throw new Error('vlm 质检需要 target（成片 mp4）')
          positional.push(t); options['--frames'] = args.frames; slow = true
          break
        case 'asr':
          if (t === undefined) throw new Error('asr 质检需要 target（口播 wav）')
          positional.push(t); if (args.script !== undefined) options['--script'] = abs(args.script); slow = true
          break
        case 'aesthetic':
          if (t === undefined) throw new Error('aesthetic 质检需要 target（音频）')
          positional.push(t); options['--threshold-pq'] = args.thresholdPq; options['--threshold-ce'] = args.thresholdCe
          break
        case 'rhythm':
          if (t === undefined) throw new Error('rhythm 质检需要 target（成片 mp4）')
          positional.push(t); if (args.segments !== undefined) options['--segments'] = abs(args.segments); slow = true
          break
        case 'sensitive':
          if (t === undefined) throw new Error('sensitive 质检需要 target（文案路径）')
          positional.push(t)
          break
        case 'bgm':
          if (t === undefined || args.compare === undefined) throw new Error('bgm 质检需要 target（纯口播）与 compare（混音轨）')
          positional.push(t, abs(args.compare))
          break
        case 'sync':
          options['--project'] = args.project === undefined ? config.defaultProject : args.project
          if (args.check !== false) options['--check'] = true
          break
      }
      const bg = args.background ?? (slow && jobsAvailable())
      const r = await runScript(scriptId, positional, options, [], {
        background: bg === true, owner: exec?.agent,
        label: 'qa:' + args.kind + ' ' + (t ?? args.project ?? ''),
      })
      return { ...outcomeValue(r.outcome), kind: args.kind, scriptId }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_cover',
    description: '从任意项目导出封面 still（Remotion still 渲染）+ 尺寸/黑屏校验（须 1920x1080 且非纯黑）。注意：脚本固化了入口 src/index.ts 与组合名 Main。',
    parameters: {
      project: { type: 'string', description: '项目目录（缺省默认项目）' },
      frame: { type: 'number', description: '取第几帧（缺省 60）' },
      background: { type: 'boolean', description: '后台执行（缺省 false）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA, projectDir: { type: 'string', required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '封面导出已后台启动（' + v.jobId + '）'
          : '封面导出 ' + (v.ok ? '完成' : '失败（exit ' + v.exitCode + '）') + '\n' + (v.stderr || v.stdout || '').slice(-1200),
      }],
    },
    async execute(args: { project?: string; frame?: number; background?: boolean }, exec: any) {
      const dir = projectDir(args.project)
      const r = await runScript('make.cover', [], { '--frame': args.frame ?? 60, '--project': dir }, [],
        { background: args.background === true, owner: exec?.agent, label: 'cover ' + dir })
      return { ...outcomeValue(r.outcome), projectDir: dir }
    },
  }))

  // ═══════════════ 5. 逃生舱：任意脚本 + 任意参数 ═══════════════

  ctx.tools.register(defineTool({
    name: 'video_run',
    description: '按登记契约直接运行视频工厂的任意脚本，并原样追加你给的参数——用于其他工具未暴露的 flag，或尚未封装的脚本（如声音克隆 synthesize-qwen3-gpu.py）。这是「不限既有范式」的逃生舱：登记表给出解释器与路径，参数由你完全掌控。',
    parameters: {
      scriptId: { type: 'string', required: true, description: '登记脚本 id（用 video_catalog 查看；如 qa.vlm / tts.news / project.scaffold）' },
      args: { type: 'array', items: { type: 'string' }, description: '原样追加的参数数组（按脚本自己的 CLI 约定，顺序保留）' },
      cwd: { type: 'string', description: '工作目录（缺省视频工厂根；相对路径基于根解析）' },
      background: { type: 'boolean', description: '后台执行（缺省 true）' },
      timeoutMs: { type: 'number', description: '前台超时（ms；仅前台生效）' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ...OUTCOME_SCHEMA,
          scriptId: { type: 'string', required: true }, resolvedArgs: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.background
          ? '已后台启动（' + v.jobId + '）：' + v.scriptId + ' ' + (v.resolvedArgs ?? []).join(' ')
          : v.scriptId + ' exit ' + v.exitCode + '\n' + (v.stderr || v.stdout || '').slice(-2000),
      }],
    },
    async execute(args: { scriptId: string; args?: string[]; cwd?: string; background?: boolean; timeoutMs?: number }, exec: any) {
      const def = findScript(args.scriptId)
      if (def === undefined) throw new Error('未登记的脚本 id：' + args.scriptId)
      const argv = args.args ?? []
      const command = interpreterPath(requireRoot(), def.interpreter)
      if (def.interpreter !== 'system' && !existsSync(command)) throw new Error('解释器缺失：' + command)
      const cwd = args.cwd === undefined ? requireRoot() : abs(args.cwd)
      const outcome = await run(
        def.id + ' ' + argv.join(' '),
        command,
        [scriptPath(def.path), ...argv],
        cwd,
        { background: args.background !== false, owner: exec?.agent, timeoutMs: args.timeoutMs },
      )
      return { ...outcomeValue(outcome), scriptId: args.scriptId, resolvedArgs: argv }
    },
  }))

  ctx.effect(() => {
    logger.info('ready: dsh-video-studio 已装配（root=' + (root() || '(未配置)') + '，脚本 ' + SCRIPTS.length + ' 个，长任务=' + jobsAvailable() + '）')
    return () => { /* 工具注册由 tools 服务统一回收 */ }
  })
}
