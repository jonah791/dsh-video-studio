/**
 * exec.ts — 子进程执行层（前台捕获 + 后台流式）
 *
 * 关键设计：**一律用 spawn(command, argsArray) 而非 shell 字符串**。
 * 工作空间路径含空格（`E:/video studio`），shell 拼接必然踩引号地狱；
 * 数组传参让 Node 直接交给 CreateProcess，零转义、零歧义。
 */
import { spawn } from 'node:child_process'

/** 一次子进程调用的规格。 */
export interface RunSpec {
  /** 可执行文件（绝对路径或 PATH 名） */
  command: string
  /** 参数数组（不拼接 shell 字符串） */
  args: readonly string[]
  /** 工作目录 */
  cwd: string
  /** 追加环境变量 */
  env?: Readonly<Record<string, string>>
  /** 前台超时（ms）；缺省不超时 */
  timeoutMs?: number
  /** 调用方取消信号 */
  signal?: AbortSignal
  /** 输出上限（字节，超出截断并标记） */
  outputLimitBytes?: number
}

/** 前台执行结果（永不抛：失败也以 code ≠ 0 表达）。 */
export interface RunResult {
  /** 退出码；null = 被信号终止或 spawn 失败 */
  code: number | null
  /** 终止信号 */
  signal: string | null
  stdout: string
  stderr: string
  /** 输出是否被上限截断 */
  truncated: boolean
  /** spawn 层面的错误（如可执行文件不存在） */
  spawnError?: string
}

/** 默认输出上限（字节）——防一次渲染日志把上下文打爆。 */
export const DEFAULT_OUTPUT_LIMIT = 64 * 1024

/** 保留头部同时保留尾部（日志的头尾都关键：头有命令回显，尾有失败原因）。 */
function boundText(text: string, limitBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= limitBytes) return { text, truncated: false }
  const half = Math.max(1024, Math.floor(limitBytes / 2))
  const head = text.slice(0, half)
  const tail = text.slice(-half)
  return {
    text: head + '\n... [输出超限，已截断 ' + (Buffer.byteLength(text, 'utf8') - head.length - tail.length)
      + ' 字节] ...\n' + tail,
    truncated: true,
  }
}

/**
 * 前台执行并捕获输出。
 * @param spec - 运行规格
 * @returns 执行结果（含退出码与输出）
 */
export function runCapture(spec: RunSpec): Promise<RunResult> {
  return new Promise((resolve) => {
    const limit = spec.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (r: RunResult): void => {
      if (settled) return
      settled = true
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        windowsHide: true,
        ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
      })
    } catch (error) {
      settle({ code: null, signal: null, stdout: '', stderr: '', truncated: false, spawnError: String(error) })
      return
    }
    const hardTimer = spec.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          try { child.kill() } catch { /* 已退出 */ }
        }, spec.timeoutMs)
    const onAbort = (): void => { try { child.kill() } catch { /* 已退出 */ } }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', (e) => {
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      settle({ code: null, signal: null, stdout, stderr, truncated: false, spawnError: e.message })
    })
    child.on('close', (code, signal) => {
      if (hardTimer !== undefined) clearTimeout(hardTimer)
      spec.signal?.removeEventListener('abort', onAbort)
      const out = boundText(stdout, limit)
      const err = boundText(stderr, limit)
      settle({
        code,
        signal: signal ?? null,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      })
    })
  })
}

/** 后台流式执行句柄（供 ctx.jobs 的 JobHooks 适配）。 */
export interface StreamHandle {
  /** 请求终止（同步、幂等） */
  cancel: () => void
  /** 消费增量输出（供 readOutput） */
  readDelta: () => string
  /** 退出后解析：code/signal + 尾部输出 */
  done: Promise<{ code: number | null; signal: string | null; tail: string; spawnError?: string }>
}

/**
 * 启动后台流式执行：输出增量由调用方按需消费，不预占内存。
 * @param spec - 运行规格
 * @param maxBufferBytes - 增量缓冲区上限（超出丢弃最旧内容并留标记）
 * @returns 流式句柄
 */
export function spawnStreaming(spec: RunSpec, maxBufferBytes = DEFAULT_OUTPUT_LIMIT): StreamHandle {
  let pending = ''
  let dropped = 0
  let killed = false
  let child: ReturnType<typeof spawn> | undefined

  const push = (text: string): void => {
    pending += text
    if (Buffer.byteLength(pending, 'utf8') > maxBufferBytes * 4) {
      const excess = Buffer.byteLength(pending, 'utf8') - maxBufferBytes * 2
      pending = pending.slice(excess)
      dropped += excess
    }
  }

  const done = new Promise<{ code: number | null; signal: string | null; tail: string; spawnError?: string }>((resolve) => {
    let tailRaw = ''
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        windowsHide: true,
        ...(spec.env === undefined ? {} : { env: { ...process.env, ...spec.env } }),
      })
    } catch (error) {
      resolve({ code: null, signal: null, tail: '', spawnError: String(error) })
      return
    }
    const timer = spec.timeoutMs === undefined
      ? undefined
      : setTimeout(() => { killed = true; try { child?.kill() } catch { /* 已退出 */ } }, spec.timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { const t = d.toString('utf8'); push(t); tailRaw = (tailRaw + t).slice(-4000) })
    child.stderr?.on('data', (d: Buffer) => { const t = d.toString('utf8'); push(t); tailRaw = (tailRaw + t).slice(-4000) })
    child.on('error', (e) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code: null, signal: null, tail: tailRaw, spawnError: e.message })
    })
    child.on('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, signal: signal ?? null, tail: tailRaw })
    })
  })

  return {
    cancel: (): void => {
      if (killed) return
      killed = true
      try { child?.kill() } catch { /* 已退出 */ }
    },
    readDelta: (): string => {
      const out = (dropped > 0 ? '... [已丢弃 ' + dropped + " 字节较早输出] ...\n" : '') + pending
      dropped = 0
      pending = ''
      return out
    },
    done,
  }
}
