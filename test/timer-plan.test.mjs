// 回归：定时刚过点 2 分钟内要补跑今天，不能直接滚到明天。
// 直接执行 lib/index.js 里的真实源码片段（index.js 依赖宿主包，不能整包 import）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')

function sliceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0, `找不到片段起点：${startMarker}`)
  assert.ok(end > start, `找不到片段终点：${endMarker}`)
  return source.slice(start, end)
}

const todayInSource = sliceBetween('function todayIn(', '/** 最近一期运行摘要')
const timerSource = sliceBetween('function tzOffsetMs(', '// 纯函数暴露给 test')
const sandbox = { Intl, Date, console }
vm.createContext(sandbox)
vm.runInContext(
  `${todayInSource}\n${timerSource}\nglobalThis.__timer = { nextDailyAt, planArm, dailyAt, CATCH_UP_GRACE_MS }`,
  sandbox,
  { filename: 'index.js#timer' },
)
const { nextDailyAt, planArm, dailyAt, CATCH_UP_GRACE_MS } = sandbox.__timer

const TZ = 'Asia/Shanghai'
const at = (iso) => Date.parse(iso)

test('刚过点 20 秒：补跑今天（delay 5 秒），不是明天', () => {
  const now = at('2026-10-22T03:36:20Z') // 11:36:20 +08
  const plan = planArm({ time: '11:36', timeZone: TZ, now })
  assert.equal(plan.catchUp, true)
  assert.equal(plan.target, now + 5000)
  assert.equal(plan.fireKey, '2026-10-22|11:36')
})

test('刚过点 90 秒：仍在 120 秒宽限内，补跑今天', () => {
  const now = at('2026-10-22T03:37:30Z') // 11:37:30 +08
  const plan = planArm({ time: '11:36', timeZone: TZ, now })
  assert.equal(plan.catchUp, true)
  assert.equal(plan.target, now + 5000)
  assert.equal(CATCH_UP_GRACE_MS, 120000)
})

test('当天已经补跑过：不再重复补，排到明天', () => {
  const now = at('2026-10-22T03:37:30Z')
  const plan = planArm({ time: '11:36', timeZone: TZ, now, lastFireKey: '2026-10-22|11:36' })
  assert.equal(plan.catchUp, false)
  assert.equal(plan.target, at('2026-10-23T03:36:00Z'))
})

test('超过 120 秒宽限：不补跑，排到明天', () => {
  const now = at('2026-10-22T03:39:00Z') // 11:39:00 +08
  const plan = planArm({ time: '11:36', timeZone: TZ, now })
  assert.equal(plan.catchUp, false)
  assert.equal(plan.target, at('2026-10-23T03:36:00Z'))
})

test('还没到点（11:35:50）：正常排今天 11:36', () => {
  const now = at('2026-10-22T03:35:50Z')
  const plan = planArm({ time: '11:36', timeZone: TZ, now })
  assert.equal(plan.catchUp, false)
  assert.equal(plan.target, at('2026-10-22T03:36:00Z'))
})

test('非法时间 "696"：回退明天兜底，同时报 lastError', () => {
  const now = at('2026-10-22T03:37:30Z')
  let error = ''
  const plan = planArm({ time: '696', timeZone: TZ, now, onError: (msg) => { error = msg } })
  assert.equal(plan.catchUp, false)
  assert.equal(plan.target, now + 24 * 3600 * 1000)
  assert.match(error, /定时时间格式不合法/)
  assert.match(error, /696/)
})

test('nextDailyAt("696") 自身也记错误并返回明天兜底', () => {
  const now = at('2026-10-22T03:37:30Z')
  let error = ''
  const target = nextDailyAt('696', TZ, now, (msg) => { error = msg })
  assert.equal(target, now + 24 * 3600 * 1000)
  assert.match(error, /定时时间格式不合法/)
})

test('规格时间：11:36 的今日目标与次日目标', () => {
  assert.equal(dailyAt('11:36', TZ, at('2026-10-22T03:37:30Z')), at('2026-10-22T03:36:00Z'))
  assert.equal(
    nextDailyAt('11:36', TZ, at('2026-10-22T03:37:30Z')),
    at('2026-10-23T03:36:00Z'),
  )
})
