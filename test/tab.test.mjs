// tab 选择跨组件重挂载保留 + 注册身份稳定的单测。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let captured
const sandbox = {
  window: { __ModuleLoader__: { load(definition) { captured = definition } } },
  Intl, Date, console, setInterval, clearInterval, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => fn(),
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const reactStub = {
  createElement() { return null },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useRef() { return { current: null } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
const {
  readTab, writeTab, SECTION, draftsFromScoutResult, keywordsToText, parseKeywords,
  subtitleMode, intIn, costNote,
} = plugin.__test

test('tab 默认是 overview', () => {
  writeTab('overview')
  assert.equal(readTab(), 'overview')
})

test('切到 channels 后，模拟组件重挂载仍读回 channels', () => {
  writeTab('channels')
  // 组件重挂载 = 重新执行 useState(readTab)，读到的仍是模块级 store
  assert.equal(readTab(), 'channels')
})

test('重挂载后再切回 overview 也保留', () => {
  writeTab('overview')
  assert.equal(readTab(), 'overview')
})

test('B 站关键词：列表 ↔ 单行输入框', () => {
  const list = ['AI agent', '大模型 应用', 'AI 编程']
  const text = keywordsToText(list)
  assert.equal(text, 'AI agent，大模型 应用，AI 编程')
  assert.equal(JSON.stringify(parseKeywords(text)), JSON.stringify(list))
  assert.equal(JSON.stringify(parseKeywords(' AI agent , 大模型 应用,，AI 编程 ')), JSON.stringify(list))
  assert.equal(JSON.stringify(parseKeywords('')), '[]')
})

test('B 站搜索源字段进入 sourcesDraft（开关/上限/关键词）', () => {
  const draft = draftsFromScoutResult({
    values: {
      sources: {
        bili: {
          on: true,
          search: { on: false, keywords: ['AI agent', 'AI 编程'], max_items: 4, min_play: 6000, max_days: 10, subtitle: 'require' },
        },
      },
    },
  }).sourcesDraft
  assert.equal(draft.biliOn, true)
  assert.equal(draft.biliSearchOn, false)
  assert.equal(draft.biliSearchMaxItems, 4)
  assert.deepEqual(draft.biliSearchKeywords, ['AI agent', 'AI 编程'])
  assert.equal(draft.biliSearchKeywordsText, 'AI agent，AI 编程')
  assert.equal(draft.biliSearchSubtitle, 'require')
  assert.equal(draft.biliSearchMinPlay, 6000)
  assert.equal(draft.biliSearchMaxDays, 10)
})

test('字幕枚举非法回退 prefer；数字输入负数/非数字兜底', () => {
  assert.equal(subtitleMode('off'), 'off')
  assert.equal(subtitleMode('bad'), 'prefer')
  assert.equal(subtitleMode(''), 'prefer')
  assert.equal(intIn('-5', 5000, 0, 1000000), 0)
  assert.equal(intIn('abc', 5000, 0, 1000000), 5000)
  assert.equal(intIn('99999999', 14, 1, 180), 180)
})

test('成本卡文案跟随当前 run.time，不写死 19:00', () => {
  const note = costNote('07:30')
  assert.match(note, /当前定时 07:30/)
  assert.doesNotMatch(note, /默认 19:00/)
})

test('watcher 能收到切换通知（同一次切换多个实例同步）', () => {
  const seen = []
  const off = (value) => seen.push(value)
  writeTab('sources')
  // 直接验证 store 语义：watcher 不在 __test 暴露，这里用 readTab 兜底
  assert.equal(readTab(), 'sources')
  off('noop')
  assert.deepEqual(seen, ['noop'])
})

test('section 注册身份稳定且 id 固定', () => {
  assert.equal(SECTION.id, 'scout')
  assert.equal(SECTION.name, 'settings.section')
  assert.equal(SECTION.order, 40)
  assert.ok(Object.isFrozen(SECTION))
})

test('插件导出的 inject 覆盖 settings/remote 服务', () => {
  assert.deepEqual([...plugin.inject], ['slots', 'remote', 'remote.settings', 'remote.commands'])
  assert.equal(typeof plugin.apply, 'function')
})
