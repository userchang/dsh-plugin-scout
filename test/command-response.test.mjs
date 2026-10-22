// 命令返回形状单测：DSH 真实形状是 {ok,value:{commandId,result:{kind,text}}}。
import assert from 'node:assert'
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
const { parseCommandResponse } = plugin.__test

test('真实 commands.execute 形状：success + JSON text 被解析', () => {
  const response = {
    ok: true,
    value: { commandId: 'cmd-1', result: { kind: 'success', text: '{"ok":true,"value":"ghtoken"}' } },
  }
  assert.deepEqual(parseCommandResponse(response), { ok: true, value: 'ghtoken' })
})

test('真实 commands.execute 形状：error + JSON text 也解析，保留 conflict 等字段', () => {
  const response = {
    ok: true,
    value: { commandId: 'cmd-2', result: { kind: 'error', text: '{"ok":false,"conflict":true,"error":"changed"}' } },
  }
  assert.deepEqual(parseCommandResponse(response), { ok: false, conflict: true, error: 'changed' })
})

test('error + 纯文本：转成 ok:false/error', () => {
  const response = { ok: true, value: { result: { kind: 'error', text: '该凭据未在设置页配置' } } }
  assert.deepEqual(parseCommandResponse(response), { ok: false, error: '该凭据未在设置页配置' })
})

test('兼容测试 mock 的 {value:{text}} 形状', () => {
  const response = { ok: true, value: { text: '{"ok":true,"values":{"report":{"max_items":9}}}' } }
  assert.deepEqual(parseCommandResponse(response), { ok: true, values: { report: { max_items: 9 } } })
})

test('命令未注册（value undefined）不再伪装成成功', () => {
  assert.deepEqual(parseCommandResponse({ ok: true, value: undefined }), { ok: false, error: '命令未注册或没有返回结果' })
})

test('平台错误转成 ok:false', () => {
  assert.deepEqual(parseCommandResponse({ ok: false, error: { message: 'boom' } }), { ok: false, error: 'boom' })
})
