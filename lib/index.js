/**
 * dsh-plugin-scout · 宿主侧
 *
 * 职责：
 *  1. 注册 scout_run_daily / scout_last_run / scout_test_channel 三个工具；
 *  2. 从插件 Config（设置页可改）读取日报根目录、解释器、渠道、采集源、定时；
 *  3. 内置一个每天 19:00 的宿主定时器（不依赖会话，也不需要 schedule 服务）；
 *  4. 所有真正跑日报/发消息的活交给 lib/bridge.py，密钥只经环境变量传递。
 *
 * 安全约定：本文件不打印、不返回任何 token / webhook；错误信息只给"缺什么"。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { credentialStatus, resolveCredentialsFromSettings, CREDENTIAL_ENV } from './cred_status.js'
import { runDailyWithMidnightRetry, retryMetadata, staleDateMessage } from './retry.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRIDGE = join(HERE, 'bridge.py')
const DEFAULT_ROOT = ''
const DEFAULT_TZ = 'Asia/Shanghai'
const RUN_TIMEOUT_MS = 8 * 60 * 1000

/** 单个分发渠道。 */
const Channel = z.object({
  name: z.string().default('飞书'),
  type: z.string().default('feishu'),
  url: z.string().default(''),
  enabled: z.boolean().default(true),
  keyword: z.string().default('情报'),
  secret: z.string().default(''),
  headers: z.string().default(''),
  limit: z.number().step(1).min(1).default(20),
})

/** 与 scout 无关的 UI 状态：冷却时间、上次摘要、是否演练。 */
const Ui = z.object({
  lastRunAt: z.string().default(''),
  lastSummary: z.string().default(''),
  dryRun: z.boolean().default(false),
})

/** 定时（宿主进程内定时，DSH 在线才触发）。 */
const Schedule = z.object({
  enabled: z.boolean().default(true),
  time: z.string().default('19:00'),
  timeZone: z.string().default(DEFAULT_TZ),
  force: z.boolean().default(false),
})

/** 凭据与可选 ECS 同步。secret 角色由 DSH 设置服务负责掩码。 */
const Credentials = z.object({
  // 不给 secret 字段设 default('')：否则 unset 会被 host 用默认空串补回，
  // profile patch 里会残留 `githubToken: ""`。缺省即 undefined，清空才是真删。
  githubToken: z.string().role('secret'),
  deepseekApiKey: z.string().role('secret'),
  biliSessdata: z.string().role('secret'),
  ecsEnabled: z.boolean().default(false),
  ecsHost: z.string().default(''),
  ecsUser: z.string().default(''),
  ecsKeyPath: z.string().default(''),
})

export const Config = z.object({
  root: z.string().default(DEFAULT_ROOT).volatile(),
  python: z.string().default('').volatile(),
  snippet: z.string().default('').volatile(),
  channels: z.array(Channel).default([]).volatile(),
  schedule: Schedule.default({}).volatile(),
  credentials: Credentials.default({}).volatile(),
  ui: Ui.default({}).volatile(),
})

export const name = 'scout'
export const inject = ['tools']

/** 读一个 Config 字段的当前值（schemastery 的 volatile 字段是 ref）。 */
function read(config, key, fallback) {
  try {
    const field = config?.[key]
    const value = field && typeof field.get === 'function' ? field.get() : field
    return value === undefined ? fallback : value
  } catch {
    return fallback
  }
}

/** 解析解释器路径。 */
function pythonOf(config) {
  const root = read(config, 'root', DEFAULT_ROOT)
  const custom = String(read(config, 'python', '') || '').trim()
  return custom || join(root, '.venv', 'Scripts', 'python.exe')
}

/** 解析 snippet 路径。 */
function snippetOf(config) {
  const root = read(config, 'root', DEFAULT_ROOT)
  const custom = String(read(config, 'snippet', '') || '').trim()
  return custom || join(root, 'config-dsh.snippet.json')
}

/** 从 snippet 读凭据；不存在时返回 {}，绝不把内容写进错误。 */
function credentialsFromSnippet(snippetPath) {
  if (!existsSync(snippetPath)) return {}
  try {
    const doc = JSON.parse(readFileSync(snippetPath, 'utf8'))
    const env = doc?.mcpServers?.scout?.env
    return env && typeof env === 'object' ? env : {}
  } catch {
    return {}
  }
}

/**
 * v8：设置页是凭据的唯一来源。snippet 不再兜底，只用于设置页的迁移提示/导入。
 */
function resolveCredentials(config) {
  return resolveCredentialsFromSettings(read(config, 'credentials', {}) || {})
}

/** 把渠道配置整理成 bridge 能消费的 JSON（不含任何打印）。只认设置页 channels。 */
function channelsOf(config) {
  const list = read(config, 'channels', []) || []
  const out = []
  for (const item of list) {
    if (!item || item.enabled === false) continue
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (!url) continue
    out.push({
      name: String(item.name || '未命名渠道'),
      type: item.type === 'webhook' ? 'webhook' : 'feishu',
      url,
      keyword: String(item.keyword || '情报'),
      secret: String(item.secret || ''),
      headers: String(item.headers || ''),
      limit: Number(item.limit || 20),
    })
  }
  return out
}

/** 跑 bridge，返回它最后一行 JSON。stdout/stderr 都不外泄。 */
function runBridge(config, args, env, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const python = pythonOf(config)
    const root = read(config, 'root', DEFAULT_ROOT)
    if (!existsSync(python)) {
      resolve({ ok: false, error: `找不到 Python 解释器：${python}。请在设置页改「解释器路径」，或先给 scout 建好 .venv。` })
      return
    }
    if (!existsSync(BRIDGE)) {
      resolve({ ok: false, error: `插件文件缺失：${BRIDGE}` })
      return
    }
    execFile(python, [BRIDGE, ...args], {
      cwd: existsSync(root) ? root : undefined,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...env },
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim()
      const lines = text.split(/\r?\n/).filter(Boolean)
      let parsed
      for (let i = lines.length - 1; i >= 0; i--) {
        try { parsed = JSON.parse(lines[i]); break } catch { /* 继续找 */ }
      }
      if (parsed) {
        resolve(parsed)
        return
      }
      if (error?.killed) {
        resolve({ ok: false, error: '运行超时（8 分钟）。' })
        return
      }
      const hint = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
      resolve({ ok: false, error: `日报脚本没有返回结果${hint ? '：' + hint.slice(0, 300) : ''}` })
    })
  })
}

/** 给工具结果统一整形：失败时只留 ok/error/state。 */
function failureOf(result, date) {
  return {
    ok: false,
    state: result?.state || 'failed',
    date: date || result?.date || todayIn(DEFAULT_TZ),
    collected: result?.collected || 'unknown',
    notify: { sent: 0, failed: 0, dry_run: Boolean(result?.dry_run), channels: [] },
    report_path: result?.report_path || '',
    elapsed_seconds: result?.elapsed_seconds ?? 0,
    error: String(result?.error || '未知错误').slice(0, 500),
  }
}

function todayIn(timeZone, at = Date.now()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
  } catch {
    return new Date(at).toISOString().slice(0, 10)
  }
}

/** 最近一期运行摘要（读 scout/data/runs/*.json，不碰网络）。 */
function lastRunSummary(config) {
  const root = read(config, 'root', DEFAULT_ROOT)
  const runsDir = join(root, 'data', 'runs')
  if (!existsSync(runsDir)) {
    return { ok: false, error: `找不到 runs 目录：${runsDir}` }
  }
  const files = readdirSync(runsDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
  if (files.length === 0) return { ok: false, error: '还没有任何运行记录' }
  const file = files[files.length - 1]
  let doc
  try {
    doc = JSON.parse(readFileSync(join(runsDir, file), 'utf8'))
  } catch {
    return { ok: false, error: `最近一期记录读不出来：${file}` }
  }
  const notify = doc.notify || {}
  const report = doc.report || {}
  const totals = doc.totals || {}
  const date = String(doc.date || file.slice(0, 10))
  return {
    ok: true,
    date,
    state: doc.state || 'unknown',
    collected: doc.collect_state || 'unknown',
    items: Number(report.items ?? totals.kept ?? 0),
    sent: Number(notify.sent ?? 0),
    failed: Number(notify.failed ?? 0),
    dry_run: Boolean(notify.dry_run),
    channels: Array.isArray(doc.channels) ? doc.channels : [],
    report_path: report.path || join(root, 'data', 'out', `${date}.md`),
    elapsed_seconds: doc.elapsed_seconds ?? null,
    finished_at: report.written_at || doc.finished_at || null,
  }
}

// ---------------------------------------------------------------------------
// 定时：宿主进程内每天 HH:MM（指定 IANA 时区）跑一次。
// ---------------------------------------------------------------------------
function tzOffsetMs(timeZone, at) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = Object.fromEntries(dtf.formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
  return asUTC - at
}

const CATCH_UP_GRACE_MS = 120 * 1000
const CATCH_UP_DELAY_MS = 5 * 1000
const TIME_FORMAT_ERROR = '定时时间格式不合法'

/** 解析 HH:mm；非法返回 null（不再静默夹到 23:59）。 */
function parseHhmm(hhmm) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

/** 指定时区里“今天 HH:MM”的 UTC 时间戳（可能 <= now）；非法输入返回 NaN。 */
function dailyAt(hhmm, timeZone, now) {
  const parsed = parseHhmm(hhmm)
  if (!parsed) return NaN
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
  const today = Object.fromEntries(dtf.formatToParts(new Date(now)).map((p) => [p.type, p.value]))
  const guess = Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), parsed.hour, parsed.minute, 0)
  let target = guess - tzOffsetMs(timeZone, guess)
  // 用 target 再校一次偏移：跨 DST 边界时不会偏一小时。
  target = guess - tzOffsetMs(timeZone, target)
  return target
}

/**
 * 下一次 HH:MM 的 UTC 时间戳（严格晚于 now）。
 * 非法输入：回退 now+24h，并通过 onError 记一条 timerRuntime.lastError。
 */
function nextDailyAt(hhmm, timeZone, now, onError) {
  if (!parseHhmm(hhmm)) {
    const message = `${TIME_FORMAT_ERROR}：${JSON.stringify(String(hhmm ?? ''))}（应为 HH:mm）`
    if (typeof onError === 'function') onError(message)
    return now + 24 * 3600 * 1000
  }
  let target = dailyAt(hhmm, timeZone, now)
  if (target > now) return target
  target = dailyAt(hhmm, timeZone, target + 24 * 3600 * 1000)
  if (Number.isFinite(target) && target > now) return target
  return now + 24 * 3600 * 1000
}

/**
 * 本次挂表计划（纯函数，便于测试）。
 * catchUp=true 表示“刚过点，补跑今天”，而不是把今天整天跳过去排到明天。
 */
function planArm({ time, timeZone, now, lastFireKey = '', onError }) {
  const raw = String(time ?? '')
  const todayKey = `${todayIn(timeZone, now)}|${raw}`
  const todayTarget = dailyAt(raw, timeZone, now)
  const missedBy = Number.isFinite(todayTarget) ? now - todayTarget : NaN
  if (missedBy > 0 && missedBy <= CATCH_UP_GRACE_MS && lastFireKey !== todayKey) {
    const target = now + CATCH_UP_DELAY_MS
    return { target, catchUp: true, fireKey: `${todayIn(timeZone, target)}|${raw}` }
  }
  const target = nextDailyAt(raw, timeZone, now, onError)
  return { target, catchUp: false, fireKey: `${todayIn(timeZone, target)}|${raw}` }
}

// 纯函数暴露给 test/timer-plan.test.mjs；宿主不需要，也不影响插件加载。
export const __test = { nextDailyAt, planArm, dailyAt, CATCH_UP_GRACE_MS }


function envForRun(config, creds) {
  return {
    ...creds,
    SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT),
    SCOUT_CHANNELS: JSON.stringify(channelsOf(config)),
  }
}

export function apply(ctx, config) {
  // 定时器自身的运行快照：设置页的「定时」面板只认这个，而不是自己猜配置形状。
  // 谁最清楚“到点会不会跑”？只有真的挂着 setTimeout 的那段代码。
  const timerRuntime = {
    enabled: false,
    time: '',
    timeZone: DEFAULT_TZ,
    nextFireAt: '',
    checkedAt: '',
    arms: 0,
    lastError: '',
  }

  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: 'scout_run_daily',
      description: '跑一轮 scout 技术情报日报（采集 GitHub/B站等 → DeepSeek 写日报 → 落盘 → 发到配置的渠道）。默认真发；dry_run=true 只走到发送前。',
      parameters: {
        dry_run: { type: 'boolean', description: '不真发、不 scp（默认 false）' },
        force: { type: 'boolean', description: '跳过峰时闸门，手动补跑用（默认 false）' },
        date: { type: 'string', description: '补跑日期 YYYY-MM-DD，默认今天' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const scheduleTz = read(config, 'schedule', {})?.timeZone || DEFAULT_TZ
        const date = String(args?.date || '').trim() || todayIn(scheduleTz)
        const flags = { force: Boolean(args?.force), dry_run: Boolean(args?.dry_run) }
        const creds = resolveCredentials(config)
        const startedAt = Date.now()
        const run = ({ date: runDate, force, dry_run }) => runBridge(config, [
          '--run', '--date', runDate,
          ...(dry_run ? ['--dry-run'] : []),
          ...(force ? ['--force'] : []),
        ], envForRun(config, creds))
        // 跨零点：写入守卫拒收 stale_date 时，用今天（Asia/Shanghai）只重跑一次。
        const outcome = await runDailyWithMidnightRetry({ run, date, flags, today: () => todayIn(DEFAULT_TZ) })
        const result = outcome.result
        if (!result.ok) {
          const firstMessage = outcome.firstResult?.error === 'stale_date'
            ? staleDateMessage(outcome.firstResult.date)
            : String(outcome.firstResult?.error || '未知错误')
          const baseError = result.error === 'stale_date'
            ? staleDateMessage(result.date || outcome.retryDate || date)
            : String(result.error || '未知错误')
          const error = outcome.retried
            ? `${baseError}（跨零点自动重试亦失败；首次：${firstMessage} @ ${outcome.originalDate || '未知'}）`
            : baseError
          const failure = failureOf({ ...result, error, dry_run: flags.dry_run }, outcome.retryDate || date)
          Object.assign(failure, retryMetadata(outcome))
          return failure
        }
        return {
          ok: true,
          state: result.state || 'ok',
          date: result.date || outcome.retryDate || date,
          collected: result.collected || 'unknown',
          notify: {
            sent: Number(result.notify?.sent ?? 0),
            failed: Number(result.notify?.failed ?? 0),
            dry_run: Boolean(result.notify?.dry_run ?? flags.dry_run),
            channels: Array.isArray(result.notify?.channels) ? result.notify.channels : [],
          },
          report_path: result.report_path || '',
          elapsed_seconds: Number(result.elapsed_seconds ?? Math.round((Date.now() - startedAt) / 1000)),
          ...retryMetadata(outcome),
        }
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'scout_last_run',
      description: '返回最近一期 scout 日报的运行摘要：日期、state、收录条数、是否真发、渠道、报告路径、耗时。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute() {
        return lastRunSummary(config)
      },
    }))

    toolsCtx.tools.register(defineTool({
      name: 'scout_test_channel',
      description: '给指定渠道发一条带【测试】字样的连通性消息（缺省发给全部已启用渠道），返回各渠道成败与 HTTP 码。',
      parameters: {
        name: { type: 'string', description: '渠道名；不填则测试全部' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
      async execute(args) {
        const creds = resolveCredentials(config)
        const env = { ...creds, SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT), SCOUT_CHANNELS: JSON.stringify(channelsOf(config)) }
        const result = await runBridge(config, ['--test', ...(args?.name ? ['--name', String(args.name)] : [])], env, 60 * 1000)
        if (!result.ok && !Array.isArray(result.channels)) {
          return { ok: false, error: String(result.error || '测试失败'), channels: [] }
        }
        return {
          ok: Boolean(result.ok),
          channels: Array.isArray(result.channels) ? result.channels : [],
          ...(result.error ? { error: String(result.error) } : {}),
        }
      },
    }))
  })

  // 页面上的「测试 / 校验」按钮通过全局会话命令打到宿主（客户端不另开 RPC 通道）。
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'scout-test',
      description: '给指定渠道发一条【测试】消息',
      input: { hint: '<渠道名，可空>' },
      handler: async ({ rawInput }) => {
        const creds = resolveCredentials(config)
        const env = { ...creds, SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT), SCOUT_CHANNELS: JSON.stringify(channelsOf(config)) }
        const name = String(rawInput || '').trim()
        const result = await runBridge(config, ['--test', ...(name ? ['--name', name] : [])], env, 60 * 1000)
        const text = JSON.stringify({ ok: Boolean(result.ok), channels: result.channels || [], ...(result.error ? { error: result.error } : {}) })
        return { kind: result.ok ? 'success' : 'error', text }
      },
    })
    commandCtx.commands.register({
      name: 'scout-check',
      description: '校验 GitHub / DeepSeek / B站 / ECS 凭据',
      input: { hint: 'github | deepseek | bili | ecs' },
      handler: async ({ rawInput }) => {
        const field = String(rawInput || '').trim()
        if (!['github', 'deepseek', 'bili', 'ecs'].includes(field)) {
          return { kind: 'error', text: '用法：/scout-check github|deepseek|bili|ecs' }
        }
        const creds = resolveCredentials(config)
        const ecs = read(config, 'credentials', {}) || {}
        const result = await runBridge(config, ['--check', field], {
          ...creds,
          SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT),
          SCOUT_ECS: JSON.stringify({ host: ecs.ecsHost || '', user: ecs.ecsUser || '', keyPath: ecs.ecsKeyPath || '' }),
        }, 60 * 1000)
        return { kind: result.ok ? 'success' : 'error', text: String(result.detail || result.error || (result.ok ? '校验通过' : '校验失败')) }
      },
    })

    // 设置页凭据判定：v8 起 effective 只看设置页；snippet 仅作为迁移提示。
    commandCtx.commands.register({
      name: 'scout-cred-status',
      description: '返回每个凭据字段的设置页状态与 snippet 旧值提示',
      input: { hint: '（无参数）' },
      handler: async () => {
        const snippet = credentialsFromSnippet(snippetOf(config))
        const fields = credentialStatus(read(config, 'credentials', {}) || {}, snippet)
        // 飞书 Webhook 的有效来源只认 channels；snippet.FEISHU_WEBHOOK 仅提示旧值。
        const settingsFeishu = channelsOf(config).length > 0
        const snippetFeishu = typeof snippet.FEISHU_WEBHOOK === 'string' && snippet.FEISHU_WEBHOOK.trim().length > 0
        fields.feishuWebhook = {
          settings: settingsFeishu,
          snippet: snippetFeishu,
          effective: settingsFeishu,
          source: settingsFeishu ? 'settings' : 'none',
        }
        return { kind: 'success', text: JSON.stringify({ ok: true, fields }) }
      },
    })

    // 迁移用：把 snippet 里的旧凭据值交给设置页填入输入框（只读 snippet，不写不删）。
    commandCtx.commands.register({
      name: 'scout-cred-import',
      description: '读取 snippet 里的旧凭据，供设置页导入（不修改 snippet）',
      input: { hint: '（无参数）' },
      handler: async () => {
        const snippet = credentialsFromSnippet(snippetOf(config))
        const fields = {}
        for (const [field, envName] of Object.entries(CREDENTIAL_ENV)) {
          const value = typeof snippet[envName] === 'string' ? snippet[envName].trim() : ''
          if (value) fields[field] = value
        }
        const feishu = typeof snippet.FEISHU_WEBHOOK === 'string' ? snippet.FEISHU_WEBHOOK.trim() : ''
        if (feishu) fields.feishuWebhook = feishu
        return { kind: 'success', text: JSON.stringify({ ok: true, fields, snippetPath: snippetOf(config) }) }
      },
    })

    // 设置页「显示」按钮：回显设置页保存的凭据明文（仅限本机 GUI；snippet 来源不回显）。
    commandCtx.commands.register({
      name: 'scout-secret-reveal',
      description: '返回设置页保存的某个凭据明文（githubToken | deepseekApiKey | biliSessdata）',
      input: { hint: 'githubToken | deepseekApiKey | biliSessdata' },
      handler: async ({ rawInput }) => {
        const field = String(rawInput || '').trim()
        const allowed = ['githubToken', 'deepseekApiKey', 'biliSessdata']
        if (!allowed.includes(field)) {
          return { kind: 'error', text: '用法：/scout-secret-reveal githubToken|deepseekApiKey|biliSessdata' }
        }
        const creds = read(config, 'credentials', {}) || {}
        // 不回显 snippet；设置页保存的值原样返回（不 trim，避免与刚保存的内容不一致）。
        const value = typeof creds[field] === 'string' ? creds[field] : ''
        if (!value) {
          return { kind: 'error', text: '该凭据未在设置页配置；snippet 旧值不会再被使用，也不回显' }
        }
        return { kind: 'success', text: JSON.stringify({ ok: true, field, value }) }
      },
    })

    // 设置页读写 scout/config.yaml：走会话命令，宿主侧用行级编辑器落地。
    commandCtx.commands.register({
      name: 'scout-config-load',
      description: '读取 scout/config.yaml 的白名单字段与 sha256',
      input: { hint: '（无参数）' },
      handler: async () => {
        const result = await runBridge(config, ['--config-load'], { SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT) }, 30 * 1000)
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) }
      },
    })
    commandCtx.commands.register({
      name: 'scout-config-save',
      description: '把白名单字段写回 scout/config.yaml（行级编辑 + 备份 + 回滚）',
      input: { hint: '<JSON>' },
      handler: async ({ rawInput }) => {
        const payload = String(rawInput || '').trim()
        if (!payload.startsWith('{')) {
          return { kind: 'error', text: '用法：/scout-config-save {"expectedSha256":"…","set":{…}}' }
        }
        const file = join(tmpdir(), `scout-cfg-${process.pid}-${Date.now()}.json`)
        try {
          writeFileSync(file, payload, 'utf8')
          const result = await runBridge(config, ['--config-save', file], { SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT) }, 30 * 1000)
          return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) }
        } finally {
          try { unlinkSync(file) } catch { /* 临时文件清理失败无妨 */ }
        }
      },
    })
    commandCtx.commands.register({
      name: 'scout-run',
      description: '立即跑一轮日报（等价 scout_run_daily(force=true)）；rawInput 含 dry 表示演练',
      input: { hint: 'dry（可选）' },
      handler: async ({ rawInput }) => {
        const dry = /(^|\s)dry(\s|$)/i.test(String(rawInput || ''))
        const date = todayIn(DEFAULT_TZ)
        const flags = { force: true, dry_run: dry }
        const creds = resolveCredentials(config)
        const started = Date.now()
        const run = ({ date: runDate, force, dry_run }) => runBridge(config, [
          '--run', '--date', runDate,
          ...(dry_run ? ['--dry-run'] : []),
          ...(force ? ['--force'] : []),
        ], envForRun(config, creds))
        const outcome = await runDailyWithMidnightRetry({ run, date, flags, today: () => todayIn(DEFAULT_TZ) })
        const result = outcome.result
        const firstMessage = outcome.firstResult?.error === 'stale_date'
          ? staleDateMessage(outcome.firstResult.date)
          : String(outcome.firstResult?.error || '未知错误')
        const baseError = result.error === 'stale_date'
          ? staleDateMessage(result.date || outcome.retryDate || date)
          : String(result.error || '未知错误')
        const payload = {
          ...result,
          ...(result.ok ? {} : {
            error: outcome.retried
              ? `${baseError}（跨零点自动重试亦失败；首次：${firstMessage} @ ${outcome.originalDate || '未知'}）`
              : baseError,
          }),
          elapsed_seconds: result.elapsed_seconds ?? Math.round((Date.now() - started) / 1000),
          ...retryMetadata(outcome),
        }
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(payload) }
      },
    })
    // 设置页「定时」面板的唯一可信来源：定时器自己报告它到底挂上了没有。
    // 不能靠 describe 的 value 猜——那是另一条链路，滞后或缺失都会让页面误判。
    commandCtx.commands.register({
      name: 'scout-schedule-status',
      description: '返回宿主定时器的真实状态（是否挂上、时间、时区、下次触发）',
      input: { hint: '（无参数）' },
      handler: async () => {
        let schedule = {}
        let readError = ''
        try {
          schedule = read(config, 'schedule', {}) || {}
        } catch (err) {
          readError = err?.message || String(err)
        }
        const payload = {
          ok: true,
          enabled: timerRuntime.enabled === true,
          time: String(timerRuntime.time || schedule.time || '19:00'),
          timeZone: String(timerRuntime.timeZone || schedule.timeZone || DEFAULT_TZ),
          force: schedule.force === true,
          nextFireAt: timerRuntime.nextFireAt || '',
          checkedAt: timerRuntime.checkedAt || '',
          arms: timerRuntime.arms,
          lastError: timerRuntime.lastError || readError || '',
        }
        return { kind: 'success', text: JSON.stringify(payload) }
      },
    })
    commandCtx.commands.register({
      name: 'scout-log',
      description: '查看 scout/logs/daily.log 末尾',
      input: { hint: '行数（默认 20）' },
      handler: async ({ rawInput }) => {
        const limit = Number(String(rawInput || '').trim()) || 20
        const result = await runBridge(config, ['--log-tail', String(limit)], { SCOUT_ROOT: read(config, 'root', DEFAULT_ROOT) }, 15 * 1000)
        return { kind: result.ok ? 'success' : 'error', text: JSON.stringify(result) }
      },
    })
  })

  // 宿主定时：每天到点直接跑，不依赖 schedule 服务、也不绑定任何会话。
  // 每分钟复查一次配置：既能吃掉“保存后一分钟内生效”，也能在时间被改掉时重新挂表
  // （老实现只要 enabled 就一直挂着到明天的长定时，改了时间也只能等它先烧完）。
  ctx.effect(() => {
    let fire = null
    let poll = null
    let disposed = false
    let armedKey = ''
    let armedTarget = 0
    // 当天去重键（yyyy-mm-dd|HH:mm）：刚过点的补跑只允许一次，避免每分钟重复补。
    let lastFireKey = ''
    let lastConfigError = ''

    const publish = (enabled, time, timeZone) => {
      timerRuntime.enabled = enabled
      timerRuntime.time = time
      timerRuntime.timeZone = timeZone
      timerRuntime.nextFireAt = enabled && armedTarget ? new Date(armedTarget).toISOString() : ''
      timerRuntime.checkedAt = new Date().toISOString()
      timerRuntime.arms += 1
    }

    const scheduleFire = (plan, timeZone) => {
      if (fire) clearTimeout(fire)
      fire = null
      armedTarget = plan.target
      const fireKey = plan.fireKey
      const delay = Math.max(5 * 1000, Math.min(plan.target - Date.now(), 24 * 3600 * 1000))
      fire = setTimeout(async () => {
        fire = null
        armedKey = ''
        // 触发（含补跑）后立即按“当天 + HH:mm”打标记，poll 不会在同一分钟内再补一次。
        lastFireKey = fireKey
        try {
          const creds = resolveCredentials(config)
          const date = todayIn(timeZone)
          await runBridge(config, [
            '--run', '--date', date,
            ...(read(config, 'schedule', {})?.force ? ['--force'] : []),
          ], envForRun(config, creds))
        } catch (err) {
          timerRuntime.lastError = err?.message || String(err)
        } finally {
          arm()
        }
      }, delay)
      fire.unref?.()
    }

    const arm = () => {
      if (disposed) return
      // 单一复查链：每次重排前先把上一只表撤掉，否则一分钟一根、越挂越多。
      if (poll) {
        clearTimeout(poll)
        poll = null
      }
      let schedule = {}
      let readError = ''
      try {
        schedule = read(config, 'schedule', {}) || {}
      } catch (err) {
        readError = err?.message || String(err)
      }
      const enabled = schedule.enabled === true
      // 用 ?? 而不是 ||：0 / 696 这类 YAML 裸标量必须原样进入校验，不能被悄悄换成 19:00。
      const time = String(schedule.time ?? '19:00')
      const timeZone = String(schedule.timeZone || DEFAULT_TZ)
      const key = `${enabled}|${time}|${timeZone}`
      let formatError = ''
      const plan = enabled
        ? planArm({ time, timeZone, now: Date.now(), lastFireKey, onError: (msg) => { formatError = msg } })
        : { target: 0, catchUp: false, fireKey: '' }
      const configError = readError || formatError
      if (configError) {
        lastConfigError = configError
        timerRuntime.lastError = configError
      } else if (lastConfigError) {
        // 配置修好后清掉旧错误，但别误清运行期的 lastError。
        const previous = lastConfigError
        lastConfigError = ''
        if (timerRuntime.lastError === previous) timerRuntime.lastError = ''
      }

      if (enabled && (key !== armedKey || plan.catchUp)) {
        if (key !== armedKey) {
          if (fire) clearTimeout(fire)
          fire = null
          armedKey = key
          armedTarget = 0
        }
        scheduleFire(plan, timeZone)
      } else if (!enabled && key !== armedKey) {
        if (fire) clearTimeout(fire)
        fire = null
        armedKey = key
        armedTarget = 0
      }

      publish(enabled, time, timeZone)
      poll = setTimeout(arm, 60 * 1000)
      poll.unref?.()
    }

    arm()
    return () => {
      disposed = true
      if (fire) clearTimeout(fire)
      if (poll) clearTimeout(poll)
    }
  }, 'scout: daily timer')
}
