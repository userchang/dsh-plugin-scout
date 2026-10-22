// 峰谷判断单测：用注入的时间跑，不依赖真实时钟。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

let captured
const sandbox = {
  window: { __ModuleLoader__: { load(definition) { captured = definition } } },
  Intl, Date, console, setInterval, clearInterval, setTimeout, clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

const reactStub = {
  createElement() { return null },
  useState(initial) { return [initial, () => {}] },
  useEffect() {},
  useCallback(fn) { return fn },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
const { priceState } = plugin.__test

// 2026-10-19 是周一；北京时间 = UTC+8。
const at = (iso) => Date.parse(iso)
const cst = (hm) => `2026-10-19T${hm}:00+08:00`

test('工作日 09:00–12:00 是高峰', () => {
  assert.equal(priceState(at(cst('09:00'))).peak, true)
  assert.equal(priceState(at(cst('10:30'))).peak, true)
  assert.equal(priceState(at(cst('11:59'))).peak, true)
})

test('12:00 起回到原价（半开区间）', () => {
  assert.equal(priceState(at(cst('12:00'))).peak, false)
  assert.equal(priceState(at(cst('13:59'))).peak, false)
})

test('14:00–18:00 是高峰', () => {
  assert.equal(priceState(at(cst('14:00'))).peak, true)
  assert.equal(priceState(at(cst('17:59'))).peak, true)
  assert.equal(priceState(at(cst('18:00'))).peak, false)
})

test('默认 19:00 是空闲（原价）', () => {
  const result = priceState(at(cst('19:00')))
  assert.equal(result.peak, false)
  assert.equal(result.label, '现在：空闲（原价）')
  assert.equal(result.multiplier, 1)
})

test('周末按空闲算', () => {
  // 2026-10-24 周六 10:30 CST
  assert.equal(priceState(at('2026-10-24T10:30:00+08:00')).peak, false)
  assert.equal(priceState(at('2026-10-25T15:00:00+08:00')).peak, false)
})

test('注入节假日也按空闲算', () => {
  assert.equal(priceState(at(cst('10:30')), { holidays: ['2026-10-19'] }).peak, false)
})

test('徽章文案随峰谷变化', () => {
  assert.equal(priceState(at(cst('10:00'))).label, '现在：高峰（×2）')
  assert.equal(priceState(at(cst('20:05'))).label, '现在：空闲（原价）')
})
