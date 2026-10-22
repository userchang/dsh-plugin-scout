// 加载闸门单测：同一 key 只 load 一次、session 变化可重载、in-flight 跳过、5s 节流。
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
  useRef() { return { current: null } },
  useCallback(fn) { return fn },
  useMemo(fn) { return fn() },
}
const plugin = captured.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require: ${name}`)
})
const { createLoadGuard, MIN_LOAD_INTERVAL_MS } = plugin.__test

test('默认节流窗口是 5 秒', () => {
  assert.equal(MIN_LOAD_INTERVAL_MS, 5000)
})

test('同一 key 只 load 一次：成功后 plan 返回 loaded', () => {
  const guard = createLoadGuard()
  const first = guard.begin('s1', 1000)
  assert.equal(first.allowed, true)
  guard.succeed('s1')

  const again = guard.plan('s1', 60_000)
  assert.equal(again.allowed, false)
  assert.equal(again.reason, 'loaded')
  assert.equal(guard.isLoaded('s1'), true)
})

test('sessionId 变化后可重新加载', () => {
  const guard = createLoadGuard()
  guard.begin('s1', 1000)
  guard.succeed('s1')

  const next = guard.begin('s2', 60_000)
  assert.equal(next.allowed, true)
  guard.succeed('s2')
  assert.equal(guard.loadedKey, 's2')
})

test('in-flight 时同 key/换 key 都跳过，避免并发重入', () => {
  const guard = createLoadGuard()
  assert.equal(guard.begin('s1', 1000).allowed, true)

  const same = guard.begin('s1', 1001)
  assert.equal(same.allowed, false)
  assert.equal(same.reason, 'inflight')

  const other = guard.begin('s2', 1002)
  assert.equal(other.allowed, false)
  assert.equal(other.reason, 'inflight')

  guard.fail()
  // fail 之后仍受 5s 节流约束，窗口过了才允许下一个 key。
  assert.equal(guard.begin('s2', 1003).reason, 'throttled')
  assert.equal(guard.begin('s2', 1000 + 5000).allowed, true)
})

test('失败不把 key 记为已加载，但 5s 内重试被节流', () => {
  const guard = createLoadGuard()
  assert.equal(guard.begin('s1', 1000).allowed, true)
  guard.fail('error')
  assert.equal(guard.isLoaded('s1'), false)

  const tooSoon = guard.plan('s1', 1000 + 4999)
  assert.equal(tooSoon.allowed, false)
  assert.equal(tooSoon.reason, 'throttled')
  assert.equal(tooSoon.waitMs, 1)

  const afterWindow = guard.begin('s1', 1000 + 5000)
  assert.equal(afterWindow.allowed, true)
})

test('节流按 key 无关的全局时间戳计算（换 key 也不能绕过）', () => {
  const guard = createLoadGuard()
  guard.begin('s1', 1000)
  guard.fail('error')

  const switched = guard.begin('s2', 2000)
  assert.equal(switched.allowed, false)
  assert.equal(switched.reason, 'throttled')
  assert.equal(switched.waitMs, 4000)
})

test('noteAttempt 从真正发命令的时刻重新起算 5s 窗口', () => {
  const guard = createLoadGuard()
  assert.equal(guard.begin('s1', 1000).allowed, true)
  guard.fail('error')

  // 模拟 describe 很慢：4s 后才真正发 /scout-config-load。
  guard.noteAttempt(5000)
  const atNine = guard.plan('s1', 9000)
  assert.equal(atNine.allowed, false)
  assert.equal(atNine.reason, 'throttled')
  assert.equal(atNine.waitMs, 1000)
  assert.equal(guard.plan('s1', 10000).allowed, true)
})

test('显式 force 重试绕过 loaded/节流，但仍尊重 in-flight', () => {
  const guard = createLoadGuard()
  guard.begin('s1', 1000)
  guard.succeed('s1')

  const forced = guard.begin('s1', 1001, true)
  assert.equal(forced.allowed, true)
  assert.equal(forced.reason, 'forced')

  const concurrent = guard.begin('s1', 1002, true)
  assert.equal(concurrent.allowed, false)
  assert.equal(concurrent.reason, 'inflight')
})
