// /scout-cred-status 判定：v8 起 snippet 只做迁移提示，不再参与 effective。
import assert from 'node:assert/strict'
import test from 'node:test'
import { credentialStatus, resolveCredentialsFromSettings, CREDENTIAL_ENV } from '../lib/cred_status.js'

test('三个字段映射齐全', () => {
  assert.deepEqual(Object.keys(CREDENTIAL_ENV).sort(), ['biliSessdata', 'deepseekApiKey', 'githubToken'])
})

test('settings source：设置页非空，snippet 没有', () => {
  const fields = credentialStatus(
    { githubToken: '  ghp_test  ', deepseekApiKey: '', biliSessdata: '   ' },
    {},
  )
  assert.deepEqual(fields.githubToken, { settings: true, snippet: false, effective: true, source: 'settings' })
  assert.equal(fields.deepseekApiKey.effective, false)
  assert.equal(fields.deepseekApiKey.source, 'none')
  assert.equal(fields.biliSessdata.effective, false, 'trim 后为空视为未配置')
})

test('snippet 只有旧值：不参与 effective，仅标记 snippet', () => {
  const fields = credentialStatus(
    { githubToken: '', deepseekApiKey: undefined, biliSessdata: ' ' },
    { GITHUB_TOKEN: 'ghp_snippet', DEEPSEEK_API_KEY: '  ', BILI_SESSDATA: 'sess' },
  )
  assert.deepEqual(fields.githubToken, { settings: false, snippet: true, effective: false, source: 'none' })
  assert.equal(fields.deepseekApiKey.source, 'none')
  assert.deepEqual(fields.biliSessdata, { settings: false, snippet: true, effective: false, source: 'none' })
})

test('both：设置页生效，snippet 仍标记为旧值', () => {
  const fields = credentialStatus(
    { githubToken: 'ghp_settings', deepseekApiKey: 'sk_settings' },
    { GITHUB_TOKEN: 'ghp_snippet', DEEPSEEK_API_KEY: 'sk_snippet' },
  )
  assert.deepEqual(fields.githubToken, { settings: true, snippet: true, effective: true, source: 'settings' })
  assert.deepEqual(fields.deepseekApiKey, { settings: true, snippet: true, effective: true, source: 'settings' })
})

test('none：两边都没有/都为空', () => {
  const fields = credentialStatus({ githubToken: '', deepseekApiKey: '   ', biliSessdata: undefined }, { GITHUB_TOKEN: '', DEEPSEEK_API_KEY: ' ', BILI_SESSDATA: undefined })
  for (const field of Object.values(fields)) {
    assert.deepEqual(field, { settings: false, snippet: false, effective: false, source: 'none' })
  }
})

test('非字符串值不误判为已配置', () => {
  const fields = credentialStatus({ githubToken: 123, deepseekApiKey: null, biliSessdata: {} }, { GITHUB_TOKEN: 456, DEEPSEEK_API_KEY: [], BILI_SESSDATA: {} })
  for (const field of Object.values(fields)) assert.equal(field.effective, false)
})

test('resolveCredentials 新语义：只读设置页，缺省为空串', () => {
  assert.deepEqual(resolveCredentialsFromSettings({}), {
    DEEPSEEK_API_KEY: '', GITHUB_TOKEN: '', BILI_SESSDATA: '',
  })
  assert.deepEqual(resolveCredentialsFromSettings({ githubToken: '  ghp_x  ', deepseekApiKey: 'sk_y' }), {
    DEEPSEEK_API_KEY: 'sk_y', GITHUB_TOKEN: 'ghp_x', BILI_SESSDATA: '',
  })
})

test('resolveCredentials 不接受 snippet 参数：snippet-only 时仍为空（设置页唯一来源）', () => {
  // 旧实现这里会从第二参数/磁盘 snippet 取到 ghp_snippet；新函数签名只有 credentials。
  const opts = { GITHUB_TOKEN: 'ghp_snippet', DEEPSEEK_API_KEY: 'sk_snippet' }
  assert.deepEqual(resolveCredentialsFromSettings({}, opts), {
    DEEPSEEK_API_KEY: '', GITHUB_TOKEN: '', BILI_SESSDATA: '',
  })
})
