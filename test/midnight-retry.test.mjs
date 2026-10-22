// 跨零点重试：条件、只重试一次、保留 force/dry_run。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  previousDate,
  shouldRetryAfterMidnight,
  staleDateMessage,
  runDailyWithMidnightRetry,
  retryMetadata,
} from '../lib/retry.js'

const stale = (date = '2026-10-21') => ({ ok: false, state: 'report_rejected', error: 'stale_date', date })
const ok = (date = '2026-10-22') => ({ ok: true, state: 'ok', date })

test('previousDate 计算前一天', () => {
  assert.equal(previousDate('2026-10-22'), '2026-10-21')
  assert.equal(previousDate('2026-03-01'), '2026-02-28')
  assert.equal(previousDate('bad'), null)
})

test('命中：report_rejected + stale_date + date=昨天', () => {
  assert.equal(shouldRetryAfterMidnight(stale(), '2026-10-22'), true)
})

test('不命中：state 不对', () => {
  assert.equal(shouldRetryAfterMidnight({ ...stale(), state: 'failed' }, '2026-10-22'), false)
})

test('不命中：error 不对', () => {
  assert.equal(shouldRetryAfterMidnight({ ...stale(), error: 'other' }, '2026-10-22'), false)
})

test('不命中：date 是今天/更早/缺失', () => {
  assert.equal(shouldRetryAfterMidnight(stale('2026-10-22'), '2026-10-22'), false)
  assert.equal(shouldRetryAfterMidnight(stale('2026-10-20'), '2026-10-22'), false)
  assert.equal(shouldRetryAfterMidnight({ ...stale(), date: undefined }, '2026-10-22'), false)
})

test('命中后用今天重跑一次，并保留 force/dry_run', async () => {
  const calls = []
  const run = async (args) => {
    calls.push(args)
    return calls.length === 1 ? stale() : ok()
  }
  const outcome = await runDailyWithMidnightRetry({
    run,
    date: '2026-10-21',
    flags: { force: true, dry_run: true },
    today: () => '2026-10-22',
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { force: true, dry_run: true, date: '2026-10-21' })
  assert.deepEqual(calls[1], { force: true, dry_run: true, date: '2026-10-22' })
  assert.equal(outcome.retried, true)
  assert.equal(outcome.originalDate, '2026-10-21')
  assert.equal(outcome.retryDate, '2026-10-22')
  assert.equal(outcome.result.ok, true)
})

test('重试也只跑两次，不递归', async () => {
  let calls = 0
  const run = async () => { calls++; return stale() }
  const outcome = await runDailyWithMidnightRetry({
    run,
    date: '2026-10-21',
    flags: { force: false, dry_run: false },
    today: () => '2026-10-22',
  })
  assert.equal(calls, 2)
  assert.equal(outcome.retried, true)
  assert.equal(outcome.result.ok, false)
  assert.equal(outcome.firstResult.error, 'stale_date')
})

test('不满足条件时只跑一次', async () => {
  let calls = 0
  const run = async () => { calls++; return { ok: false, state: 'failed', error: 'boom', date: '2026-10-21' } }
  const outcome = await runDailyWithMidnightRetry({
    run,
    date: '2026-10-21',
    flags: { force: true, dry_run: false },
    today: () => '2026-10-22',
  })
  assert.equal(calls, 1)
  assert.equal(outcome.retried, false)
})

test('显式补跑更早日期不触发', async () => {
  let calls = 0
  const run = async () => { calls++; return stale('2026-10-20') }
  await runDailyWithMidnightRetry({
    run,
    date: '2026-10-20',
    flags: { force: true, dry_run: false },
    today: () => '2026-10-22',
  })
  assert.equal(calls, 1)
})

test('retryMetadata 给返回值标记 retried_after_midnight + 原日期', () => {
  assert.deepEqual(retryMetadata({ retried: false }), {})
  assert.deepEqual(retryMetadata({ retried: true, originalDate: '2026-10-21' }), {
    retried_after_midnight: true,
    original_date: '2026-10-21',
  })
})

test('staleDateMessage 是人话', () => {
  assert.match(staleDateMessage('2026-10-20'), /报告日期 2026-10-20 不是今天/)
  assert.match(staleDateMessage('2026-10-20'), /catch_up/)
})
