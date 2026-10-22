// 定时状态的三层取数：宿主定时器自报 > describe 的 value > 未知。
// 这条 bug 的核心不是「读错了值」，而是「读不到值时假装读到了」：
// 拿不到 row 就断言「未保存」，等于跟用户说假话。
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

const plugin = captured.factory((name) => {
  if (name === 'react') {
    return {
      createElement() { return null },
      useState(initial) { return [initial, () => {}] },
      useEffect() {},
      useRef() { return { current: null } },
      useCallback(fn) { return fn },
      useMemo(fn) { return fn() },
    }
  }
  throw new Error(`unexpected require: ${name}`)
})
const { resolveScheduleView } = plugin.__test

const SAVED_ON = { schedule: { enabled: true, time: '19:00', timeZone: 'Asia/Shanghai' } }
const SAVED_OFF = { schedule: { enabled: false, time: '21:30', timeZone: 'Asia/Shanghai' } }
const NO_BLOCK = { channels: [], credentials: {} }

test('宿主自报已挂表：以它为准，即使 describe 里没有 schedule', () => {
  const v = resolveScheduleView({
    status: { ok: true, enabled: true, time: '19:00', nextFireAt: '2026-10-22T11:00:00.000Z' },
    rowValue: NO_BLOCK,
    rowLoaded: true,
    fallbackTime: '19:00',
  })
  assert.equal(v.known, true)
  assert.equal(v.enabled, true)
  assert.equal(v.source, 'host')
  assert.equal(v.nextFireAt, '2026-10-22T11:00:00.000Z')
})

test('宿主自报没挂表：明确「未生效」，不再区分存没存过', () => {
  const v = resolveScheduleView({
    status: { ok: true, enabled: false, time: '21:30' },
    rowValue: SAVED_ON,
    rowLoaded: true,
  })
  assert.equal(v.known, true)
  assert.equal(v.enabled, false)
  assert.equal(v.time, '21:30')
  assert.equal(v.source, 'host')
})

test('宿主状态取不到但 describe 有值：退回配置判断', () => {
  const v = resolveScheduleView({
    status: { ok: false, error: '当前没有打开的会话' },
    rowValue: SAVED_ON,
    rowLoaded: true,
    fallbackTime: '19:00',
  })
  assert.equal(v.known, true)
  assert.equal(v.enabled, true)
  assert.equal(v.source, 'settings')
})

test('两边都拿不到：unknown，不许说「未保存」', () => {
  const v = resolveScheduleView({ status: null, rowValue: null, rowLoaded: false, fallbackTime: '19:00' })
  assert.equal(v.known, false)
  assert.equal(v.enabled, false)
  assert.equal(v.source, 'unknown')
  assert.equal(v.time, '19:00')
})

test('describe 已加载但没有 schedule 块：确实没存过', () => {
  const v = resolveScheduleView({ status: null, rowValue: NO_BLOCK, rowLoaded: true })
  assert.equal(v.known, true)
  assert.equal(v.saved, false)
  assert.equal(v.enabled, false)
  assert.equal(v.source, 'unknown')
})

test('存过但关着：saved 真、enabled 假', () => {
  const v = resolveScheduleView({ status: null, rowValue: SAVED_OFF, rowLoaded: true })
  assert.equal(v.known, true)
  assert.equal(v.saved, true)
  assert.equal(v.enabled, false)
  assert.equal(v.time, '21:30')
})

test('宿主状态缺字段时用兜底时间，不出现 undefined', () => {
  const v = resolveScheduleView({ status: { ok: true, enabled: true }, fallbackTime: '20:15' })
  assert.equal(v.time, '20:15')
  assert.equal(v.timeZone, 'Asia/Shanghai')
  assert.equal(v.nextFireAt, '')
})

test('status 里的 verified:false 视为不可信，退回 describe', () => {
  const v = resolveScheduleView({
    status: { ok: true, verified: false, enabled: true },
    rowValue: SAVED_OFF,
    rowLoaded: true,
  })
  assert.equal(v.enabled, false)
  assert.equal(v.source, 'settings')
})
