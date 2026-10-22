// scheduleState 是**兜底路径**：宿主命令取不到时，才拿 describe 的 value 判一眼。
// 注意别再把它当真相——schema 里 schedule.enabled 的缺省值是 true，
// 所以宿主那边「没存过」也等于「默认开」。真正的答案由 /scout-schedule-status 给。
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
const { scheduleState } = plugin.__test

test('配置里没有 schedule 块：未保存、未启用（面板勾着也不算）', () => {
  const s = scheduleState({ channels: [], credentials: {} }, '19:00')
  assert.equal(s.saved, false)
  assert.equal(s.enabled, false)
  assert.equal(s.time, '19:00')
})

test('rawValue 为 null/undefined 也不炸', () => {
  for (const raw of [null, undefined, 0, 'x']) {
    const s = scheduleState(raw, '18:30')
    assert.equal(s.saved, false)
    assert.equal(s.enabled, false)
    assert.equal(s.time, '18:30')
  }
})

test('存过且 enabled:true：启用，时间取保存值', () => {
  const s = scheduleState({ schedule: { enabled: true, time: '21:15', timeZone: 'Asia/Shanghai' } }, '19:00')
  assert.deepEqual(
    { saved: s.saved, enabled: s.enabled, time: s.time, timeZone: s.timeZone },
    { saved: true, enabled: true, time: '21:15', timeZone: 'Asia/Shanghai' },
  )
})

test('存过但 enabled:false：算「已关闭」，仍然要进待办', () => {
  const s = scheduleState({ schedule: { enabled: false, time: '19:00' } }, '19:00')
  assert.equal(s.saved, true)
  assert.equal(s.enabled, false)
})

test('存过的块里没有 enabled 字段：按未启用处理', () => {
  const s = scheduleState({ schedule: { time: '07:00' } }, '19:00')
  assert.equal(s.saved, true)
  assert.equal(s.enabled, false)
  assert.equal(s.time, '07:00')
})

test('schedule 不是对象（历史脏数据）：视为未保存', () => {
  const s = scheduleState({ schedule: '19:00' }, '19:00')
  assert.equal(s.saved, false)
  assert.equal(s.enabled, false)
  const arr = scheduleState({ schedule: ['19:00'] }, '19:00')
  assert.equal(arr.saved, false)
})

test('只认 enabled === true，字符串 "true" 不算', () => {
  assert.equal(scheduleState({ schedule: { enabled: 'true' } }, '19:00').enabled, false)
  assert.equal(scheduleState({ schedule: { enabled: 1 } }, '19:00').enabled, false)
})

test('倒计时/峰谷文案用的时间跟保存值一致', () => {
  // costNote 只做展示，这里确认保存的时间能被取到并传出去
  const s = scheduleState({ schedule: { enabled: true, time: '20:05' } }, '19:00')
  assert.equal(s.time, '20:05')
})
