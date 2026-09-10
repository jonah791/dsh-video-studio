/**
 * probe.ts — 视频工厂发现层（我能做什么：主题 / 项目 / 组合 / 环境）
 *
 * 解析逻辑抽为纯函数（`parseCompositions` / `summarizeEnv`），便于离线单测；
 * 文件系统访问集中在 `probeEnv` / `listThemes` / `listProjects` / `readCompositions`。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 一个 Remotion 组合的声明（从 Root.tsx 解析）。
 * 用 type 别名而非 interface —— 工具返回值要过 `JsonValue` 校验，
 * interface 不带隐式索引签名而 type 字面量可以，这样可直通 schema。
 */
export type CompositionInfo = {
  id: string
  fps?: number
  width?: number
  height?: number
  /** 声明式时长（帧）；由变量表达式给出时为 undefined */
  durationInFrames?: number
}

/**
 * 从 Root.tsx 源码解析 `<Composition ... />` 声明（纯函数）。
 * 只做属性级解析：id / fps / width / height / durationInFrames（数字字面量）。
 * 属性值若是变量表达式则该项留空——宁可少报，不给错值。
 * @param source - Root.tsx 文本
 * @returns 组合清单
 */
export function parseCompositions(source: string): CompositionInfo[] {
  const out: CompositionInfo[] = []
  const blocks = source.split(/<Composition\b/)
  for (let i = 1; i < blocks.length; i += 1) {
    const block = blocks[i] ?? ''
    const num = (name: string): number | undefined => {
      const m = new RegExp(name + '=\\{?(\\d+)\\}?').exec(block)
      return m === null ? undefined : Number(m[1])
    }
    const idMatch = /id="([^"]+)"/.exec(block) ?? /id=\{'([^']+)'\}/.exec(block)
    if (idMatch === null) continue
    const info: CompositionInfo = { id: idMatch[1] ?? '' }
    const fps = num('fps'); if (fps !== undefined) info.fps = fps
    const width = num('width'); if (width !== undefined) info.width = width
    const height = num('height'); if (height !== undefined) info.height = height
    const dur = num('durationInFrames'); if (dur !== undefined) info.durationInFrames = dur
    out.push(info)
  }
  return out
}

/** 环境项体检结果。 */
export type EnvItem = {
  key: string
  path: string
  ok: boolean
}

/**
 * 汇总环境体检结论（纯函数：只依赖传入的存在性判定）。
 * @param items - 已判定的环境项
 * @returns 分组结论 + 是否可跑通链路
 */
export function summarizeEnv(items: readonly EnvItem[]): { ok: boolean; missing: string[]; note: string } {
  const missing = items.filter((i) => !i.ok).map((i) => i.key)
  return {
    ok: missing.length === 0,
    missing,
    note: missing.length === 0
      ? '环境齐备：音频/视觉解释器、模型资产、ffmpeg 均就位'
      : '缺失 ' + missing.length + ' 项：' + missing.join(' / ') + '（按 tools/README.md 重新获取）',
  }
}

/** 列出可用主题（video-studio-skill/themes/*）。 */
export function listThemes(studioRoot: string): string[] {
  const dir = join(studioRoot, 'video-studio-skill', 'themes')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'tokens.css')))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 列出已存在的 Remotion 项目（projects/*，须含 src/index.ts）。 */
export function listProjects(studioRoot: string): string[] {
  const dir = join(studioRoot, 'projects')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'src', 'index.ts')))
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/** 读取项目的 Remotion 入口相对路径（默认 src/index.ts）。 */
export function entryOf(projectDir: string): string {
  return existsSync(join(projectDir, 'src', 'index.ts')) ? 'src/index.ts' : 'src/index.tsx'
}

/** 读取项目的组合清单（解析 Root.tsx / Root.tsx 引用）。 */
export function readCompositions(projectDir: string): CompositionInfo[] {
  const root = join(projectDir, 'src', 'Root.tsx')
  if (!existsSync(root)) return []
  try {
    return parseCompositions(readFileSync(root, 'utf8'))
  } catch {
    return []
  }
}

/** 环境体检（真实 IO）。 */
export function probeEnv(studioRoot: string): { items: EnvItem[]; summary: ReturnType<typeof summarizeEnv>; themes: number; projects: string[] } {
  const items: EnvItem[] = [
    { key: 'tts-env 解释器（音频）', path: 'tools/tts-env/Scripts/python.exe', ok: existsSync(join(studioRoot, 'tools', 'tts-env', 'Scripts', 'python.exe')) },
    { key: 'vlm-env 解释器（视觉）', path: 'tools/vlm-env/Scripts/python.exe', ok: existsSync(join(studioRoot, 'tools', 'vlm-env', 'Scripts', 'python.exe')) },
    { key: 'TTS 模型（CustomVoice 4.3G）', path: 'tools/Qwen3-TTS-12Hz-1.7B-CustomVoice', ok: existsSync(join(studioRoot, 'tools', 'Qwen3-TTS-12Hz-1.7B-CustomVoice')) },
    { key: 'VLM 模型（MiniCPM-V）', path: 'tools/models/minicpm-v-4.6-awq', ok: existsSync(join(studioRoot, 'tools', 'models', 'minicpm-v-4.6-awq')) },
    { key: '配乐引擎（stable-audio-3）', path: 'tools/refs/stable-audio-3', ok: existsSync(join(studioRoot, 'tools', 'refs', 'stable-audio-3')) },
    { key: '音频审美模型（audiobox）', path: 'tools/models/audiobox-aesthetics', ok: existsSync(join(studioRoot, 'tools', 'models', 'audiobox-aesthetics')) },
    { key: '技能真源（video-studio-skill）', path: 'video-studio-skill', ok: existsSync(join(studioRoot, 'video-studio-skill')) },
    { key: '脚本目录（scripts）', path: 'scripts', ok: existsSync(join(studioRoot, 'scripts')) },
  ]
  return {
    items,
    summary: summarizeEnv(items),
    themes: listThemes(studioRoot).length,
    projects: listProjects(studioRoot),
  }
}

/** 文件是否非空（用于判定渲染产物有效）。 */
export function nonEmptyFile(path: string): boolean {
  try {
    return statSync(path).size > 0
  } catch {
    return false
  }
}
