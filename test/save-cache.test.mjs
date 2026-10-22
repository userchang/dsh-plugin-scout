// 保存后缓存更新/失效 + 过期响应不覆盖新值。
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
const plugin = captured.factory((name) => {
  if (name === 'react') return { createElement() {}, useState(v) { return [v, () => {}] }, useEffect() {}, useRef() { return { current: null } }, useCallback(fn) { return fn }, useMemo(fn) { return fn() } }
  throw new Error(`unexpected require: ${name}`)
})
const {
  writeScoutCacheFromResult, readScoutCache, invalidateScoutCache,
  beginScoutSeq, isLatestScoutSeq, commitScoutLoadResult, cacheKeyOf,
} = plugin.__test

function loadResult({ githubOn, sinceDays, maxItems, focus }) {
  return {
    ok: true,
    path: 'scout/config.yaml',
    sha256: `sha-${maxItems}-${sinceDays}`,
    values: {
      focus,
      report: { max_items: maxItems },
      run: { time: '19:00' },
      limits: { total_candidates: 40, reads_max: 20, snippet_chars: 800, per_source_limit: 30 },
      sources: {
        github_search: { on: githubOn, since_days: sinceDays, stars_min: 50 },
        awesome: { on: true }, releases: { on: true }, hn: { on: true }, bili: { on: true },
      },
    },
  }
}

test('save 后缓存立即更新为保存结果，重挂载不会回填旧值', () => {
  const key = cacheKeyOf('s1')
  const oldResult = loadResult({ githubOn: false, sinceDays: 3, maxItems: 4, focus: { topic: 'old', until: '2026-10-22', note: '' } })
  writeScoutCacheFromResult(key, oldResult)
  assert.equal(readScoutCache(key).limitsDraft.maxItems, 4)
  assert.equal(readScoutCache(key).sourcesDraft.githubOn, false)

  const savedResult = loadResult({ githubOn: true, sinceDays: 14, maxItems: 9, focus: { topic: 'new', until: '2026-10-30', note: 'n' } })
  writeScoutCacheFromResult(key, savedResult)
  const cached = readScoutCache(key)
  assert.equal(cached.limitsDraft.maxItems, 9)
  assert.equal(cached.sourcesDraft.githubOn, true)
  assert.equal(cached.sourcesDraft.githubSinceDays, 14)
  assert.equal(cached.focusDraft.topic, 'new')
  assert.equal(cached.scout.sha256, savedResult.sha256)
})

test('invalidateScoutCache 删除缓存并让更早的响应失效', () => {
  const key = cacheKeyOf('s1')
  writeScoutCacheFromResult(key, loadResult({ githubOn: true, sinceDays: 7, maxItems: 6, focus: null }))
  const oldSeq = beginScoutSeq(key)
  assert.equal(isLatestScoutSeq(key, oldSeq), true)

  invalidateScoutCache(key)
  assert.equal(readScoutCache(key), null)
  assert.equal(isLatestScoutSeq(key, oldSeq), false)
})

test('过期响应不覆盖新值：旧 seq 的 commit 返回 null 且缓存仍是新值', () => {
  const key = cacheKeyOf('s2')
  const oldSeq = beginScoutSeq(key)
  // 模拟用户保存：新结果先落地，并把序号推进。
  const saved = loadResult({ githubOn: true, sinceDays: 2, maxItems: 8, focus: { topic: 'saved', until: '2026-10-22', note: '' } })
  writeScoutCacheFromResult(key, saved)
  beginScoutSeq(key)

  // 保存前发出的旧 load 现在才回来。
  const late = loadResult({ githubOn: false, sinceDays: 1, maxItems: 1, focus: null })
  assert.equal(commitScoutLoadResult(key, oldSeq, late), null)
  const cached = readScoutCache(key)
  assert.equal(cached.limitsDraft.maxItems, 8)
  assert.equal(cached.sourcesDraft.githubOn, true)
  assert.equal(cached.focusDraft.topic, 'saved')
})
