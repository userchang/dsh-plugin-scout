// 回归：即使宿主每次渲染都给一个新的 remote 身份，mount effect 也只能加载一次。
// 这条正是 desktop 刷屏的根因（Cordis 的 ctx.remote 每次读取返回新的 traceable Proxy）。
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
  document: {
    createElement() { return { dataset: {}, remove() {}, textContent: '' } },
    head: { appendChild() {} },
  },
  Intl, Date, console, setInterval, clearInterval, setTimeout, clearTimeout,
  requestAnimationFrame: (fn) => fn(),
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

function depsChanged(previous, next) {
  if (!previous || previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

/**
 * 极简 React hooks 运行时：只实现本组件用到的 useState/useRef/useCallback/
 * useMemo/useEffect，并支持渲染后 effect 与微任务刷新。
 */
function createHarness(component, props) {
  const hooks = []
  let cursor = 0
  let dirty = false
  let lastTree
  const pendingEffects = []

  const React = {
    createElement(type, config, ...children) {
      return { type, props: { ...(config || {}), children } }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (Object.is(value, hooks[index])) return
        hooks[index] = value
        dirty = true
      }
      return [hooks[index], setState]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in hooks)) hooks[index] = { current: initial }
      return hooks[index]
    },
    useMemo(factory, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || depsChanged(previous.deps, deps)) hooks[index] = { value: factory(), deps }
      return hooks[index].value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || depsChanged(previous.deps, deps)) hooks[index] = { fn, deps }
      return hooks[index].fn
    },
    useEffect(effect, deps) {
      const index = cursor++
      const previous = hooks[index]
      if (previous && !depsChanged(previous.deps, deps)) return
      if (previous?.cleanup) previous.cleanup()
      const entry = { deps, cleanup: undefined, effect }
      hooks[index] = entry
      pendingEffects.push(entry)
    },
  }

  function render() {
    cursor = 0
    pendingEffects.length = 0
    lastTree = component(props)
    for (const entry of pendingEffects) {
      const cleanup = entry.effect()
      entry.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
  }

  async function flushMicrotasks() {
    // 真实调用链是 await describe → await execute → JSON.parse，给足微任务轮次。
    for (let i = 0; i < 12; i++) await Promise.resolve()
  }

  async function settle(maxRenders = 50) {
    let renders = 0
    do {
      dirty = false
      render()
      await flushMicrotasks()
      renders++
    } while (dirty && renders < maxRenders)
    return renders
  }

  async function rerender() {
    render()
    await flushMicrotasks()
  }

  function dispose() {
    for (const hook of hooks) {
      if (typeof hook?.cleanup === 'function') {
        hook.cleanup()
        hook.cleanup = undefined
      }
    }
  }

  return {
    React, render, settle, rerender, flushMicrotasks, dispose,
    get lastTree() { return lastTree },
  }
}

function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  const children = node.props?.children
  if (Array.isArray(children)) for (const child of children) findAll(child, predicate, out)
  else findAll(children, predicate, out)
  return out
}

function tabButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button'
    && node.props?.className === 'scout-tab'
    && String(node.props.children).includes(label))[0]
}

function createScene() {
  const calls = []
  const values = {
    focus: { topic: 'AI 语音', until: '2026-10-22', note: '' },
    report: { max_items: 6 },
    run: { time: '19:00' },
    limits: { total_candidates: 40, reads_max: 20, snippet_chars: 800, per_source_limit: 30 },
    sources: {
      github_search: { on: true, since_days: 7, stars_min: 50 },
      awesome: { on: true }, releases: { on: true }, hn: { on: true }, bili: { on: true },
    },
  }
  const remoteTarget = {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'scout', value: { channels: [] }, revision: 1, secrets: [] }] } }),
    },
    commands: {
      execute: async (sessionId, line) => {
        calls.push({ sessionId, line })
        const commandId = `cmd-${calls.length}`
        if (line === '/scout-cred-status') {
          const fields = {
            githubToken: { settings: true, snippet: false, effective: true, source: 'settings' },
            deepseekApiKey: { settings: true, snippet: false, effective: true, source: 'settings' },
            biliSessdata: { settings: true, snippet: false, effective: true, source: 'settings' },
            feishuWebhook: { settings: true, snippet: false, effective: true, source: 'settings' },
          }
          return { ok: true, value: { commandId, result: { kind: 'success', text: JSON.stringify({ ok: true, fields }) } } }
        }
        // 用真实 commands.execute 形状：{commandId, result:{kind,text}}。
        return { ok: true, value: { commandId, result: { kind: 'success', text: JSON.stringify({ ok: true, values }) } } }
      },
    },
  }
  let remoteReads = 0
  const ctx = {
    // 模拟 Cordis：每次读 ctx.remote 都得到新的 Proxy/包装对象。
    get remote() {
      remoteReads++
      return new Proxy(remoteTarget, {})
    },
    effect(effect) { return effect() },
    slots: {
      inject(_key, callback) { callback() },
      register(options, component) { ctx.registered = { options, component }; return () => {} },
    },
    registered: null,
  }
  return { calls, ctx, remoteReads: () => remoteReads }
}

test('remote 每次读取都是新对象：同一会话 mount 只发一次 /scout-config-load，且 tab 点击立即生效', async () => {
  const scene = createScene()
  // 组件闭包在 factory 执行时就拿到 React；用一个转发层指向稍后创建的 harness。
  let activeReact
  const reactBridge = {
    createElement: (...args) => activeReact.createElement(...args),
    useState: (...args) => activeReact.useState(...args),
    useRef: (...args) => activeReact.useRef(...args),
    useMemo: (...args) => activeReact.useMemo(...args),
    useCallback: (...args) => activeReact.useCallback(...args),
    useEffect: (...args) => activeReact.useEffect(...args),
  }
  const plugin = captured.factory((name) => {
    if (name !== 'react') throw new Error(`unexpected require: ${name}`)
    return reactBridge
  })
  plugin.apply(scene.ctx)
  assert.ok(scene.ctx.registered, 'apply 应注册 settings.section')

  const harness = createHarness(scene.ctx.registered.component, {
    useSessions(selector) {
      return selector({ byId: { s1: { retainedBy: { mainView: 1 } } } })
    },
  })
  activeReact = harness.React
  await harness.settle()

  const configLoads = () => scene.calls.filter((call) => call.line === '/scout-config-load')
  assert.equal(configLoads().length, 1, '同一会话只应加载一次')
  assert.ok(scene.remoteReads() >= 1, 'remote 至少被读取一次')

  // 直接点击「渠道」：不依赖 watcher 时序也应该立即切换。
  const channelsTab = tabButton(harness.lastTree, '渠道')
  assert.ok(channelsTab, '应渲染出「渠道」tab')
  channelsTab.props.onClick()
  await harness.rerender()
  assert.equal(
    findAll(harness.lastTree, (node) => node.props?.['data-scout-tab'] === 'channels').length,
    1,
    '点击后 panel 应切到 channels',
  )
  assert.equal(tabButton(harness.lastTree, '渠道').props['data-active'], 'true')

  // 再故意渲染 30 次（模拟宿主继续重渲染），effect 不应再发命令。
  for (let i = 0; i < 30; i++) await harness.rerender()
  assert.equal(configLoads().length, 1, '重复渲染不得再次加载')

  // 模拟宿主卸载/重挂载 section：模块级闸门 + 缓存应让新实例直接回填。
  harness.dispose()
  const remounted = createHarness(scene.ctx.registered.component, {
    useSessions(selector) {
      return selector({ byId: { s1: { retainedBy: { mainView: 1 } } } })
    },
  })
  activeReact = remounted.React
  await remounted.settle()
  assert.equal(configLoads().length, 1, '重挂载不得再次加载')
  remounted.dispose()
})
