/**
 * registry.ts — 视频工厂脚本登记表 + 纯参数构造（可离线单测）
 *
 * 设计原则（主人 2026-09-10：要「创造任何你想要的视频」，不限既有范式）：
 * 本表不描述「快讯流水线」，只描述**每个脚本的 CLI 契约**——路径/解释器/位置参数/可选参数。
 * 工具面基于此把脚本还原为通用原语，因此任何项目、任何组合、任何主题都能跑。
 *
 * 契约来源：2026-09-10 逐脚本源码核对（scripts/*.py、video-studio-skill/scripts/*），
 * 含三个易错点，已在下方逐条标注：
 *   ① generate-bgm / fetch-ai-news 的 --out 按 CWD 解析 → 必须传绝对路径
 *   ② fetch-ai-news 从不 exit(1)（单源失败仅 warn，恒 0）→ 判成败须解析 stdout
 *   ③ render-qa 为手写 argv，`--expect-lufs -14.0` 必须空格分隔，不可用 `=`
 */

/** 解释器档位：tts（音频，有 torch）/ vlm（视觉，有 transformers）/ system（纯标准库）。 */
export type InterpreterKind = 'tts' | 'vlm' | 'system'

/** 单个脚本的 CLI 契约。 */
export interface ScriptDef {
  /** 稳定 id（工具面参数用之） */
  id: string
  /** 相对 studioRoot 的路径 */
  path: string
  /** 解释器档位 */
  interpreter: InterpreterKind
  /** 一句话用途 */
  desc: string
  /** 位置参数名（按顺序；空 = 无位置参数） */
  positional: readonly string[]
  /** 已知可选参数（名称 → 说明；用于视频工厂能力自述） */
  options: Readonly<Record<string, string>>
  /** 该脚本只服务快讯范式（false = 真通用，任意项目可用） */
  newsOnly: boolean
  /** 已知陷阱（会出现在 catalog 里提醒） */
  caveats?: readonly string[]
}

/** 视频工厂脚本登记表（16 项，2026-09-10 源码核对）。 */
export const SCRIPTS: readonly ScriptDef[] = [
  {
    id: 'tts.news',
    path: 'scripts/tts/tts-news.py',
    interpreter: 'tts',
    desc: '文本（script.md，--- 分隔）→ 逐段口播 + 拼接全口播轨（serena 预设音色）',
    positional: [],
    options: {
      '--script': '输入文案（默认 docs/content/script.md）',
      '--out-dir': '输出目录（默认 projects/news-flash/public/audio）',
    },
    newsOnly: false,
    caveats: ['产物命名固化 seg-N.wav / voice-full.wav / audio-segments.json；音色 serena 固化；<3 段即 exit 1'],
  },
  {
    id: 'audio.clone',
    path: 'video-studio-skill/scripts/synthesize-qwen3-gpu.py',
    interpreter: 'tts',
    desc: '声音克隆合成（Qwen3-TTS Base）——需改造才可参数化（当前仅有环境变量入口）',
    positional: [],
    options: {},
    newsOnly: false,
    caveats: ['无 argparse：只认 VIDEO_STUDIO_ROOT / REF_AUDIO 环境变量，其余需改源码；REF_TEXT 为字面占位符，首跑必须手改'],
  },
  {
    id: 'bgm.generate',
    path: 'scripts/music/generate-bgm.py',
    interpreter: 'system',
    desc: 'AI 配乐生成（Stable Audio 3 w8a32 TFLite + loudnorm）',
    positional: [],
    options: {
      '--duration': '秒数（默认 60）',
      '--style': 'tech|upbeat|minimal|cinematic|lofi（默认 tech）',
      '--prompt': '自定义 prompt（覆盖 style）',
      '--seed': '随机种子',
      '--out': '输出 wav（默认按 CWD 解析 → 必须传绝对路径）',
    },
    newsOnly: false,
    caveats: ['--out 相对 CWD 解析（非 ROOT）→ 工具面强制绝对路径'],
  },
  {
    id: 'audio.mix',
    path: 'scripts/music/mix-bgm.py',
    interpreter: 'system',
    desc: '口播 + BGM sidechain ducking 混音 + loudnorm',
    positional: ['voice', 'bgm', 'out'],
    options: {
      '--bgm-volume': '默认 0.35',
      '--duck-thresh': '默认 0.04（docstring 写 0.08 已陈旧，以代码为准）',
      '--duck-ratio': '默认 8.0',
      '--bgm-fade-dur': '默认 2.0',
      '--bgm-highshelf': '默认 0.0',
      '--bgm-lowshelf': '默认 0.0',
    },
    newsOnly: false,
  },
  {
    id: 'audio.check',
    path: 'scripts/music/bgm-check.py',
    interpreter: 'tts',
    desc: 'BGM 存在性（相关 < 阈）+ ducking 实效（≥3dB）',
    positional: ['full', 'mix'],
    options: { '--corr-thresh': '默认 0.80', '--duck-gap': '默认 3.0（dB）' },
    newsOnly: false,
  },
  {
    id: 'qa.render',
    path: 'scripts/qa/render-qa.py',
    interpreter: 'system',
    desc: '成片技术质检：结构/电平/LUFS/时长',
    positional: ['video'],
    options: {
      '--expect-lufs': '默认 -14.0',
      '--expect-duration': '期望时长（秒）',
      '--expect-width': '期望宽',
      '--expect-height': '期望高',
    },
    newsOnly: false,
    caveats: ['手写 argv：须「--expect-lufs -14.0」空格分隔，不可用 =；无参调用 exit 2'],
  },
  {
    id: 'qa.video',
    path: 'scripts/qa/video-qa.py',
    interpreter: 'tts',
    desc: '画面经典检测：空白/模糊/亮度/边缘溢出/帧间跳变',
    positional: ['video'],
    options: { '--sample-every': '默认 15（帧）' },
    newsOnly: false,
    caveats: ['docstring 提到的 --scene-starts 未实现，传了会 argparse 报错 exit 2'],
  },
  {
    id: 'qa.vlm',
    path: 'scripts/qa/vl-qa.py',
    interpreter: 'vlm',
    desc: 'VLM 审片（MiniCPM-V）：关键帧事实描述，不打分——「爱丽丝的眼睛」',
    positional: ['video'],
    options: { '--frames': '采样帧（缺省按 5 段自动）' },
    newsOnly: false,
  },
  {
    id: 'qa.asr',
    path: 'scripts/qa/asr-check.py',
    interpreter: 'tts',
    desc: '台词回听（faster-whisper）：数字读错 / 项目名漏读',
    positional: ['wav'],
    options: { '--script': '对照文案（默认快讯 script.md）' },
    newsOnly: false,
    caveats: ['仅音译提示时 WARN 但仍 exit 0'],
  },
  {
    id: 'qa.aesthetic',
    path: 'scripts/qa/audio-aesthetic.py',
    interpreter: 'system',
    desc: '音频审美四轴（audiobox-aesthetics）：PQ/CE 为主轴',
    positional: ['audio'],
    options: {
      '--start': '默认 0.0',
      '--end': '默认 30.0',
      '--threshold-pq': '默认 6.0',
      '--threshold-ce': '默认 5.5',
    },
    newsOnly: false,
    caveats: ['内部硬调 tts-env 解释器'],
  },
  {
    id: 'qa.rhythm',
    path: 'scripts/qa/rhythm-check.py',
    interpreter: 'tts',
    desc: '节奏对齐 4 指标：段级/空窗/转场断句/句级',
    positional: ['video'],
    options: { '--segments': 'audio-segments.json 路径（默认指向 news-flash）' },
    newsOnly: false,
    caveats: ['退出码：全过 0 / 仅 WARN 1 / 有 FAIL 或文件缺失 2'],
  },
  {
    id: 'qa.sensitive',
    path: 'scripts/qa/check-sensitive.py',
    interpreter: 'system',
    desc: '敏感词扫描（B 站红线 + 金融违禁；内置词库）',
    positional: ['files'],
    options: {},
    newsOnly: false,
    caveats: ['docs/sensitive-words.txt 当前不存在，仅内置 33 词生效'],
  },
  {
    id: 'sync.durations',
    path: 'scripts/sync-durations.py',
    interpreter: 'system',
    desc: 'audio-segments.json 帧数 → news-data.ts durations 回填',
    positional: [],
    options: {
      '--project': '项目目录（默认 projects/news-flash）',
      '--check': '只校验不写入',
    },
    newsOnly: true,
    caveats: ['固化 src/news-data.ts 与 durations: [...] 正则约定'],
  },
  {
    id: 'make.cover',
    path: 'scripts/make-cover.py',
    interpreter: 'tts',
    desc: '封面 still 导出（Remotion）+ 尺寸/黑屏校验',
    positional: [],
    options: { '--frame': '默认 60', '--project': '默认 projects/news-flash' },
    newsOnly: true,
    caveats: ['固化 src/index.ts 入口与组合名 Main；产物 out/cover-MMDD.png'],
  },
  {
    id: 'fetch.news',
    path: 'scripts/fetch/fetch-ai-news.py',
    interpreter: 'system',
    desc: '抓 GitHub trending / HN / HF → data.json（或 --search 只打 stdout）',
    positional: [],
    options: { '--days': '默认 7', '-o': '输出（按 CWD 解析）', '--search': '检索模式，打 JSON 到 stdout' },
    newsOnly: false,
    caveats: ['从不 exit(1)：单源失败仅 warn，恒 0 → 判成败须解析 stdout'],
  },
  {
    id: 'project.scaffold',
    path: 'video-studio-skill/scripts/scaffold.sh',
    interpreter: 'system',
    desc: '从主题建任意 Remotion 项目（23 主题；npm install + typecheck）',
    positional: ['target-dir'],
    options: { '--theme': '主题 id（默认 midnight-press）', '--list-themes': '枚举主题' },
    newsOnly: false,
    caveats: ['需 bash（WSL）+ npm + 网络；目标目录非空即拒绝；typecheck 失败仅警告仍 0'],
  },
]

/** 按 id 取脚本契约。 */
export function findScript(id: string): ScriptDef | undefined {
  return SCRIPTS.find((s) => s.id === id)
}

/** 工具面可直接暴露的「检查类型」→ 脚本 id 映射（video_qa 用）。 */
export const QA_KINDS: Readonly<Record<string, string>> = {
  render: 'qa.render',
  video: 'qa.video',
  vlm: 'qa.vlm',
  asr: 'qa.asr',
  aesthetic: 'qa.aesthetic',
  rhythm: 'qa.rhythm',
  sensitive: 'qa.sensitive',
  bgm: 'audio.check',
  sync: 'sync.durations',
}

/** 参数值联合类型（工具面传入）。 */
export type ParamValue = string | number | boolean | undefined

/**
 * 依据契约构造子进程 argv（纯函数）。
 * 规则：位置参数按 positional 顺序取；可选参数仅在有值时透传；
 * 布尔 true 渲染为裸 flag（如 --check）；数字/字符串用空格分隔（兼容手写 argv 的脚本）。
 * @param def - 脚本契约
 * @param positional - 位置参数值（按契约顺序）
 * @param options - 可选参数名 → 值（缺省/undefined 即不传）
 * @returns 子进程参数数组（不含解释器与脚本路径）
 */
export function buildArgs(
  def: ScriptDef,
  positional: readonly string[],
  options: Readonly<Record<string, ParamValue>> = {},
): string[] {
  const out: string[] = []
  for (let i = 0; i < def.positional.length; i += 1) {
    const v = positional[i]
    if (v === undefined || v === '') {
      throw new Error('缺少位置参数 ' + def.positional[i] + '（脚本 ' + def.id + '）')
    }
    out.push(v)
  }
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false || value === '') continue
    if (value === true) {
      out.push(key)
      continue
    }
    out.push(key, String(value))
  }
  return out
}

/** 解释器档位 → 该档位在 studioRoot 下的可执行路径。 */
export function interpreterPath(studioRoot: string, kind: InterpreterKind): string {
  const base = studioRoot.replace(/[\\/]+$/, '')
  if (kind === 'tts') return base + '/tools/tts-env/Scripts/python.exe'
  if (kind === 'vlm') return base + '/tools/vlm-env/Scripts/python.exe'
  return 'python'
}
