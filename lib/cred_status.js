/**
 * 凭据有效判定（纯函数，无 DSH 依赖，便于单测）。
 *
 * v8 起设置页是唯一来源：
 *   settings 非空（trim 后） → effective=true，source='settings'；
 *   snippet 只作为“旧值迁移提示”，不参与 effective。
 */

/** 凭据字段 → snippet 环境变量名（仅用于迁移提示/导入）。 */
export const CREDENTIAL_ENV = Object.freeze({
  githubToken: 'GITHUB_TOKEN',
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  biliSessdata: 'BILI_SESSDATA',
})

/**
 * v8 的 resolveCredentials 语义：只认设置页，snippet 不参与。
 * @param {object} credentials 插件设置里的 credentials 对象
 * @returns {{DEEPSEEK_API_KEY:string, GITHUB_TOKEN:string, BILI_SESSDATA:string}}
 */
export function resolveCredentialsFromSettings(credentials) {
  const creds = credentials && typeof credentials === 'object' ? credentials : {}
  const pick = (key) => (typeof creds[key] === 'string' ? creds[key].trim() : '')
  return {
    DEEPSEEK_API_KEY: pick('deepseekApiKey'),
    GITHUB_TOKEN: pick('githubToken'),
    BILI_SESSDATA: pick('biliSessdata'),
  }
}

/**
 * @param {object} credentials 插件设置里的 credentials 对象
 * @param {object} snippet snippet 的 mcpServers.scout.env 对象（只读，仅用于迁移提示）
 * @returns {Record<string, {settings:boolean, snippet:boolean, effective:boolean, source:'settings'|'none'}>}
 */
export function credentialStatus(credentials, snippet) {
  const creds = credentials && typeof credentials === 'object' ? credentials : {}
  const env = snippet && typeof snippet === 'object' ? snippet : {}
  const fields = {}
  for (const [field, envName] of Object.entries(CREDENTIAL_ENV)) {
    const raw = typeof creds[field] === 'string' ? creds[field] : ''
    const settings = raw.trim().length > 0
    const envValue = typeof env[envName] === 'string' ? env[envName] : ''
    const fromSnippet = envValue.trim().length > 0
    fields[field] = {
      settings,
      snippet: fromSnippet,
      effective: settings,
      source: settings ? 'settings' : 'none',
    }
  }
  return fields
}
