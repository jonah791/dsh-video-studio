/**
 * registry/probe 纯函数离线单测（不触网、不起子进程、不读磁盘）
 * 运行：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SCRIPTS, QA_KINDS, buildArgs, findScript, interpreterPath } from '../lib/registry.js'
import { parseCompositions, summarizeEnv } from '../lib/probe.js'

// ───────── 登记表契约 ─────────

test('registry: 每个脚本 id 唯一且路径落在预期分组内', () => {
  const ids = SCRIPTS.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')
  for (const s of SCRIPTS) {
    assert.ok(s.path.endsWith('.py') || s.path.endsWith('.sh'), s.id + ' 应是 .py/.sh')
    assert.ok(['tts', 'vlm', 'system'].includes(s.interpreter), s.id + ' 解释器档位非法')
  }
})

test('registry: QA_KINDS 的每个映射都指向已登记脚本', () => {
  for (const [kind, id] of Object.entries(QA_KINDS)) {
    assert.ok(findScript(id) !== undefined, 'kind ' + kind + ' → 未登记脚本 ' + id)
  }
})

test('registry: findScript 命中与未命中', () => {
  assert.equal(findScript('qa.vlm')?.interpreter, 'vlm')
  assert.equal(findScript('不存在'), undefined)
})

// ───────── argv 构造（核心：位置参数顺序 + 空值裁剪） ─────────

test('buildArgs: 位置参数按契约顺序拼接', () => {
  const def = findScript('audio.mix')
  assert.deepEqual(buildArgs(def, ['v.wav', 'b.wav', 'o.wav']), ['v.wav', 'b.wav', 'o.wav'])
})

test('buildArgs: 缺位置参数即抛（不静默传 undefined）', () => {
  const def = findScript('audio.mix')
  assert.throws(() => buildArgs(def, ['v.wav', 'b.wav']), /缺少位置参数/)
})

test('buildArgs: 可选参数——undefined/false/空串跳过，true 渲染裸 flag', () => {
  const def = findScript('sync.durations')
  assert.deepEqual(buildArgs(def, [], { '--project': 'p', '--check': true }), ['--project', 'p', '--check'])
  assert.deepEqual(buildArgs(def, [], { '--check': undefined, '--project': '' }), [])
  assert.deepEqual(buildArgs(def, [], { '--check': false }), [])
})

test('buildArgs: 数字用空格分隔（兼容 render-qa 手写 argv，不能用 = ）', () => {
  const def = findScript('qa.render')
  const argv = buildArgs(def, ['out.mp4'], { '--expect-lufs': -14.0 })
  assert.deepEqual(argv, ['out.mp4', '--expect-lufs', '-14'])
  assert.ok(!argv.some((a) => a.includes('=')), '不得出现 --flag=value 形式')
})

test('buildArgs: 0 是合法值，不得被当作空值裁掉', () => {
  const def = findScript('qa.aesthetic')
  assert.deepEqual(buildArgs(def, ['a.wav'], { '--start': 0 }), ['a.wav', '--start', '0'])
})

// ───────── 解释器解析 ─────────

test('interpreterPath: 三档解析（含尾部斜杠归一）', () => {
  const root = 'E:/video studio'
  assert.equal(interpreterPath(root, 'tts'), 'E:/video studio/tools/tts-env/Scripts/python.exe')
  assert.equal(interpreterPath(root, 'vlm'), 'E:/video studio/tools/vlm-env/Scripts/python.exe')
  assert.equal(interpreterPath(root, 'system'), 'python')
  assert.equal(interpreterPath(root + '\\', 'tts'), 'E:/video studio/tools/tts-env/Scripts/python.exe')
})

// ───────── Root.tsx 组合解析 ─────────

test('parseCompositions: 解析 id/fps/尺寸/时长', () => {
  const src = `
    import { Composition } from "remotion";
    const totalFrames = newsData.durations.reduce((a, b) => a + b, 0);
    export const RemotionRoot = () => (
      <>
        <Composition id="Main" component={Main} durationInFrames={totalFrames} fps={30} width={1920} height={1080} />
        <Composition id="Cover" component={Cover} durationInFrames={90} fps={30} width={1920} height={1080} />
      </>
    );`
  const got = parseCompositions(src)
  assert.equal(got.length, 2)
  assert.deepEqual(got[0], { id: 'Main', fps: 30, width: 1920, height: 1080 }) // 变量时长 → 不报错值
  assert.deepEqual(got[1], { id: 'Cover', fps: 30, width: 1920, height: 1080, durationInFrames: 90 })
})

test('parseCompositions: 无组合声明返回空数组（不抛）', () => {
  assert.deepEqual(parseCompositions('export const x = 1'), [])
  assert.deepEqual(parseCompositions(''), [])
})

// ───────── 环境体检汇总 ─────────

test('summarizeEnv: 全齐 → ok', () => {
  const r = summarizeEnv([{ key: 'a', path: 'a', ok: true }, { key: 'b', path: 'b', ok: true }])
  assert.equal(r.ok, true)
  assert.deepEqual(r.missing, [])
})

test('summarizeEnv: 有缺失 → ok=false 且列出缺失项与获取指引', () => {
  const r = summarizeEnv([{ key: 'tts-env', path: 'x', ok: false }, { key: 'ffmpeg', path: 'y', ok: true }])
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['tts-env'])
  assert.match(r.note, /tools\/README\.md/)
})

// ───────── 已知陷阱必须留在契约里（防回归） ─────────

test('契约守卫: 三个易错点仍在登记表中被标注', () => {
  assert.match(findScript('bgm.generate').caveats.join(' '), /CWD/, 'bgm --out 按 CWD 解析的坑必须在登记表')
  assert.match(findScript('fetch.news').caveats.join(' '), /从不 exit/, 'fetch 恒 0 的坑必须在登记表')
  assert.match(findScript('qa.render').caveats.join(' '), /=/, 'render-qa 不支持 --flag=value 的坑必须在登记表')
})
