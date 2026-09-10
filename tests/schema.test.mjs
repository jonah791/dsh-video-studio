/**
 * schema.test.mjs — 工具输出 schema 完备性守卫（离线，不起子进程）
 *
 * 由来（2026-09-10 实测踩坑）：`video_run` 执行**成功**后却被 host 判
 * `"value.truncated" is not a declared property (additionalProperties: false)`
 * —— 因为 `outcomeValue()` 会返回 truncated/label，而该工具的 output schema 漏声明。
 * defineTool 是严格校验：漏一个字段 = 执行成功也拿不到结果。
 *
 * 本测试用假 ctx 捕获插件真正注册的工具定义，再做两件事：
 *   ① 断言每个「跑脚本的工具」的 output schema 覆盖全部公共结果字段
 *   ② 用最小 JSON-Schema 校验器（additionalProperties:false 语义）验证
 *      合成的前台/后台返回值**都能通过自己的 schema** —— 这才是会拦住该 bug 的判据
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** 捕获 apply() 注册的全部工具定义（假 ctx：不触真实服务）。 */
function captureTools() {
  const tools = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    tools: { register: (def) => { tools.push(def) } },
    get: () => undefined,
    on: () => {},
    effect: () => {},
  }
  apply(ctx, {
    studioRoot: 'E:/video studio',
    defaultProject: 'projects/news-flash',
    timeoutMs: 1000,
    outputLimitBytes: 2048,
    enableLongJobs: false,
  })
  return tools
}

const TOOLS = captureTools()

/** 会跑外部脚本、因而走 outcomeValue() 的工具。 */
const SCRIPT_TOOLS = [
  'video_scaffold', 'video_render', 'video_tts', 'video_bgm',
  'video_mix', 'video_qa', 'video_cover', 'video_run',
]

/** 公共结果字段（必须与 src/index.ts 的 OutcomeFields / OUTCOME_SCHEMA 对齐）。 */
const OUTCOME_KEYS = ['ok', 'background', 'jobId', 'label', 'exitCode', 'stdout', 'stderr', 'truncated']

/**
 * 最小 JSON-Schema 校验器（只覆盖本插件用到的语义）。
 * @param {object} schema - { type:'object', additionalProperties:false, properties }
 * @param {object} value - 待校验值
 * @returns {string|null} 违规说明，null = 通过
 */
function validate(schema, value) {
  if (schema.type === 'object') {
    if (schema.additionalProperties === false && schema.properties !== undefined) {
      const declared = new Set(Object.keys(schema.properties))
      for (const k of Object.keys(value)) {
        if (!declared.has(k)) return '未声明字段: ' + k
      }
    }
    for (const [k, spec] of Object.entries(schema.properties ?? {})) {
      if (spec.required === true && value[k] === undefined) return '缺必填字段: ' + k
    }
  }
  return null
}

test('插件注册了 10 个工具，且命名都在 video_ 命名空间', () => {
  assert.equal(TOOLS.length, 10, '工具数应为 10')
  for (const t of TOOLS) assert.match(t.name, /^video_/, t.name + ' 应在 video_ 命名空间')
  const names = TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'video_bgm', 'video_catalog', 'video_cover', 'video_env', 'video_mix',
    'video_qa', 'video_render', 'video_run', 'video_scaffold', 'video_tts',
  ])
})

test('每个工具都有 output.schema 与 render（模型可见文本由 render 负责）', () => {
  for (const t of TOOLS) {
    assert.ok(t.output?.schema !== undefined, t.name + ' 缺 output.schema')
    assert.equal(typeof t.output.render, 'function', t.name + ' 缺 render')
  }
})

test('跑脚本的工具：schema 必须覆盖全部公共结果字段（本测试即为该 bug 的防线）', () => {
  for (const name of SCRIPT_TOOLS) {
    const t = TOOLS.find((x) => x.name === name)
    assert.ok(t !== undefined, name + ' 未注册')
    const props = Object.keys(t.output.schema.properties ?? {})
    for (const key of OUTCOME_KEYS) {
      assert.ok(props.includes(key), name + ' 的 output schema 漏声明公共字段: ' + key)
    }
  }
})

test('尸体样本：前台返回（含 truncated/label）必须通过自己的 schema', () => {
  // 这是复现原始 bug 的输入形状——修好之前，video_run 正是死在这里
  const foreground = {
    ok: false, background: false, exitCode: 1,
    stdout: 'out', stderr: 'err', truncated: true, label: 'qa.sensitive foo.md',
  }
  for (const name of SCRIPT_TOOLS) {
    const schema = TOOLS.find((x) => x.name === name).output.schema
    const err = validate(schema, foreground)
    assert.equal(err, null, name + ' 前台返回被自身 schema 拒绝：' + err)
  }
})

test('尸体样本：后台返回（含 jobId/label）必须通过自己的 schema', () => {
  const background = { ok: true, background: true, jobId: 'video-1', label: 'render Main' }
  for (const name of SCRIPT_TOOLS) {
    const schema = TOOLS.find((x) => x.name === name).output.schema
    const err = validate(schema, background)
    assert.equal(err, null, name + ' 后台返回被自身 schema 拒绝：' + err)
  }
})

test('健壮样本：最小返回值（仅 ok/background）也必须通过', () => {
  for (const name of SCRIPT_TOOLS) {
    const schema = TOOLS.find((x) => x.name === name).output.schema
    assert.equal(validate(schema, { ok: true, background: false }), null, name)
  }
})

test('render 不抛：前台/后台/退化三种形状都能产出文本（退化样本 = replay 旧日志）', () => {
  for (const name of SCRIPT_TOOLS) {
    const t = TOOLS.find((x) => x.name === name)
    const samples = [
      { ok: true, background: false, exitCode: 0, stdout: 'ok', stderr: '', truncated: false },
      { ok: true, background: true, jobId: 'video-2', label: 'x' },
      // 退化样本：模拟旧版本写入日志、缺本轮新增字段的 replay 场景——render 不得崩
      { ok: true, background: true, jobId: 'video-old' },
      {},
    ]
    for (const v of samples) {
      const blocks = t.output.render({}, v)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, name + ' render 返回空')
      assert.equal(blocks[0].type, 'text', name + ' render 应返回文本块')
      assert.ok(typeof blocks[0].text === 'string', name + ' render 文本非字符串')
    }
  }
})

test('自查工具（env/catalog）不误带脚本结果字段，且必填项齐全', () => {
  for (const name of ['video_env', 'video_catalog']) {
    const schema = TOOLS.find((x) => x.name === name).output.schema
    const props = Object.keys(schema.properties ?? {})
    assert.ok(props.includes('ok'), name + ' 应有 ok')
    const err = validate(schema, { ok: true, background: false })
    assert.ok(err !== null, name + ' 不应声明 background（非脚本工具，避免误导）')
  }
})
