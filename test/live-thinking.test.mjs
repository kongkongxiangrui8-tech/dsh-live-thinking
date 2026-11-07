import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const lib = require('../client.js')

const t = (key, params) => (params === undefined ? key : key + ':' + JSON.stringify(params))

test('formatClock', () => {
  assert.equal(lib.formatClock(0), '0:00')
  assert.equal(lib.formatClock(7_000), '0:07')
  assert.equal(lib.formatClock(83_000), '1:23')
  assert.equal(lib.formatClock(3_723_000), '1:02:03')
  assert.equal(lib.formatClock(-5), '0:00')
})

test('thinkingLine takes the newest readable line', () => {
  assert.equal(lib.thinkingLine('第一段\n\n第二段'), '第二段')
  assert.equal(lib.thinkingLine('**加粗结论**'), '加粗结论')
  assert.equal(lib.thinkingLine('- 列表项 `code`'), '列表项 code')
  assert.equal(lib.thinkingLine('   \n  '), '')
  assert.equal(lib.thinkingLine('<custom>hidden</custom>'), '')
  assert.equal(lib.thinkingLine(undefined), '')
})

test('thinkingSnippet reads the last reasoning block and truncates the tail', () => {
  const blocks = [
    { kind: 'reasoning', text: '旧的一行' },
    { kind: 'text', text: '答案' },
  ]
  assert.equal(lib.thinkingSnippet(blocks), '旧的一行')

  const long = '甲'.repeat(200)
  const snippet = lib.thinkingSnippet([{ kind: 'reasoning', text: long }])
  assert.equal(Array.from(snippet).length, 96)
  assert.ok(snippet.startsWith('…'))
  assert.ok(snippet.endsWith('甲'))

  assert.equal(lib.thinkingSnippet([{ kind: 'reasoning', text: '<svg/>' }]), '')
  assert.equal(lib.thinkingSnippet(undefined), '')
})

test('toolPreview', () => {
  assert.equal(lib.toolPreview('{"command":"pnpm run build"}'), 'pnpm run build')
  assert.equal(lib.toolPreview('{"tasks":[1,2,3]}'), '3 项')
  assert.equal(lib.toolPreview('not json'), '')
  assert.equal(lib.toolPreview('{"command":"a\\nb"}'), 'a')
  assert.equal(lib.toolPreview('{"command":"' + 'x'.repeat(80) + '"}').length, 42)
})

test('turnAnchor only follows turns that are still open', () => {
  const timings = new Map([
    [1, { startTime: 100, endTime: 200 }],
    [2, { startTime: 300 }],
    [3, { startTime: 250 }],
  ])
  assert.equal(lib.turnAnchor(timings), 300)
  assert.equal(lib.turnAnchor(new Map([[1, { startTime: 1, endTime: 2 }]])), null)
  assert.equal(lib.turnAnchor(undefined), null)
})

test('retryAttempt', () => {
  assert.equal(lib.retryAttempt({ 'deepseek|retry': { retry: 3 } }), 3)
  assert.equal(lib.retryAttempt({ a: { retry: 1 }, b: { retry: 2 } }), 2)
  assert.equal(lib.retryAttempt(null), 0)
})

test('deriveLine hides when idle', () => {
  assert.equal(lib.deriveLine({ running: false, now: 10_000, mountedAt: 9_000 }), null)
})

test('deriveLine prefers retry over everything else', () => {
  const line = lib.deriveLine({
    running: true,
    calls: [{ name: 'bash', time: 9_000 }],
    partial: { blocks: [{ kind: 'reasoning', text: '想一想' }] },
    retry: { p: { retry: 2 } },
    now: 10_000,
    mountedAt: 1_000,
  })
  assert.equal(line.kind, 'retry')
  assert.deepEqual(line.data, { attempt: 2 })
  assert.equal(line.elapsedMs, null)
})

test('deriveLine reports the oldest running tool with its own clock', () => {
  const line = lib.deriveLine({
    running: true,
    calls: [
      { name: 'bash', argsRaw: '{"command":"pnpm build"}', time: 8_000 },
      { name: 'read', argsRaw: '{"file_path":"a.ts"}', time: 9_000 },
    ],
    partial: null,
    now: 10_000,
    mountedAt: 1_000,
  })
  assert.equal(line.kind, 'tool')
  assert.deepEqual(line.data, { name: 'bash', preview: 'pnpm build', more: 1 })
  assert.equal(line.elapsedMs, 2_000)
})

test('deriveLine shows the live reasoning line while thinking', () => {
  const line = lib.deriveLine({
    running: true,
    calls: [],
    partial: { blocks: [{ kind: 'reasoning', text: '先看结构\n再改渲染' }] },
    turnTimings: new Map([[7, { startTime: 4_000 }]]),
    now: 10_000,
    mountedAt: 1_000,
  })
  assert.equal(line.kind, 'think')
  assert.equal(line.data.snippet, '再改渲染')
  /* 思考行不带整轮计时，阶段计时由组件自己算。 */
  assert.equal(line.elapsedMs, null)
})

test('deriveLine distinguishes streaming output from waiting', () => {
  const streaming = lib.deriveLine({
    running: true,
    calls: [],
    partial: { blocks: [{ kind: 'reasoning', text: '想好了' }, { kind: 'text', text: '正' }] },
    now: 10_000,
    mountedAt: 9_000,
  })
  assert.equal(streaming.kind, 'stream')
  assert.equal(streaming.elapsedMs, null)

  const waiting = lib.deriveLine({ running: true, calls: [], partial: null, now: 10_000, mountedAt: 9_000 })
  assert.equal(waiting.kind, 'model')
  assert.equal(waiting.elapsedMs, null)
})

test('lineText composes the tool line', () => {
  const text = lib.lineText({ kind: 'tool', data: { name: 'bash', preview: 'npm test', more: 2 } }, t)
  assert.equal(text, 'tool:{"name":"bash"}: npm testtoolMore:{"count":2}')
  assert.equal(lib.lineText({ kind: 'think', data: { snippet: '想' } }, t), 'think:{"text":"想"}')
})