/**
 * dsh-plugin-scout · 浏览器侧（设置页）
 *
 * 注册「情报员日报」设置分区：
 *   成本与时段 / 再探再报 / 待办 / 本期重点+采集源 / 渠道 / 凭据 / 定时 / 危险区
 *
 * 两条写路径：
 *   - 与 scout 有关的字段：经 /scout-config-save 写回 scout/config.yaml（行级编辑）；
 *   - 插件自身状态（渠道/凭据/定时/冷却/上次摘要）：走 DSH settings 的 volatile 字段。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-scout',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const ENTRY = 'scout'
    const TZ = 'Asia/Shanghai'
    const COOLDOWN_SECONDS = 180
    // 两次 /scout-config-load 之间的硬间隔；即使去重/in-flight 锁被绕过也不会刷屏。
    const MIN_LOAD_INTERVAL_MS = 5000

    // ------------------------------------------------------------------
    // 加载闸门（纯闭包，便于单测）
    // ------------------------------------------------------------------
    /**
     * 同一个会话只允许加载一次；加载中跳过；失败后至少等 5s 才允许再试。
     * 实例由模块级持有，因此宿主反复重挂载 section 也不会每个实例各加载一次。
     * @param {{minIntervalMs?: number}} [options]
     */
    function createLoadGuard(options = {}) {
      const minIntervalMs = options.minIntervalMs ?? MIN_LOAD_INTERVAL_MS
      let loadedKey = null
      let inFlight = false
      let lastAttemptAt = 0
      let lastResult = null

      function plan(key, now = Date.now()) {
        if (loadedKey === key) return { allowed: false, reason: 'loaded', waitMs: 0 }
        if (inFlight) return { allowed: false, reason: 'inflight', waitMs: 0 }
        const waitMs = lastAttemptAt === 0 ? 0 : Math.max(0, minIntervalMs - (now - lastAttemptAt))
        if (waitMs > 0) return { allowed: false, reason: 'throttled', waitMs }
        return { allowed: true, reason: 'ready', waitMs: 0 }
      }

      /**
       * 占住一次加载。force 只给“用户显式重试”用：绕过已加载/节流判断，但仍尊重 in-flight。
       */
      function begin(key, now = Date.now(), force = false) {
        if (inFlight) return { allowed: false, reason: 'inflight', waitMs: 0 }
        if (!force) {
          const decision = plan(key, now)
          if (!decision.allowed) return decision
        }
        inFlight = true
        lastAttemptAt = now
        lastResult = null
        return { allowed: true, reason: force ? 'forced' : 'ready', waitMs: 0 }
      }

      function succeed(key) {
        inFlight = false
        loadedKey = key
        lastResult = 'ok'
      }

      function fail(result = 'error') {
        inFlight = false
        lastResult = result
      }

      /** 真正发出 /scout-config-load 前记一次时间，保证两条命令之间的硬间隔。 */
      function noteAttempt(now = Date.now()) {
        lastAttemptAt = now
      }

      function reset() {
        loadedKey = null
        inFlight = false
        lastAttemptAt = 0
        lastResult = null
      }

      return {
        plan,
        begin,
        succeed,
        fail,
        noteAttempt,
        reset,
        isLoaded(key) { return loadedKey === key },
        get loadedKey() { return loadedKey },
        get inFlight() { return inFlight },
        get lastAttemptAt() { return lastAttemptAt },
        get lastResult() { return lastResult },
      }
    }

    // ------------------------------------------------------------------
    // 纯函数：峰谷判断（参数注入，便于单测）
    // ------------------------------------------------------------------
    function localParts(nowMs, timeZone) {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone || TZ,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short',
      })
      const out = {}
      for (const part of dtf.formatToParts(new Date(nowMs))) out[part.type] = part.value
      return {
        year: Number(out.year),
        month: Number(out.month),
        day: Number(out.day),
        hour: Number(out.hour),
        minute: Number(out.minute),
        weekday: out.weekday,
        date: `${out.year}-${out.month}-${out.day}`,
      }
    }

    /**
     * 峰谷判断：工作日 09:00–12:00、14:00–18:00 为高峰（半开区间），其余原价。
     * @param {number} nowMs 注入的"现在"（毫秒），渲染层不得硬编码时间。
     * @param {{timeZone?:string, holidays?:string[]}} [opts]
     */
    function priceState(nowMs, opts = {}) {
      const parts = localParts(nowMs, opts.timeZone || TZ)
      const holidays = Array.isArray(opts.holidays) ? opts.holidays : []
      const base = { parts, multiplier: 1, label: '现在：空闲（原价）', peak: false }
      if (holidays.includes(parts.date)) return { ...base, reason: 'holiday' }
      if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return { ...base, reason: 'weekend' }
      const minutes = parts.hour * 60 + parts.minute
      const peak = (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
      if (!peak) return { ...base, reason: 'off-hours' }
      return { ...base, peak: true, multiplier: 2, label: '现在：高峰（×2）', reason: 'workday-peak' }
    }

    function pad2(value) { return String(value).padStart(2, '0') }

    function todayStr() {
      return localParts(Date.now(), TZ).date
    }

    function addDays(dateStr, days) {
      const base = new Date(`${dateStr || todayStr()}T00:00:00+08:00`)
      base.setDate(base.getDate() + days)
      return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`
    }

    function activeFocus(focus) {
      if (!focus || !String(focus.topic || '').trim()) return { active: false, text: '未设置' }
      const until = String(focus.until || '').trim()
      if (!until) return { active: true, text: '生效中（长期）' }
      if (until < todayStr()) return { active: false, text: `已过期（${until.slice(5)}）` }
      return { active: true, text: `生效中（至 ${until.slice(5)}）` }
    }

    const CSS = `
      .scout-section{max-width:860px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px}
      .scout-h{margin:0;font-size:18px;font-weight:600}
      .scout-p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
      .scout-tabs{display:flex;gap:18px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
      .scout-tab{background:0 0;border:0;padding:8px 1px 10px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;position:relative}
      .scout-tab[data-active=true]{color:var(--dsw-alias-label-primary)}
      .scout-tab[data-active=true]:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--dsw-alias-label-primary);border-radius:2px 2px 0 0}
      .scout-card{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-l1)}
      .scout-card h4{margin:0;font-size:13px;font-weight:600}
      .scout-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .scout-row>label{min-width:84px;color:var(--dsw-alias-label-secondary)}
      .scout-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px}
      .scout-in,.scout-sel,.scout-area{background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;font:inherit;padding:5px 8px;min-width:0;flex:1}
      .scout-sel option,.scout-sel optgroup{background:#fff;color:#1f2328}
      .scout-area{min-height:64px;resize:vertical}
      .scout-in[type=number]{max-width:110px;flex:0 0 auto}
      .scout-btn{background:var(--dsw-alias-bg-l2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:inherit;cursor:pointer;font:inherit;padding:5px 10px}
      .scout-btn:hover{border-color:var(--dsw-alias-label-tertiary)}
      .scout-btn[disabled]{opacity:.5;cursor:default}
      .scout-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}
      .scout-btn.big{padding:9px 16px;font-size:14px;font-weight:600}
      .scout-btn.danger{color:var(--dsw-alias-state-error-primary,#d33)}
      .scout-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .scout-ok{color:var(--dsw-alias-state-success-primary,#1a7f37);font-size:12px}
      .scout-err{color:var(--dsw-alias-state-error-primary,#d33);font-size:12px;white-space:pre-wrap}
      .scout-badge{display:inline-block;font-size:12px;border-radius:999px;padding:2px 10px;border:1px solid currentColor}
      .scout-badge.peak{color:var(--dsw-alias-state-error-primary,#d33)}
      .scout-badge.idle{color:var(--dsw-alias-state-success-primary,#1a7f37)}
      .scout-todo{border:1px solid var(--dsw-alias-state-warning-primary,#b58900);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-l1)}
      .scout-todo h4{margin:0;font-size:13px}
      .scout-todo a{color:var(--dsw-alias-state-business-primary);word-break:break-all}
      .scout-why{background:0 0;border:0;color:var(--dsw-alias-label-tertiary);cursor:help;font:inherit;padding:0 4px}
      .scout-mask{font-family:ui-monospace,monospace}
      .scout-table{border-collapse:collapse;width:100%;font-size:12px}
      .scout-table th,.scout-table td{border:.5px solid var(--dsw-alias-border-l2);padding:4px 8px;text-align:right}
      .scout-table th:first-child,.scout-table td:first-child{text-align:left}
      .scout-table thead th{color:var(--dsw-alias-label-tertiary);font-weight:500}
      .scout-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:scout-spin 1s linear infinite;vertical-align:-2px;margin-right:6px}
      @keyframes scout-spin{to{transform:rotate(360deg)}}
      .scout-conflict{border:1px solid var(--dsw-alias-state-warning-primary,#b58900);border-radius:6px;padding:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
      .scout-migrate{border:1px solid var(--dsw-alias-state-warning-primary,#b58900);border-radius:8px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-l1)}
      .scout-migrate .scout-row{gap:8px}
      .scout-secret{display:flex;flex-direction:column;gap:6px}
      .scout-secret-input{width:100%;flex:1 1 100%;min-width:0;box-sizing:border-box}
      .scout-secret-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      pre.scout-pre{background:var(--dsw-alias-bg-l2);border-radius:6px;padding:8px;max-height:180px;overflow:auto;font-size:11px;white-space:pre-wrap;margin:0}
    `

    // 所有按钮都显式 type=button：避免宿主把设置内容包在 form 里时，点击变成提交/关闭。
    function el(tag, props, ...children) {
      if (tag === 'button') return h(tag, { type: 'button', ...(props || {}) }, ...children)
      return h(tag, props, ...children)
    }

    // 当前 tab 放在模块级 store：宿主若因声明 epoch 变化重新注册 section，
    // 组件会被重建，组件内 state 会回到 overview；这里让选择跨重挂载保留。
    // sessionStorage 再兜一层：万一宿主重新求值了整个 client 模块（模块级变量重置），
    // 同一个页面会话里仍能读回上次点击的 tab。
    const TAB_STORAGE_KEY = 'dsh-plugin-scout.settings.tab'
    function readStoredTab() {
      try {
        const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined
        const value = storage?.getItem?.(TAB_STORAGE_KEY)
        return value || null
      } catch {
        return null
      }
    }
    let currentTab = readStoredTab() || 'overview'
    const tabWatchers = new Set()
    function readTab() { return currentTab }
    function writeTab(next) {
      currentTab = next
      try {
        const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined
        storage?.setItem?.(TAB_STORAGE_KEY, next)
      } catch { /* sessionStorage 不可用时只用模块级 store */ }
      for (const watcher of tabWatchers) {
        try { watcher(next) } catch { /* 单个订阅者异常不影响其他订阅者 */ }
      }
    }

    // 兜底 hook：槽位契约保证有 useSessions，但万一宿主没给，也不能让 hook 顺序变化。
    function useNoSessions(selector) {
      return React.useMemo(() => selector({ byId: {} }), [selector])
    }

    function mergeDraft(value) {
      const base = {
        channels: [],
        schedule: { enabled: true, time: '19:00', timeZone: TZ, force: false },
        credentials: { githubToken: '', deepseekApiKey: '', biliSessdata: '', ecsEnabled: false, ecsHost: '', ecsUser: '', ecsKeyPath: '' },
        ui: { lastRunAt: '', lastSummary: '', dryRun: false },
      }
      if (!value || typeof value !== 'object') return base
      return {
        ...base,
        ...value,
        channels: Array.isArray(value.channels) ? value.channels.map((c) => ({ ...c })) : [],
        schedule: { ...base.schedule, ...(value.schedule || {}) },
        credentials: { ...base.credentials, ...(value.credentials || {}) },
        ui: { ...base.ui, ...(value.ui || {}) },
      }
    }

    function num(value, fallback) {
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }

    /** B 站关键词：列表 → 单行输入框展示（中文逗号分隔，保留 "AI agent" 这种词内空格）。 */
    function keywordsToText(value) {
      return (Array.isArray(value) ? value : []).map((word) => String(word || '').trim()).filter(Boolean).join('，')
    }

    /** 单行输入框 → 列表；只按中/英文逗号切，空格保留在词内。 */
    function parseKeywords(text) {
      return String(text || '')
        .split(/[,，]/)
        .map((word) => word.trim())
        .filter(Boolean)
        .slice(0, 10)
    }

    function subtitleMode(value) {
      const mode = String(value || '').trim().toLowerCase()
      return ['prefer', 'require', 'off'].includes(mode) ? mode : 'prefer'
    }

    /** 数字输入兜底：非数字/负数/越界都夹到合法区间。 */
    function intIn(value, fallback, min, max) {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.trunc(n)))
    }

    /** 成本卡说明：必须跟随当前定时，不能断言用户就是 19:00。 */
    function costNote(time) {
      return `单位：元/百万 tokens。当前定时 ${time || '19:00'}；09–12 / 14–18 为高峰，跑在高峰会贵一倍。`
    }

    /**
     * 定时到底会不会跑，只看配置里**存过**的 schedule 块。
     * 面板上那个「启用 ✓ / 19:00」是前端默认值，没保存过就等于没开——宿主定时器
     * 读的是 config.schedule.enabled，缺失即 falsy，永远挂不上。
     *
     * @param {object|null|undefined} rawValue 插件条目的原始保存值（不是 mergeDraft 之后的对象）
     * @param {string} fallbackTime 面板上显示的时间，仅用于文案
     * @returns {{saved:boolean,enabled:boolean,time:string,timeZone:string}}
     */
    function scheduleState(rawValue, fallbackTime) {
      const block = rawValue && typeof rawValue === 'object' ? rawValue.schedule : undefined
      const saved = !!block && typeof block === 'object' && !Array.isArray(block)
      const enabled = saved && block.enabled === true
      return {
        saved,
        enabled,
        time: String((saved && block.time) || fallbackTime || '19:00'),
        timeZone: String((saved && block.timeZone) || TZ),
      }
    }

    /**
     * 定时状态的可信视图。
     *
     * 优先级：宿主定时器自报（/scout-schedule-status）> describe 的 value > 未知。
     * 关键点：**未知就是未知**。以前拿不到值时直接落到「未保存」，等于跟用户说假话；
     * 面板宁可显示「正在读取」，也不能凭空断言没存过。
     *
     * @param {{status?:object|null,rowValue?:object|null,rowLoaded?:boolean,fallbackTime?:string}} input
     * @returns {{known:boolean,saved:boolean,enabled:boolean,time:string,timeZone:string,source:string,nextFireAt:string}}
     */
    function resolveScheduleView(input) {
      const status = input && input.status ? input.status : null
      const fallbackTime = input && input.fallbackTime
      if (status && status.ok === true && status.verified !== false) {
        return {
          known: true,
          saved: true,
          enabled: status.enabled === true,
          time: String(status.time || fallbackTime || '19:00'),
          timeZone: String(status.timeZone || TZ),
          source: 'host',
          nextFireAt: String(status.nextFireAt || ''),
        }
      }
      const fromRow = scheduleState(input && input.rowValue, fallbackTime)
      const rowLoaded = !!(input && input.rowLoaded)
      return {
        ...fromRow,
        known: rowLoaded || fromRow.saved,
        source: fromRow.saved ? 'settings' : 'unknown',
        nextFireAt: '',
      }
    }

    /** 飞书自定义机器人的 Webhook 形态。 */
    function isFeishuBotUrl(url) {
      return /^https?:\/\/open\.feishu\.cn\/open-apis\/bot(\/|$)/i.test(String(url || '').trim())
    }

    function channelTypeMismatch(channel) {
      return !!channel && channel.type !== 'feishu' && isFeishuBotUrl(channel.url)
    }

    // ------------------------------------------------------------------
    // 组件
    // ------------------------------------------------------------------
    // 关键：remote 必须在 apply 时快照一次。Cordis 的 ctx 属性读取会把带 tracker
    // 的服务包成新的 traceable Proxy（cordis/src/utils.ts:117 getTraceable），
    // 因此每次渲染执行 `ctx.remote` 都会得到新对象；它一旦进入 useCallback
    // 依赖，effect 就会每帧重跑，把 /scout-config-load 刷屏。
    let runtimeRemote = null

    // 模块级闸门 + 会话缓存：宿主反复重挂载 section 时，不依赖组件实例。
    const loadGuard = createLoadGuard()
    const scoutLoadCache = new Map()
    function cacheKeyOf(sessionId) { return sessionId || 'nosession' }
    function readScoutCache(key) { return scoutLoadCache.get(key) || null }
    function writeScoutCache(key, patch) {
      scoutLoadCache.set(key, { ...(scoutLoadCache.get(key) || {}), ...patch })
    }
    function invalidateScoutCache(key) {
      scoutLoadCache.delete(key)
      beginScoutSeq(key) // 让任何晚到的旧响应失效
    }

    // 每次读 config.yaml 的序号（按会话）：只允许最新一次响应落地。
    const scoutLoadSeq = new Map()
    function beginScoutSeq(key) {
      const seq = (scoutLoadSeq.get(key) || 0) + 1
      scoutLoadSeq.set(key, seq)
      return seq
    }
    function isLatestScoutSeq(key, seq) {
      return (scoutLoadSeq.get(key) || 0) === seq
    }

    // 把 /scout-config-load 或 /scout-config-save 的完整结果转成三个 draft。
    // 注意：config_io.save 的返回值本身也带 values（load(root) + backup），
    // 所以保存成功后可以先用它立即回填，再强制重读 config.yaml 校验。
    function draftsFromScoutResult(result) {
      const values = result?.values || {}
      const sources = values.sources || {}
      const github = sources.github_search || {}
      const report = values.report || {}
      const limits = values.limits || {}
      const runCfg = values.run || {}
      return {
        scout: result,
        sourcesDraft: {
          githubOn: !!github.on,
          githubSinceDays: github.since_days ?? 7,
          githubStarsMin: github.stars_min ?? 50,
          biliOn: !!sources.bili?.on,
          biliSearchOn: !!sources.bili?.search?.on,
          biliSearchMaxItems: sources.bili?.search?.max_items ?? 6,
          biliSearchKeywords: Array.isArray(sources.bili?.search?.keywords) ? sources.bili.search.keywords : [],
          biliSearchKeywordsText: keywordsToText(sources.bili?.search?.keywords),
          biliSearchSubtitle: subtitleMode(sources.bili?.search?.subtitle),
          biliSearchMinPlay: sources.bili?.search?.min_play ?? 5000,
          biliSearchMaxDays: sources.bili?.search?.max_days ?? 14,
          awesomeOn: !!sources.awesome?.on,
          releasesOn: !!sources.releases?.on,
          hnOn: !!sources.hn?.on,
        },
        limitsDraft: {
          maxItems: report.max_items ?? 6,
          totalCandidates: limits.total_candidates ?? 40,
          readsMax: limits.reads_max ?? 20,
          snippetChars: limits.snippet_chars ?? 800,
          perSourceLimit: limits.per_source_limit ?? 30,
          runTime: runCfg.time ?? '19:00',
        },
        focusDraft: values.focus
          ? { ...values.focus }
          : { topic: '', until: addDays(todayStr(), 1), note: '' },
      }
    }

    function writeScoutCacheFromResult(key, result) {
      const next = draftsFromScoutResult(result)
      writeScoutCache(key, next)
      return next
    }

    /** 只有仍是该会话最新一次读取时，才允许把结果写进缓存。 */
    function commitScoutLoadResult(key, seq, result) {
      if (!isLatestScoutSeq(key, seq)) return null
      return writeScoutCacheFromResult(key, result)
    }

    // 设置页「显示」回填的明文缓存；只存在当前渲染器内存里，页面重载即失效。
    const secretValueCache = new Map()
    function rememberSecret(field, value) {
      if (value === undefined || value === null || value === '') secretValueCache.delete(field)
      else secretValueCache.set(field, String(value))
    }
    function forgetSecret(field) {
      secretValueCache.delete(field)
    }
    function rememberedSecrets() {
      return Object.fromEntries(secretValueCache)
    }

    /**
     * 解析 commands.execute 的返回。DSH 的真实形状是
     * `{ok:true, value:{commandId, result:{kind,text}}}`；
     * 早期/测试 mock 可能直接给 `{ok:true, value:{text}}`，两者都兼容。
     */
    function parseCommandResponse(response) {
      if (!response?.ok) return { ok: false, error: response?.error?.message || '命令执行失败' }
      const value = response.value
      if (value === undefined || value === null) return { ok: false, error: '命令未注册或没有返回结果' }
      const result = value.result ?? value
      const text = typeof result?.text === 'string' ? result.text : ''
      if (!text) {
        return result?.kind === 'error'
          ? { ok: false, error: '命令没有返回内容' }
          : { ok: true, text: '' }
      }
      try {
        return JSON.parse(text)
      } catch {
        if (result?.kind === 'error') return { ok: false, error: text }
        return { ok: true, text }
      }
    }

    function ScoutSection(props) {
      const { useSessions } = props
      // 只使用 apply 时快照的实例；不要在渲染期重新读 ctx.remote（每次都是新 Proxy）。
      const remote = runtimeRemote

      // 无条件调用 hook（缺失时用同样走 hooks 的兜底实现），保证每次渲染 hook 顺序一致。
      const useSessionHook = typeof useSessions === 'function' ? useSessions : useNoSessions
      const sessionId = useSessionHook((state) => {
        const byId = state?.byId || {}
        const ids = Object.keys(byId)
        return ids.find((id) => (byId[id]?.retainedBy?.mainView || 0) > 0) || ids[0]
      })

      const loadKey = cacheKeyOf(sessionId)
      const initialCache = readScoutCache(loadKey)

      const [status, setStatus] = React.useState(initialCache ? 'ready' : 'loading')
      const [error, setError] = React.useState('')
      const [row, setRow] = React.useState(initialCache?.row || null)
      const [draft, setDraft] = React.useState(initialCache?.draft || mergeDraft(null))
      const [scout, setScout] = React.useState(initialCache?.scout || null)
      const [scoutError, setScoutError] = React.useState('')
      // 凭据来源/有效性：由 /scout-cred-status 返回，前端不再猜 secrets[].set。
      const [credStatus, setCredStatus] = React.useState(null)
      const credStatusRef = React.useRef(null)
      // 定时真实状态：由 /scout-schedule-status 返回（定时器自己报的），不信 describe。
      const [schedStatus, setSchedStatus] = React.useState(null)
      const [tab, setTabState] = React.useState(readTab)
      const panelRef = React.useRef(null)
      const [busy, setBusy] = React.useState('')
      const [flash, setFlash] = React.useState('')
      // 明文缓存跨 section 重挂载保留；页面重载后清空（仍可用「显示」从后端取回）。
      const [secretInput, setSecretInput] = React.useState(() => rememberedSecrets())
      const [reveal, setReveal] = React.useState({})
      const [why, setWhy] = React.useState({})
      const [testResult, setTestResult] = React.useState({})
      const [focusDraft, setFocusDraft] = React.useState(initialCache?.focusDraft || { topic: '', until: addDays(todayStr(), 1), note: '' })
      const [sourcesDraft, setSourcesDraft] = React.useState(initialCache?.sourcesDraft || null)
      const [limitsDraft, setLimitsDraft] = React.useState(initialCache?.limitsDraft || null)
      const [conflict, setConflict] = React.useState(null)
      const [channelConfirm, setChannelConfirm] = React.useState(null)
      const [run, setRun] = React.useState({ running: false, seconds: 0, result: null, error: '', log: '' })
      const [now, setNow] = React.useState(Date.now())
      // 会话在加载途中被切换时，用它把“新会话还没加载”补回来。
      const [reloadTick, setReloadTick] = React.useState(0)
      const sessionKeyRef = React.useRef(loadKey)
      sessionKeyRef.current = loadKey

      // refs 是需求里的 fast-path 锁；模块级 loadGuard 保证“跨重挂载/多实例”也只加载一次。
      const guardRef = React.useRef(loadGuard)
      const loadedKeyRef = React.useRef(loadGuard.loadedKey)
      const inFlightRef = React.useRef(loadGuard.inFlight)
      const lastLoadAtRef = React.useRef(loadGuard.lastAttemptAt)
      const syncGuardRefs = () => {
        loadedKeyRef.current = guardRef.current.loadedKey
        inFlightRef.current = guardRef.current.inFlight
        lastLoadAtRef.current = guardRef.current.lastAttemptAt
      }

      React.useEffect(() => {
        tabWatchers.add(setTabState)
        setTabState(readTab())
        return () => { tabWatchers.delete(setTabState) }
      }, [])

      const switchTab = React.useCallback((next) => {
        // 先直接更新本实例：即使宿主正重挂载、watcher 尚未注册，点击也不会“没反应”。
        setTabState(next)
        writeTab(next)
        setFlash('')
        requestAnimationFrame(() => {
          const node = panelRef.current
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        })
      }, [])

      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30 * 1000)
        return () => clearInterval(timer)
      }, [])

      React.useEffect(() => {
        if (!run.running) return undefined
        const timer = setInterval(() => setRun((prev) => ({ ...prev, seconds: prev.seconds + 1 })), 1000)
        return () => clearInterval(timer)
      }, [run.running])

      const call = React.useCallback(async (line) => {
        if (!sessionId) return { ok: false, error: '当前没有打开的会话' }
        try {
          const response = await remote.commands.execute(sessionId, line, [])
          return parseCommandResponse(response)
        } catch (err) {
          return { ok: false, error: err?.message || String(err) }
        }
      }, [remote, sessionId])

      const loadCredStatus = React.useCallback(async () => {
        if (!sessionId) {
          credStatusRef.current = null
          setCredStatus(null)
          return null
        }
        const res = await call('/scout-cred-status')
        const fields = res?.ok ? (res.fields || null) : null
        credStatusRef.current = fields
        setCredStatus(fields)
        return fields
      }, [call, sessionId])

      React.useEffect(() => {
        if (!sessionId) {
          credStatusRef.current = null
          setCredStatus(null)
          return undefined
        }
        void loadCredStatus()
        return undefined
      }, [sessionId, loadCredStatus])

      /** 定时器自报状态：这是「到点会不会跑」的唯一可信答案。 */
      const loadScheduleStatus = React.useCallback(async () => {
        if (!sessionId) {
          setSchedStatus({ ok: false, error: '当前没有打开的会话' })
          return null
        }
        const res = await call('/scout-schedule-status')
        const next = res?.ok
          ? {
            ok: true,
            enabled: res.enabled === true,
            time: String(res.time || ''),
            timeZone: String(res.timeZone || TZ),
            nextFireAt: String(res.nextFireAt || ''),
            checkedAt: String(res.checkedAt || ''),
            arms: Number(res.arms) || 0,
          }
          : { ok: false, error: String(res?.error || '读取定时状态失败') }
        setSchedStatus(next)
        return next
      }, [call, sessionId])

      // 保存后定时器最多 60 秒才重新复查配置，所以隔一会儿补两次刷新，别让页面一直显示旧结论。
      const schedTimers = React.useRef([])
      const refreshScheduleSoon = React.useCallback((delays = [1500, 65000]) => {
        for (const t of schedTimers.current) clearTimeout(t)
        schedTimers.current = delays.map((ms) => setTimeout(() => { void loadScheduleStatus() }, ms))
      }, [loadScheduleStatus])

      React.useEffect(() => () => {
        for (const t of schedTimers.current) clearTimeout(t)
        schedTimers.current = []
      }, [])

      React.useEffect(() => {
        if (!sessionId) {
          setSchedStatus(null)
          return undefined
        }
        void loadScheduleStatus()
        return undefined
      }, [sessionId, loadScheduleStatus])

      const loadPlugin = React.useCallback(async () => {
        if (!remote) throw new Error('remote 服务不可用（插件上下文未就绪）')
        const response = await remote.settings.describe()
        if (!response?.ok) throw new Error(response?.error?.message || 'describe 失败')
        const found = (response.value?.namespaces || []).find((item) => item.ns === ENTRY)
        if (!found) throw new Error('没有找到 scout 插件条目（--dump-config 应有 id: scout）')
        const nextDraft = mergeDraft(found.value)
        setRow(found)
        setDraft(nextDraft)
        writeScoutCache(cacheKeyOf(sessionId), { row: found, draft: nextDraft })
        return found
      }, [remote, sessionId])

      const applyScoutDrafts = React.useCallback((next) => {
        if (!next) return
        setScout(next.scout)
        setSourcesDraft(next.sourcesDraft)
        setLimitsDraft(next.limitsDraft)
        setFocusDraft(next.focusDraft)
        setScoutError('')
      }, [])

      /**
       * 读 config.yaml。force=true 时先失效缓存，并让所有更早的 in-flight 响应作废；
       * 保存后的重读必须走 force。
       */
      const loadScout = React.useCallback(async (options = {}) => {
        const key = cacheKeyOf(sessionId)
        if (!sessionId) { setScoutError('先在左侧打开一个会话，才能读写 scout/config.yaml。'); return null }
        if (options.force) invalidateScoutCache(key)
        const seq = beginScoutSeq(key)
        // 在真正发命令前记时间，保证两次 /scout-config-load 之间硬间隔 ≥5s。
        loadGuard.noteAttempt()
        const result = await call('/scout-config-load')
        // 晚到的旧响应（保存/重读/重挂载竞态）不得覆盖新值。
        if (!isLatestScoutSeq(key, seq)) return null
        if (!result?.ok) { setScoutError(result?.error || '读取 scout/config.yaml 失败'); return null }
        const next = commitScoutLoadResult(key, seq, result)
        if (!next) return null
        applyScoutDrafts(next)
        return result
      }, [call, sessionId, applyScoutDrafts])

      const hydrateFromCache = React.useCallback((cached) => {
        if (!cached) return
        if (cached.row) setRow(cached.row)
        if (cached.draft) setDraft(cached.draft)
        if (cached.scout) setScout(cached.scout)
        if (cached.sourcesDraft) setSourcesDraft(cached.sourcesDraft)
        if (cached.limitsDraft) setLimitsDraft(cached.limitsDraft)
        if (cached.focusDraft) setFocusDraft(cached.focusDraft)
        setScoutError('')
        setStatus('ready')
      }, [])

      /**
       * 唯一加载入口。force 只给“用户点重试”使用；effect 永远走非 force 路径。
       * 成功才 succeed(key)；失败保留 loadedKey=null 并记录尝试时间供 5s 节流。
       */
      const runLoad = React.useCallback(async (force = false) => {
        const key = cacheKeyOf(sessionId)
        const guard = guardRef.current
        const decision = guard.begin(key, Date.now(), force)
        syncGuardRefs()
        if (!decision.allowed) return decision
        try {
          const found = await loadPlugin()
          setStatus('ready')
          setError('')
          if (!sessionId) {
            setScoutError('先在左侧打开一个会话，才能读写 scout/config.yaml。')
            guard.succeed(key)
            return { ok: true, skipped: true }
          }
          const result = await loadScout()
          if (result) {
            guard.succeed(key)
            writeScoutCache(key, { row: found, draft: mergeDraft(found.value) })
            return { ok: true }
          }
          guard.fail('scout')
          return { ok: false, reason: 'scout' }
        } catch (err) {
          setStatus('error')
          setError(err?.message || String(err))
          guard.fail('plugin')
          return { ok: false, reason: 'plugin', error: err }
        } finally {
          syncGuardRefs()
          // 加载期间 sessionId 变了：旧请求完成后补一次新会话的加载。
          if (sessionKeyRef.current !== key) setReloadTick((n) => n + 1)
        }
      }, [sessionId, loadPlugin, loadScout])

      React.useEffect(() => {
        const key = cacheKeyOf(sessionId)
        const guard = guardRef.current
        // 同一会话已加载（包括本组件重挂载前由上一个实例加载）：只回填缓存，不再发命令。
        if (loadedKeyRef.current === key || guard.isLoaded(key)) {
          hydrateFromCache(readScoutCache(key))
          setStatus('ready')
          return undefined
        }
        if (inFlightRef.current) {
          // 重挂载撞上上一个实例的 in-flight：等它结束后再回填缓存，避免新实例永远“加载中”。
          const timer = setTimeout(() => setReloadTick((n) => n + 1), 150)
          return () => clearTimeout(timer)
        }
        const decision = guard.plan(key)
        if (decision.allowed) {
          void runLoad()
          return undefined
        }
        // 会话切换正好落在 5s 节流窗口内：等窗口结束再试，避免一次都不加载。
        if (decision.reason === 'throttled') {
          let timer
          const attempt = () => {
            const next = guard.plan(key)
            if (next.allowed) void runLoad()
            else if (next.reason === 'throttled') timer = setTimeout(attempt, next.waitMs + 20)
          }
          timer = setTimeout(attempt, decision.waitMs + 20)
          return () => clearTimeout(timer)
        }
        return undefined
      }, [sessionId, runLoad, hydrateFromCache, reloadTick])

      const patch = (fn) => {
        const next = JSON.parse(JSON.stringify(draft))
        fn(next)
        setDraft(next)
      }

      const savePlugin = async (ops, label) => {
        setBusy(label || 'save')
        setFlash('')
        try {
          let response = await remote.settings.mutate(ENTRY, ops, row?.revision)
          if (!response?.ok) {
            const msg = response?.error?.message || ''
            // 版本冲突（连续保存/其他入口改过配置）：刷新 revision 后自动重试一次。
            if (/changed since it was read|revision/i.test(msg)) {
              const fresh = await loadPlugin()
              response = await remote.settings.mutate(ENTRY, ops, fresh?.revision)
            }
            if (!response?.ok) {
              setFlash('错误：' + (response?.error?.message || '写入被拒绝'))
              return false
            }
          }
          await loadPlugin()
          await loadCredStatus()
          setFlash('已保存（插件配置）')
          return true
        } catch (err) {
          setFlash('错误：' + (err?.message || String(err)))
          return false
        } finally {
          setBusy('')
        }
      }

      /**
       * 迁移：把 snippet 旧凭据填入输入框（saveAll=true 时逐项保存）。
       * snippet 文件只读；导入只发生在设置页。
       */
      const importSnippet = async (saveAll) => {
        const label = saveAll ? 'import-save' : 'import'
        setBusy(label)
        setFlash('')
        const res = await call('/scout-cred-import')
        if (!res?.ok) {
          setBusy('')
          setFlash(res?.error || '读取 snippet 失败')
          return false
        }
        const entries = Object.entries(res.fields || {})
          .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
          .map(([field, value]) => [field, value.trim()])
          // 只导入设置页仍为空的字段，避免覆盖用户已手工保存的值。
          .filter(([field]) => !credStatusRef.current?.[field]?.settings)
        if (entries.length === 0) {
          setBusy('')
          setFlash('snippet 里没有需要导入的旧值（设置页已有配置）')
          return false
        }
        const secretEntries = entries.filter(([field]) => field !== 'feishuWebhook')
        const feishuEntry = entries.find(([field]) => field === 'feishuWebhook')
        const nextInput = { ...secretInput }
        const nextReveal = {}
        for (const [field, value] of secretEntries) {
          nextInput[field] = value
          rememberSecret(field, value)
          nextReveal['sec:' + field] = true
        }
        setSecretInput(nextInput)
        setReveal((prev) => ({ ...prev, ...nextReveal }))
        if (!saveAll) {
          setBusy('')
          setFlash(secretEntries.length > 0
            ? '已填入凭据输入框，请逐项点「保存」确认' + (feishuEntry ? '；飞书 Webhook 请点「全部导入并保存」或到「渠道」页新增' : '')
            : 'snippet 里只有飞书 Webhook；请点「全部导入并保存」或到「渠道」页新增')
          return true
        }
        for (const [field, value] of secretEntries) {
          const ok = await savePlugin([{ op: 'set', path: ['credentials', field], value }], 'save')
          if (!ok) {
            setBusy('')
            return false
          }
        }
        if (feishuEntry) {
          const value = feishuEntry[1]
          const current = Array.isArray(draft.channels) ? draft.channels : []
          const exists = current.some((channel) => String(channel?.url || '').trim() === value)
          if (!exists) {
            const ok = await savePlugin([{
              op: 'set',
              path: ['channels'],
              value: [
                ...current,
                { name: 'snippet 迁移', type: 'feishu', url: value, enabled: true, keyword: '情报', secret: '', headers: '', limit: 20 },
              ],
            }], 'save')
            if (!ok) {
              setBusy('')
              return false
            }
          }
        }
        await loadCredStatus()
        setBusy('')
        setFlash('已全部导入并保存到设置页')
        return true
      }

      const saveChannels = async (force = false) => {
        const mismatches = (draft.channels || []).filter(channelTypeMismatch)
        if (mismatches.length > 0 && !force) {
          setChannelConfirm(mismatches.map((channel) => String(channel.name || '未命名渠道')))
          return false
        }
        setChannelConfirm(null)
        return savePlugin([{ op: 'set', path: ['channels'], value: draft.channels }], 'save')
      }

      const saveScout = async (set, deleteFocus, force) => {
        if (!sessionId) { setFlash('先打开一个会话'); return false }
        setBusy('scout-save')
        setFlash('')
        const payload = { expectedSha256: scout?.sha256 || '', set, deleteFocus: !!deleteFocus }
        if (force) payload.force = true
        const result = await call('/scout-config-save ' + JSON.stringify(payload))
        setBusy('')
        if (result?.conflict) {
          setConflict({ set, deleteFocus: !!deleteFocus })
          return false
        }
        if (!result?.ok) {
          setFlash('写入失败：' + (result?.error || '未知错误'))
          return false
        }
        // 保存结果本身带完整 values：先立即回填并更新缓存，界面不允许回退到旧值。
        const key = cacheKeyOf(sessionId)
        const next = writeScoutCacheFromResult(key, result)
        beginScoutSeq(key) // 让保存前发出的旧 load 响应作废
        applyScoutDrafts(next)
        setConflict(null)

        // 再强制从 config.yaml 重读一次（绕过缓存）；失败时保留并恢复保存结果的缓存。
        const loaded = await loadScout({ force: true })
        if (!loaded && !readScoutCache(key)) writeScoutCacheFromResult(key, result)
        guardRef.current.succeed(key)
        syncGuardRefs()
        setFlash('已写入 scout/config.yaml' + (result.backup ? `（备份 ${result.backup.split(/[\\/]/).pop()}）` : ''))
        return true
      }

      const checkCredential = async (field) => {
        setBusy('check:' + field)
        const result = await call('/scout-check ' + field)
        setBusy('')
        setTestResult((prev) => ({ ...prev, [field]: { text: result?.detail || result?.error || (result?.ok ? '校验通过' : '校验失败') } }))
      }

      const testChannel = async (index, name) => {
        setBusy('test:' + index)
        const result = await call('/scout-test ' + name)
        setBusy('')
        const channels = result?.channels || []
        const lines = channels.map((channel) => `${channel.name || '渠道'}：${channel.ok ? 'OK' : (channel.error || '失败')}`)
        setTestResult((prev) => ({
          ...prev,
          ['ch' + index]: { text: String(lines.join('\n') || result?.error || '测试失败').slice(0, 1000) },
        }))
      }

      const startRun = async () => {
        if (run.running || cooldownLeft() > 0) return
        setRun({ running: true, seconds: 0, result: null, error: '', log: '' })
        const result = await call('/scout-run' + (draft.ui.dryRun ? ' dry' : ''))
        const finished = new Date().toISOString()
        setRun({ running: false, seconds: 0, result: result?.ok ? result : null, error: result?.ok ? '' : (result?.error || '运行失败'), log: '' })
        if (!result?.ok) {
          const log = await call('/scout-log 20')
          if (log?.ok) setRun((prev) => ({ ...prev, log: (log.lines || []).join('\n') }))
        }
        try {
          const latest = await loadPlugin()
          const ui = { ...(latest?.value?.ui || {}), lastRunAt: finished, lastSummary: JSON.stringify(result || {}) }
          await remote.settings.mutate(ENTRY, [{ op: 'set', path: ['ui'], value: ui }], latest?.revision)
          await loadPlugin()
        } catch { /* 冷却记录失败不影响结果展示 */ }
      }

      const cooldownLeft = () => {
        const last = Date.parse(draft.ui.lastRunAt || '')
        if (!Number.isFinite(last)) return 0
        const left = Math.ceil((last + COOLDOWN_SECONDS * 1000 - now) / 1000)
        return left > 0 ? left : 0
      }

      // ---------------- 待办 ----------------
      const channels = draft.channels || []
      // v8：effective 只认设置页；snippet 只通过 /scout-cred-status 的 snippet 标志做迁移提示。
      const credInfo = (field) => credStatus?.[field] || null
      const hasChannelSetting = channels.some((c) => c && c.enabled !== false && String(c.url || '').trim())
      // 飞书也只认设置页 channels；snippet 的 FEISHU_WEBHOOK 不再参与 effective。
      const hasChannel = credStatus ? (credInfo('feishuWebhook')?.effective ?? hasChannelSetting) : hasChannelSetting
      const githubSet = !!credInfo('githubToken')?.effective
      const deepseekSet = !!credInfo('deepseekApiKey')?.effective
      const biliSet = !!credInfo('biliSessdata')?.effective
      const credStatusKnown = !!credStatus
      const todos = []
      if (!githubSet) {
        todos.push({
          id: 'github', title: '① 配 GitHub token（采集公开仓库用）',
          do: '新建只读 token，粘到「凭据 → GitHub token」，点「校验」。',
          links: [['classic tokens', 'https://github.com/settings/tokens'], ['fine-grained', 'https://github.com/settings/personal-access-tokens']],
          perm: 'fine-grained：Public Repositories + Metadata: Read；classic：不勾任何 scope。',
          where: '设置 → 情报员日报 → 凭据 → GitHub token',
          verify: '点「校验」，返回配额数字与 token 类型即通。',
          why: '只用来调 GitHub 搜索/仓库接口，只读公开信息，不外传。',
          tab: 'credentials',
        })
      }
      if (!hasChannel) {
        todos.push({
          id: 'feishu', title: '② 加一个飞书群机器人（日报发这里）',
          do: '目标群 → 设置 → 群机器人 → 添加 → 自定义机器人 → 复制 Webhook。',
          links: [['飞书自定义机器人帮助', 'https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot']],
          perm: '群内「添加机器人」权限；安全设置建议「自定义关键词」填「情报」。',
          where: '设置 → 情报员日报 → 渠道 → 新增渠道',
          verify: '点该渠道「测试」，群里立刻收到【测试】。',
          why: '日报只发到你指定的群；Webhook 存本机，页面默认掩码。',
          tab: 'channels',
        })
      }
      if (!deepseekSet) {
        todos.push({
          id: 'deepseek', title: '③ 配 DeepSeek API Key（写日报用）',
          do: '在开放平台新建 Key，粘到「凭据 → DeepSeek API Key」。',
          links: [['DeepSeek 开放平台', 'https://platform.deepseek.com/api_keys']],
          perm: '账号可创建 API Key 即可。',
          where: '设置 → 情报员日报 → 凭据 → DeepSeek API Key',
          verify: '点「校验」，返回可用模型即通。',
          why: '只用于调用 deepseek 模型写日报，不外传。',
          tab: 'credentials',
        })
      }
      if (!biliSet && sourcesDraft?.biliOn) {
        todos.push({
          id: 'bili', title: '④ 配 B站 SESSDATA（可选）',
          do: '浏览器登录 B 站 → F12 → 应用/存储 → Cookies → 复制 SESSDATA。',
          links: [['B站', 'https://www.bilibili.com']],
          perm: '你自己的登录态，只读。不填则该源自动禁用。',
          where: '设置 → 情报员日报 → 凭据 → B站 SESSDATA',
          verify: '点「校验」，返回登录态有效即通。',
          why: '只用于 B 站搜索接口，不外传；不填不影响其他源。',
          tab: 'credentials',
        })
      }
      // 定时：谁最清楚到点会不会跑？定时器自己。所以先问宿主（/scout-schedule-status），
      // 读不到才退回 describe；两者都没有时明确显示「正在读取」，不再谎称「未保存」。
      const schedule = resolveScheduleView({ status: schedStatus, rowValue: row?.value, rowLoaded: !!row, fallbackTime: draft.schedule?.time })
      if (schedule.known && !schedule.enabled) {
        todos.push({
          id: 'schedule', title: '⑤ 把定时真正打开（现在到点不会自动跑）',
          do: `进「定时」页点一次「保存定时」，把 ${schedule.time} 写进插件配置。`,
          links: [],
          perm: '不需要额外权限；宿主定时器在 DSH 进程内，DSH 在线就会触发。',
          where: '设置 → 情报员日报 → 定时 → 保存定时',
          verify: '保存后一分钟内「定时」页顶部会变成「已开启」；回到待办，这条消失。到点自动跑一轮，不需要开会话。',
          why: '宿主定时器没有挂上，到点什么都不会发生。插件配置里 schedule.enabled 的缺省值是 true，所以只有被显式存成关闭才会出现这种情况。',
          tab: 'schedule',
        })
      }

      if (status === 'loading') return el('div', { className: 'scout-section' }, el('p', { className: 'scout-p' }, '加载中…'))
      if (status === 'error') {
        return el('div', { className: 'scout-section' },
          el('h3', { className: 'scout-h' }, '情报员日报'),
          el('p', { className: 'scout-err' }, '读取插件配置失败：' + error),
          el('button', {
            className: 'scout-btn',
            onClick: async () => {
              setStatus('loading')
              await runLoad(true)
            },
          }, '重试'))
      }

      const price = priceState(now, { timeZone: TZ })
      const focusState = activeFocus(scout?.values?.focus)
      const cooling = cooldownLeft()

      const tabBtn = (id, label) => el('button', {
        key: id, className: 'scout-tab', 'data-active': tab === id ? 'true' : 'false',
        onClick: () => switchTab(id),
      }, label)

      const costCard = el('div', { className: 'scout-card' },
        el('div', { className: 'scout-row', style: { justifyContent: 'space-between' } },
          el('h4', null, '成本与时段'),
          el('span', {
            className: 'scout-badge ' + (price.peak ? 'peak' : 'idle'),
            title: price.reason === 'weekend' ? '周末按空闲计；节假日无法精确判断时按工作日算' : '工作日 09:00–12:00、14:00–18:00 为高峰',
          }, price.label)),
        el('table', { className: 'scout-table' },
          el('thead', null, el('tr', null,
            el('th', null, '模型'), el('th', null, '时段'),
            el('th', null, '缓存命中输入'), el('th', null, '未命中输入'), el('th', null, '输出'))),
          el('tbody', null,
            el('tr', null, el('td', null, 'V4-Flash'), el('td', null, '空闲'), el('td', null, '0.02'), el('td', null, '1'), el('td', null, '2')),
            el('tr', null, el('td', null, 'V4-Flash'), el('td', null, '高峰'), el('td', null, '0.04'), el('td', null, '2'), el('td', null, '4')),
            el('tr', null, el('td', null, 'V4-Pro'), el('td', null, '空闲'), el('td', null, '0.025'), el('td', null, '3'), el('td', null, '6')),
            el('tr', null, el('td', null, 'V4-Pro'), el('td', null, '高峰'), el('td', null, '0.05'), el('td', null, '6'), el('td', null, '12')))),
        el('p', { className: 'scout-note' }, costNote(sourcesDraft?.runTime || draft.schedule.time)),
        el('div', { className: 'scout-row' },
          el('label', null, el('input', {
            type: 'checkbox', checked: !!draft.ui.dryRun,
            onChange: (e) => patch((d) => { d.ui.dryRun = e.target.checked }),
          }), ' 演练（dry_run，不发消息）'),
          el('button', {
            className: 'scout-btn primary big',
            disabled: run.running || cooling > 0,
            onClick: startRun,
          }, run.running
            ? el('span', null, el('span', { className: 'scout-spin' }), `已跑 ${run.seconds} 秒…`)
            : (cooling > 0 ? `冷却中 ${cooling}s` : '再探再报')),
          price.peak ? el('span', { className: 'scout-err' }, '当前高峰，本次约 ×2 价') : null,
          run.result ? el('span', { className: 'scout-ok' }, `上次：${run.result.state} · 发送 ${run.result.notify?.sent ?? 0} 条 · ${run.result.elapsed_seconds}s${run.result.retried_after_midnight ? ` · 跨零点自动重跑（原 ${run.result.original_date || '昨天'}）` : ''}`) : null),
        run.error ? el('div', { className: 'scout-err' },
          '运行失败：' + run.error,
          el('div', null, el('button', {
            className: 'scout-btn',
            onClick: async () => {
              const log = await call('/scout-log 20')
              if (log?.ok) setRun((prev) => ({ ...prev, log: (log.lines || []).join('\n') }))
            },
          }, '查看日志（scout/logs/daily.log 末尾）'))) : null,
        run.log ? el('pre', { className: 'scout-pre' }, run.log) : null)

      // ---------------- 各 tab ----------------
      const todoPanel = el('div', { className: 'scout-card' },
        el('h4', null, '待办清单（按缺口动态生成）'),
        !credStatusKnown ? el('p', { className: 'scout-note' }, '凭据来源状态未读取（需要当前会话）；以下凭据按未配置保守处理。') : null,
        todos.length === 0 && credStatusKnown ? el('p', { className: 'scout-ok' }, '✓ 该配的都配齐了，可以跑了。') : null,
        todos.map((todo) => el('div', { className: 'scout-todo', key: todo.id },
          el('h4', null, todo.title,
            el('button', { className: 'scout-why', title: '为什么需要', onClick: () => setWhy((prev) => ({ ...prev, [todo.id]: !prev[todo.id] })) }, '?')),
          why[todo.id] ? el('div', { className: 'scout-note' }, todo.why) : null,
          el('div', null, '做什么：', todo.do),
          (todo.links || []).length > 0 ? el('div', null, '去哪拿：', ...todo.links.flatMap(([label, url], i) => [
            i > 0 ? el('span', { key: 's' + i }, ' ｜ ') : null,
            el('a', { key: 'a' + i, href: url, target: '_blank', rel: 'noopener noreferrer', title: url }, label),
          ])) : null,
          el('div', null, '需要什么权限：', todo.perm),
          el('div', null, '粘到哪：', todo.where),
          el('div', null, '怎么验证：', todo.verify),
          el('div', null, el('button', { className: 'scout-btn', onClick: () => switchTab(todo.tab) }, '去配置')))))

      const noSession = !sessionId
        ? el('div', { className: 'scout-card' }, el('p', { className: 'scout-err' }, '先在左侧打开一个会话，才能读写 scout/config.yaml 与运行日报。'))
        : null

      const sourcesPanel = el('div', { className: 'scout-card' },
        el('h4', null, '本期重点（直接写回 scout/config.yaml）'),
        el('div', { className: 'scout-p' }, '当前生效：', el('b', null, focusState.text)),
        el('div', { className: 'scout-row', style: { alignItems: 'flex-start' } },
          el('label', null, '重点描述'),
          el('textarea', {
            className: 'scout-area', value: focusDraft.topic,
            placeholder: 'AI 语音方向：TTS / 语音克隆 / ASR / 语音 agent；语音类优先，最多 4 条',
            onChange: (e) => setFocusDraft((prev) => ({ ...prev, topic: e.target.value })),
          })),
        el('div', { className: 'scout-row' },
          el('label', null, '有效期至'),
          el('input', { className: 'scout-in', type: 'date', value: focusDraft.until || '', onChange: (e) => setFocusDraft((prev) => ({ ...prev, until: e.target.value })) }),
          el('label', null, '补充要求'),
          el('input', { className: 'scout-in', value: focusDraft.note || '', placeholder: '可空，对应 note', onChange: (e) => setFocusDraft((prev) => ({ ...prev, note: e.target.value })) })),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn primary', disabled: busy === 'scout-save' || !sessionId,
            onClick: () => {
              const topic = String(focusDraft.topic || '').trim()
              if (!topic) { saveScout({}, true, false); return }
              saveScout({
                'report.focus.topic': topic,
                'report.focus.until': String(focusDraft.until || '').trim(),
                'report.focus.note': String(focusDraft.note || ''),
              }, false, false)
            },
          }, busy === 'scout-save' ? '写入中…' : '保存到 config.yaml'),
          el('button', { className: 'scout-btn', disabled: busy === 'scout-save' || !sessionId, onClick: () => saveScout({}, true, false) }, '清空重点'),
          el('span', { className: 'scout-note' }, scout ? `config.yaml ${String(scout.sha256 || '').slice(0, 8)}… · 备份 ${scout.backups} 份` : (scoutError || ''))),
        el('h4', { style: { marginTop: '8px' } }, '采集源'),
        sourcesDraft ? el('div', null,
          el('div', { className: 'scout-grid' },
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.githubOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, githubOn: e.target.checked })) }), ' GitHub 搜索'),
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.awesomeOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, awesomeOn: e.target.checked })) }), ' Awesome 仓库'),
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.releasesOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, releasesOn: e.target.checked })) }), ' Releases'),
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.hnOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, hnOn: e.target.checked })) }), ' Hacker News'),
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.biliOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliOn: e.target.checked })) }), ' B 站')),
          el('div', { className: 'scout-grid' },
            el('label', null, 'GitHub 近几天 ', el('input', { className: 'scout-in', type: 'number', min: 1, max: 30, value: sourcesDraft.githubSinceDays, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, githubSinceDays: num(e.target.value, 7) })) })),
            el('label', null, '最低 star ', el('input', { className: 'scout-in', type: 'number', min: 0, value: sourcesDraft.githubStarsMin, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, githubStarsMin: num(e.target.value, 50) })) }))),
          el('div', { className: 'scout-grid', style: { marginTop: '6px' } },
            el('label', null, el('input', { type: 'checkbox', checked: sourcesDraft.biliSearchOn, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchOn: e.target.checked })) }), ' B 站搜索源'),
            el('label', null, '每轮最多 ', el('input', { className: 'scout-in', type: 'number', min: 1, max: 20, value: sourcesDraft.biliSearchMaxItems, onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchMaxItems: intIn(e.target.value, 6, 1, 20) })) }))),
          el('div', { className: 'scout-row', style: { marginTop: '4px' } },
            el('label', null, 'B 站关键词'),
            el('input', {
              className: 'scout-in',
              placeholder: '未配置关键词，B 站搜索源不会产出条目',
              value: sourcesDraft.biliSearchKeywordsText || '',
              onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchKeywordsText: e.target.value })),
            })),
          el('div', { className: 'scout-grid', style: { marginTop: '6px' } },
            el('label', null, '字幕 ', el('select', {
              className: 'scout-sel',
              value: subtitleMode(sourcesDraft.biliSearchSubtitle),
              onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchSubtitle: e.target.value })),
            },
            el('option', { value: 'prefer' }, 'prefer（有字幕优先）'),
            el('option', { value: 'require' }, 'require（无字幕淘汰）'),
            el('option', { value: 'off' }, 'off（不抓字幕）'))),
            el('label', null, '最低播放 ', el('input', {
              className: 'scout-in', type: 'number', min: 0, max: 1000000, step: 1000,
              value: sourcesDraft.biliSearchMinPlay,
              onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchMinPlay: intIn(e.target.value, 5000, 0, 1000000) })),
            })),
            el('label', null, '最近天数 ', el('input', {
              className: 'scout-in', type: 'number', min: 1, max: 180,
              value: sourcesDraft.biliSearchMaxDays,
              onChange: (e) => setSourcesDraft((prev) => ({ ...prev, biliSearchMaxDays: intIn(e.target.value, 14, 1, 180) })),
            }))),
          el('div', { className: 'scout-note' }, '字幕判定模式：prefer 会抓取候选视频的字幕节选供日报判定（每轮约多 10+ 个请求）'),
          el('div', { className: 'scout-note' }, '低于最低播放量的视频不进候选；只收最近 N 天发布的视频。'),
          el('div', { className: 'scout-note', style: { whiteSpace: 'pre-wrap' } },
            '用途：这些词每天用于 B 站搜索，命中的视频按播放量/时长/发布时间过滤后进候选池。\n'
            + '写法建议：2–5 个为宜，中英文均可，用中文或英文逗号分隔；词太泛会推来低质内容，太窄会常驻“无新增”。\n'
            + '生效时机：保存后下一轮采集（每日定时或手动再探再报）即用新词。\n'
            + '提醒：请求量与词数正相关，词多会轻微增加运行时长。'),
          limitsDraft ? el('div', { className: 'scout-grid', style: { marginTop: '6px' } },
            el('label', null, '日报条数 ', el('input', { className: 'scout-in', type: 'number', min: 1, max: 100, value: limitsDraft.maxItems, onChange: (e) => setLimitsDraft((prev) => ({ ...prev, maxItems: num(e.target.value, 6) })) })),
            el('label', null, '候选总数 ', el('input', { className: 'scout-in', type: 'number', min: 1, value: limitsDraft.totalCandidates, onChange: (e) => setLimitsDraft((prev) => ({ ...prev, totalCandidates: num(e.target.value, 40) })) })),
            el('label', null, '必读上限 ', el('input', { className: 'scout-in', type: 'number', min: 1, value: limitsDraft.readsMax, onChange: (e) => setLimitsDraft((prev) => ({ ...prev, readsMax: num(e.target.value, 20) })) })),
            el('label', null, '单源上限 ', el('input', { className: 'scout-in', type: 'number', min: 1, value: limitsDraft.perSourceLimit, onChange: (e) => setLimitsDraft((prev) => ({ ...prev, perSourceLimit: num(e.target.value, 30) })) })),
            el('label', null, '片段字符 ', el('input', { className: 'scout-in', type: 'number', min: 100, value: limitsDraft.snippetChars, onChange: (e) => setLimitsDraft((prev) => ({ ...prev, snippetChars: num(e.target.value, 800) })) })))
            : el('p', { className: 'scout-note' }, '读取 config.yaml 中…'),
          el('div', { className: 'scout-row' },
            el('button', {
              className: 'scout-btn primary', disabled: busy === 'scout-save' || !sessionId,
              onClick: () => saveScout({
                'sources.github_search.on': !!sourcesDraft.githubOn,
                'sources.github_search.since_days': num(sourcesDraft.githubSinceDays, 7),
                'sources.github_search.stars_min': num(sourcesDraft.githubStarsMin, 50),
                'sources.awesome.on': !!sourcesDraft.awesomeOn,
                'sources.releases.on': !!sourcesDraft.releasesOn,
                'sources.hn.on': !!sourcesDraft.hnOn,
                'sources.bili.on': !!sourcesDraft.biliOn,
                'sources.bili.search.on': !!sourcesDraft.biliSearchOn,
                'sources.bili.search.max_items': intIn(sourcesDraft.biliSearchMaxItems, 6, 1, 20),
                'sources.bili.search.keywords': parseKeywords(sourcesDraft.biliSearchKeywordsText),
                'sources.bili.search.subtitle': subtitleMode(sourcesDraft.biliSearchSubtitle),
                'sources.bili.search.min_play': intIn(sourcesDraft.biliSearchMinPlay, 5000, 0, 1000000),
                'sources.bili.search.max_days': intIn(sourcesDraft.biliSearchMaxDays, 14, 1, 180),
                'report.max_items': num(limitsDraft.maxItems, 6),
                'limits.total_candidates': num(limitsDraft.totalCandidates, 40),
                'limits.reads_max': num(limitsDraft.readsMax, 20),
                'limits.per_source_limit': num(limitsDraft.perSourceLimit, 30),
                'limits.snippet_chars': num(limitsDraft.snippetChars, 800),
              }, false, false),
            }, busy === 'scout-save' ? '写入中…' : '保存采集源与限额'))) : null,
        el('p', { className: 'scout-note' }, '只改白名单字段；深层结构（关键词组等）不会被动。写入前自动备份，写后校验，失败回滚。'))

      const conflictBar = conflict ? el('div', { className: 'scout-conflict' },
        el('span', null, 'config.yaml 已被手工修改，是否覆盖？'),
        el('button', { className: 'scout-btn danger', onClick: () => saveScout(conflict.set, conflict.deleteFocus, true) }, '覆盖'),
        el('button', { className: 'scout-btn', onClick: () => { setConflict(null); setFlash('已放弃覆盖，文件未变') } }, '放弃')) : null

      const channelsPanel = el('div', { className: 'scout-card' },
        el('h4', null, '分发渠道（可增删多条）'),
        el('p', { className: 'scout-note' }, '飞书用自定义机器人；通用 Webhook 直接 POST JSON。Webhook 默认掩码。'),
        channels.length === 0 ? el('p', { className: 'scout-p' }, '还没有渠道。点下面「新增渠道」。') : null,
        channelConfirm ? el('div', { className: 'scout-conflict' },
          el('span', null, `有 ${channelConfirm.length} 个渠道 URL 是飞书机器人但类型是通用 Webhook，消息会发不出去。仍要保存吗？`),
          el('button', { className: 'scout-btn danger', onClick: () => saveChannels(true) }, '仍然保存'),
          el('button', { className: 'scout-btn', onClick: () => setChannelConfirm(null) }, '取消')) : null,
        channels.map((channel, index) => el('div', { className: 'scout-card', key: index },
          el('div', { className: 'scout-row' },
            el('label', null, '类型'),
            el('select', { className: 'scout-sel', value: channel.type || 'feishu', onChange: (e) => patch((d) => { d.channels[index].type = e.target.value }) },
              el('option', { value: 'feishu' }, '飞书自定义机器人'), el('option', { value: 'webhook' }, '通用 Webhook')),
            el('label', null, '名称'),
            el('input', { className: 'scout-in', value: channel.name || '', onChange: (e) => patch((d) => { d.channels[index].name = e.target.value }) }),
            el('label', null, '启用'),
            el('input', { type: 'checkbox', checked: channel.enabled !== false, onChange: (e) => patch((d) => { d.channels[index].enabled = e.target.checked }) })),
          el('div', { className: 'scout-row' },
            el('label', null, 'Webhook'),
            el('input', {
              className: 'scout-in scout-mask', type: reveal['ch' + index] ? 'text' : 'password',
              value: channel.url || '', placeholder: 'https://…',
              onChange: (e) => patch((d) => { d.channels[index].url = e.target.value }),
            }),
            el('button', { className: 'scout-btn', onClick: () => setReveal((prev) => ({ ...prev, ['ch' + index]: !prev['ch' + index] })) }, reveal['ch' + index] ? '隐藏' : '显示')),
          channelTypeMismatch(channel) ? el('div', { className: 'scout-conflict' },
            el('span', null, 'URL 是飞书机器人但类型是通用 Webhook，消息会发不出去'),
            el('button', {
              className: 'scout-btn primary',
              onClick: () => { setChannelConfirm(null); patch((d) => { d.channels[index].type = 'feishu' }) },
            }, '改为飞书类型'),
            el('span', { className: 'scout-note' }, '飞书类型支持签名 secret；通用 headers 字段将隐藏')) : null,
          el('div', { className: 'scout-row' },
            el('label', null, '单轮上限'),
            el('input', { className: 'scout-in', type: 'number', min: 1, value: channel.limit ?? 20, onChange: (e) => patch((d) => { d.channels[index].limit = num(e.target.value, 20) }) }),
            el('label', null, '关键词'),
            el('input', { className: 'scout-in', value: channel.keyword || '情报', onChange: (e) => patch((d) => { d.channels[index].keyword = e.target.value }) }),
            channel.type === 'webhook' ? el('input', {
              className: 'scout-in', placeholder: '自定义 header JSON（可选）', value: channel.headers || '',
              onChange: (e) => patch((d) => { d.channels[index].headers = e.target.value }),
            }) : el('input', {
              className: 'scout-in', type: 'password', placeholder: '签名校验 secret（可选）', value: channel.secret || '',
              onChange: (e) => patch((d) => { d.channels[index].secret = e.target.value }),
            })),
          el('div', { className: 'scout-row' },
            el('button', { className: 'scout-btn', disabled: busy === 'test:' + index, onClick: () => testChannel(index, channel.name || '') }, busy === 'test:' + index ? '发送中…' : '测试'),
            el('button', { className: 'scout-btn danger', onClick: () => patch((d) => { d.channels.splice(index, 1) }) }, '删除'),
            testResult['ch' + index]?.text ? el('span', { className: 'scout-note', style: { whiteSpace: 'pre-wrap' } }, testResult['ch' + index].text) : null))),
        el('div', { className: 'scout-row' },
          el('button', { className: 'scout-btn', onClick: () => patch((d) => { d.channels.push({ name: '新渠道', type: 'feishu', url: '', enabled: true, keyword: '情报', secret: '', headers: '', limit: 20 }) }) }, '新增渠道'),
          el('button', { className: 'scout-btn primary', disabled: busy === 'save', onClick: () => saveChannels(false) }, busy === 'save' ? '保存中…' : '保存渠道')))

      const secretField = (key, label, field, placeholder, guide) => {
        const info = credInfo(field)
        const configured = !!info?.effective
        const statusLabel = !info ? '状态未知' : configured ? '已配置（设置页）' : '未配置'
        const placeholderText = configured ? '已配置（••••）' : (placeholder || '未配置')
        const canClear = !!info?.settings
        const shown = !!reveal['sec:' + field]
        // 输入框独占一行；按钮 + 状态标签在下一行，窄窗口自动换行。
        const rowEl = el('div', { className: 'scout-secret', key },
          el('label', null, label),
          el('input', {
            className: 'scout-in scout-mask scout-secret-input', type: shown ? 'text' : 'password',
            placeholder: placeholderText,
            value: secretInput[field] || '',
            onChange: (e) => {
              const value = e.target.value
              rememberSecret(field, value)
              setSecretInput((prev) => ({ ...prev, [field]: value }))
            },
          }),
          el('div', { className: 'scout-secret-actions' },
            el('button', {
              className: 'scout-btn', disabled: busy === 'reveal:' + key,
              onClick: async () => {
                if (shown) { setReveal((prev) => ({ ...prev, ['sec:' + field]: false })); return }
                if (!secretInput[field]) {
                  setBusy('reveal:' + key)
                  const res = await call('/scout-secret-reveal ' + field)
                  setBusy('')
                  if (!res?.ok) { setFlash(res?.error || '读取明文失败'); return }
                  const value = String(res.value ?? '')
                  if (!value) { setFlash('后端没有可回显的明文'); return }
                  rememberSecret(field, value)
                  setSecretInput((prev) => ({ ...prev, [field]: value }))
                }
                setReveal((prev) => ({ ...prev, ['sec:' + field]: true }))
              },
            }, shown ? '隐藏' : '显示'),
            el('button', {
              className: 'scout-btn primary', disabled: busy === 'save',
              onClick: async () => {
                const value = secretInput[field]
                if (!value) { setFlash('先填入值再保存'); return }
                const ok = await savePlugin([{ op: 'set', path: ['credentials', field], value }], 'save')
                if (ok) {
                  // 保存后保留输入值（默认仍打码），并与后端实际存储值保持一致。
                  rememberSecret(field, value)
                  setSecretInput((prev) => ({ ...prev, [field]: value }))
                }
              },
            }, '保存'),
            el('button', {
              className: 'scout-btn', disabled: !canClear || busy === 'save',
              onClick: async () => {
                const ok = await savePlugin([{ op: 'unset', path: ['credentials', field] }], 'save')
                if (!ok) return
                forgetSecret(field)
                setSecretInput((prev) => {
                  const next = { ...prev }
                  delete next[field]
                  return next
                })
                setReveal((prev) => ({ ...prev, ['sec:' + field]: false }))
                const latest = credStatusRef.current?.[field] || null
                if (latest?.snippet && !latest?.settings) {
                  setFlash('已清空设置页凭据（snippet 里的旧值不会再被插件使用）')
                } else if (!latest?.effective) {
                  setFlash('已清空设置页凭据')
                }
              },
            }, '清空'),
            el('button', { className: 'scout-btn', disabled: busy === 'check:' + key, onClick: () => checkCredential(key) }, busy === 'check:' + key ? '校验中…' : '校验'),
            el('span', { className: 'scout-note' }, statusLabel),
            testResult[key]?.text ? el('span', { className: 'scout-note' }, testResult[key].text) : null))
        if (!guide) return rowEl
        return el('div', { className: 'scout-secret-wrap', key: key + '-wrap' },
          rowEl,
          el('div', { className: 'scout-row' },
            guide.href
              ? el('a', { href: guide.href, target: '_blank', rel: 'noopener noreferrer', title: guide.href, className: 'scout-note' }, '获取方法 → ' + guide.text)
              : null,
            guide.note ? el('span', { className: 'scout-note' }, guide.note) : null))
      }

      const legacyFields = [
        ['githubToken', 'GitHub token'],
        ['deepseekApiKey', 'DeepSeek API Key'],
        ['biliSessdata', 'B站 SESSDATA'],
        ['feishuWebhook', '飞书 Webhook'],
      ].filter(([field]) => credInfo(field)?.snippet && !credInfo(field)?.settings)
      const migrationBar = legacyFields.length > 0 ? el('div', { className: 'scout-migrate' },
        el('div', null, el('b', null, '检测到 snippet 文件里有一套旧凭据（不会再用），可一键导入。')),
        el('div', { className: 'scout-note' }, '旧值：' + legacyFields.map(([, label]) => label).join('、') + '。snippet 文件本身不会被修改或删除。'),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn primary', disabled: !!busy,
            onClick: () => importSnippet(false),
          }, busy === 'import' ? '导入中…' : '导入到设置页'),
          el('button', {
            className: 'scout-btn', disabled: !!busy,
            onClick: () => importSnippet(true),
          }, busy === 'import-save' ? '导入并保存中…' : '全部导入并保存')),
        el('div', { className: 'scout-note' }, '「导入到设置页」只填入输入框，需逐项点「保存」确认；「全部导入并保存」会逐个写入并校验。')) : null

      const credentialsPanel = el('div', { className: 'scout-card' },
        el('h4', null, '凭据'),
        el('p', { className: 'scout-note' }, '设置页是凭据的唯一来源；默认隐藏，点「显示」查看明文（明文会出现在当前会话记录里，仅本机可见）。校验与工具返回值仍脱敏。'),
        migrationBar,
        secretField('github', 'GitHub token', 'githubToken', 'ghp_… / github_pat_…', {
          href: 'https://github.com/settings/tokens',
          text: '选 Tokens (classic) → Generate new token (classic)；权限勾选框一个都不用勾（scout 只搜公开仓库，token 仅用于提升搜索限流），Expiration 按需选择',
        }),
        secretField('deepseek', 'DeepSeek API Key', 'deepseekApiKey', 'sk-…', {
          href: 'https://platform.deepseek.com/api_keys',
          text: 'DeepSeek 开放平台 → API Keys → 创建 Key（只显示一次）',
        }),
        secretField('bili', 'B站 SESSDATA', 'biliSessdata', '可选', {
          note: '拿法：电脑浏览器登录 B 站 → 按 F12 → 应用/存储 → Cookies → .bilibili.com → 找到 SESSDATA 复制它的值（值里有逗号，整段原样复制，不要加引号）',
        }),
        el('div', { className: 'scout-row' },
          el('label', null, 'ECS 同步'),
          el('input', { type: 'checkbox', checked: !!draft.credentials.ecsEnabled, onChange: (e) => patch((d) => { d.credentials.ecsEnabled = e.target.checked }) }),
          el('span', { className: 'scout-note' }, '可选；关闭不影响日报')),
        el('div', { className: 'scout-row' },
          el('label', null, 'host'),
          el('input', { className: 'scout-in', value: draft.credentials.ecsHost || '', onChange: (e) => patch((d) => { d.credentials.ecsHost = e.target.value }) }),
          el('label', null, 'user'),
          el('input', { className: 'scout-in', value: draft.credentials.ecsUser || '', onChange: (e) => patch((d) => { d.credentials.ecsUser = e.target.value }) })),
        el('div', { className: 'scout-row' },
          el('label', null, '私钥路径'),
          el('input', { className: 'scout-in', value: draft.credentials.ecsKeyPath || '', onChange: (e) => patch((d) => { d.credentials.ecsKeyPath = e.target.value }) }),
          el('button', { className: 'scout-btn', disabled: busy === 'check:ecs', onClick: () => checkCredential('ecs') }, busy === 'check:ecs' ? '校验中…' : '校验'),
          testResult.ecs?.text ? el('span', { className: 'scout-note' }, testResult.ecs.text) : null),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn primary', disabled: busy === 'save',
            onClick: () => savePlugin([
              { op: 'set', path: ['credentials', 'ecsEnabled'], value: !!draft.credentials.ecsEnabled },
              { op: 'set', path: ['credentials', 'ecsHost'], value: String(draft.credentials.ecsHost || '') },
              { op: 'set', path: ['credentials', 'ecsUser'], value: String(draft.credentials.ecsUser || '') },
              { op: 'set', path: ['credentials', 'ecsKeyPath'], value: String(draft.credentials.ecsKeyPath || '') },
            ]),
          }, '保存 ECS 设置')))

      const schedNow = resolveScheduleView({ status: schedStatus, rowValue: row?.value, rowLoaded: !!row, fallbackTime: draft.schedule?.time })
      const schedNext = schedNow.nextFireAt && schedNow.enabled
        ? `下次 ${new Date(schedNow.nextFireAt).toLocaleString('zh-CN', { hour12: false })}`
        : ''
      const schedLine = !schedNow.known
        ? '正在读取定时状态…（需要在左侧打开一个会话；也可以点下面的「刷新状态」）'
        : schedNow.enabled
          ? `当前配置：已开启，每天 ${schedNow.time} 自动跑（DSH 在线才触发${schedNext ? `，${schedNext}` : ''}）。`
          : '当前配置：已关闭 —— 宿主进程里的定时器没挂上，到点不会自动跑。勾上「启用」再点「保存定时」，一分钟内会挂上。'
      const schedulePanel = el('div', { className: 'scout-card' },
        el('h4', null, '定时'),
        el('p', { className: schedNow.enabled ? 'scout-ok' : (schedNow.known ? 'scout-err' : 'scout-note') }, schedLine),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn',
            onClick: () => { void loadScheduleStatus() },
          }, '刷新状态'),
          el('span', { className: 'scout-note' }, schedNow.source === 'host'
            ? `来源：宿主定时器自报${schedNow.nextFireAt ? '' : '（未挂表）'}`
            : schedNow.source === 'settings' ? '来源：插件配置（宿主命令未取到）' : '来源：还没取到')),
        el('div', { className: 'scout-row' },
          el('label', null, '启用'),
          el('input', { type: 'checkbox', checked: !!draft.schedule.enabled, onChange: (e) => patch((d) => { d.schedule.enabled = e.target.checked }) })),
        el('div', { className: 'scout-row' },
          el('label', null, '时间'),
          el('input', {
            className: 'scout-in', type: 'time', value: draft.schedule.time || '19:00',
            onChange: (e) => {
              const value = e.target.value
              patch((d) => { d.schedule.time = value })
              setSourcesDraft((prev) => (prev ? { ...prev, runTime: value } : prev))
            },
          }),
          el('label', null, '时区'),
          el('input', { className: 'scout-in', value: draft.schedule.timeZone || TZ, onChange: (e) => patch((d) => { d.schedule.timeZone = e.target.value }) })),
        el('div', { className: 'scout-row' },
          el('label', null, '默认 force'),
          el('input', { type: 'checkbox', checked: !!draft.schedule.force, onChange: (e) => patch((d) => { d.schedule.force = e.target.checked }) }),
          el('span', { className: 'scout-note' }, 'force = 跳过峰时闸门')),
        el('p', { className: 'scout-note' }, '插件在 DSH 宿主进程内注册定时：DSH 在线才触发，不需要会话。保存时间会同时写回 scout/config.yaml 的 run.time（白名单字段）。'),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn primary', disabled: busy === 'save',
            onClick: async () => {
              const ok = await savePlugin([{ op: 'set', path: ['schedule'], value: draft.schedule }])
              if (ok) {
                refreshScheduleSoon()
                await saveScout({ 'run.time': String(draft.schedule.time || '19:00') }, false, false)
                refreshScheduleSoon()
              }
            },
          }, '保存定时')))

      const dangerPanel = el('div', { className: 'scout-card' },
        el('h4', null, '危险区'),
        el('div', { className: 'scout-row' },
          el('button', {
            className: 'scout-btn danger', disabled: busy === 'save',
            onClick: () => savePlugin([
              { op: 'unset', path: ['credentials', 'githubToken'] },
              { op: 'unset', path: ['credentials', 'deepseekApiKey'] },
              { op: 'unset', path: ['credentials', 'biliSessdata'] },
            ]),
          }, '清空所有凭据'),
          el('button', {
            className: 'scout-btn danger', disabled: busy === 'save',
            onClick: async () => {
              const ok = await savePlugin([
                { op: 'unset', path: ['channels'] },
                { op: 'unset', path: ['schedule'] },
                { op: 'unset', path: ['credentials'] },
                { op: 'unset', path: ['ui'] },
              ])
              if (ok) refreshScheduleSoon()
            },
          }, '恢复默认（插件配置）'),
          el('button', {
            className: 'scout-btn',
            onClick: () => {
              const copy = JSON.parse(JSON.stringify(draft))
              delete copy.credentials
              copy.channels = (copy.channels || []).map((c) => ({ ...c, url: c.url ? '***' : '', secret: '' }))
              const blob = new Blob([JSON.stringify({ plugin: copy, scout: scout?.values || null }, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = 'scout-config-export.json'
              a.click()
              setTimeout(() => URL.revokeObjectURL(url), 1000)
            },
          }, '导出配置（不含密钥）')),
        el('p', { className: 'scout-note' }, '本版不再生成 ~/.dsh/scout/；scout 的备份在 scout/data/backups/（最多 20 份）。'))

      return el('div', { className: 'scout-section' },
        el('h3', { className: 'scout-h' }, '情报员日报'),
        el('p', { className: 'scout-p' }, '工具跑日报，这个页面负责配置。改完即时生效；与 scout 有关的字段直接写回 scout/config.yaml。'),
        costCard,
        noSession,
        conflictBar,
        flash ? el('div', { className: flash.includes('失败') || flash.startsWith('错误') ? 'scout-err' : 'scout-ok' }, flash) : null,
        scoutError ? el('div', { className: 'scout-err' }, scoutError) : null,
        el('div', { className: 'scout-tabs' },
          tabBtn('overview', '待办'), tabBtn('sources', '采集源与重点'), tabBtn('channels', '渠道'),
          tabBtn('credentials', '凭据'), tabBtn('schedule', '定时'), tabBtn('danger', '危险区')),
        el('div', { ref: panelRef, 'data-scout-tab': tab },
          tab === 'overview' ? todoPanel : null,
          tab === 'sources' ? sourcesPanel : null,
          tab === 'channels' ? channelsPanel : null,
          tab === 'credentials' ? credentialsPanel : null,
          tab === 'schedule' ? schedulePanel : null,
          tab === 'danger' ? dangerPanel : null))
    }

    // 注册选项只建一次：即使宿主因声明变化再次执行 inject 回调，也不会换出一个新对象。
    const SECTION = Object.freeze({
      name: 'settings.section',
      id: 'scout',
      order: 40,
      label: '情报员日报',
    })

    function apply(ctx) {
      // 只在这里读一次：Cordis 的 ctx 服务读取每次返回新的 traceable Proxy。
      runtimeRemote = ctx.remote
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-plugin-scout'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'scout: styles')
      ctx.slots.inject('settings.section', () => ctx.slots.register(SECTION, ScoutSection))
    }

    return {
      inject: ['slots', 'remote', 'remote.settings', 'remote.commands'],
      apply,
      __test: {
        priceState, localParts, activeFocus, readTab, writeTab, SECTION, ScoutSection,
        keywordsToText, parseKeywords, subtitleMode, intIn, costNote, scheduleState, resolveScheduleView,
        createLoadGuard, MIN_LOAD_INTERVAL_MS, cacheKeyOf,
        parseCommandResponse, draftsFromScoutResult, writeScoutCacheFromResult, commitScoutLoadResult,
        invalidateScoutCache, beginScoutSeq, isLatestScoutSeq,
        rememberSecret, forgetSecret, rememberedSecrets,
        // 供测试在模块间共享的闸门/缓存上做断言。
        loadGuard, scoutLoadCache, scoutLoadSeq, readScoutCache, writeScoutCache, secretValueCache,
      },
    }
  },
})
