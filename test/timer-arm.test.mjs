// 直接执行 lib/index.js 的 apply()（剥离宿主包 import 后用桩替换），
// 验证 arm() 真的把“刚过点 90 秒”排成 5 秒后补跑，而不是明天；
// 并验证非法时间会在 scout-schedule-status 的 lastError 里露出来。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

function loadPlugin(now) {
  let code = source
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export /gm, '')
    .replaceAll('import.meta.url', "'file:///app/plugin/lib/index.js'")
  code = `
    const z = (() => {
      const chain = new Proxy(function () {}, { get: () => chain, apply: () => chain })
      return chain
    })()
    const defineTool = (def) => def
    const credentialStatus = () => ({})
    const resolveCredentialsFromSettings = () => ({})
    const CREDENTIAL_ENV = {}
    const runDailyWithMidnightRetry = async () => ({})
    const retryMetadata = () => ({})
    const staleDateMessage = () => ''
    const fileURLToPath = () => '/app/plugin/lib/index.js'
    const dirname = () => '/app/plugin/lib'
    const join = (...parts) => parts.join('/')
    ${code}
    globalThis.__plugin = { apply }
  `

  const timers = []
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  const sandbox = {
    Intl, console, Date: FakeDate,
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false, unref() { return this } }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true },
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'index.js#arm' })

  const schedule = { enabled: true, time: '11:36', timeZone: 'Asia/Shanghai', force: false }
  const config = { schedule: { get: () => schedule } }
  const commands = new Map()
  const ctx = {
    effect(fn) { fn() },
    inject(deps, cb) {
      if (deps.includes('tools')) cb({ tools: { register() {} } })
      if (deps.includes('commands')) cb({ commands: { register(def) { commands.set(def.name, def) } } })
    },
  }
  sandbox.__plugin.apply(ctx, config)

  const status = async () => JSON.parse((await commands.get('scout-schedule-status').handler()).text)
  return { timers, schedule, status }
}

const at = (iso) => Date.parse(iso)

test('arm(): 11:36:20 挂表，实际排 5 秒后补跑今天而不是明天', async () => {
  const now = at('2026-10-22T03:36:20Z') // 11:36:20 +08
  const { timers, status } = loadPlugin(now)
  const fire = timers.find((timer) => timer.ms === 5000)
  assert.ok(fire, '应有一根 5 秒的补跑定时器')
  assert.equal(fire.cleared, false)
  const state = await status()
  assert.equal(state.enabled, true)
  assert.equal(state.lastError, '')
  assert.equal(state.nextFireAt, new Date(now + 5000).toISOString())
})

test('arm(): time=696 时 lastError 非空、仍挂明天兜底；改回合法时间后错误清除', async () => {
  const now = at('2026-10-22T03:36:20Z')
  const { timers, schedule, status } = loadPlugin(now)
  schedule.time = 696 // YAML 1.1 会把裸标量 11:36 读成整数 696
  // 模拟下一次 60 秒 poll：直接调用第一根 poll 的回调。
  const poll = timers.find((timer) => timer.ms === 60000)
  assert.ok(poll, '应有一根 60 秒 poll')
  poll.fn()

  const broken = await status()
  assert.match(broken.lastError, /定时时间格式不合法/)
  assert.match(broken.lastError, /696/)
  assert.equal(broken.nextFireAt, new Date(now + 24 * 3600 * 1000).toISOString())

  schedule.time = '11:36'
  const nextPoll = timers.filter((timer) => timer.ms === 60000 && !timer.cleared).at(-1)
  nextPoll.fn()
  const fixed = await status()
  assert.equal(fixed.lastError, '')
  assert.equal(fixed.nextFireAt, new Date(now + 5000).toISOString())
})
