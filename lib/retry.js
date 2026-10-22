/**
 * 跨零点重试的纯逻辑（无 DSH 依赖，便于单测）。
 *
 * scout 的 write_report 守卫要求 report.date == today；23:58 起跑、00:00 后写稿
 * 会被拒为 stale_date。插件只在“失败日期正好是昨天”时自动用今天重跑一次。
 */

/** YYYY-MM-DD 的前一天；非法输入返回 null。 */
export function previousDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null
  const value = new Date(Date.UTC(year, month - 1, day - 1))
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10)
}

/** 是否满足跨零点重试的三个条件：state/error/date==昨天。 */
export function shouldRetryAfterMidnight(result, today) {
  if (!result || result.state !== 'report_rejected' || result.error !== 'stale_date') return false
  const yesterday = previousDate(today)
  if (!yesterday) return false
  return String(result.date || '') === yesterday
}

/** stale_date 不满足重试条件时的人话错误。 */
export function staleDateMessage(date) {
  return `报告日期 ${date || '未知'} 不是今天，scout 拒收（防陈旧守卫）。补跑需走 catch_up 流程。`
}

/** 给工具/命令返回值附加“跨零点自动重跑”标记。 */
export function retryMetadata(outcome) {
  return outcome?.retried
    ? { retried_after_midnight: true, original_date: outcome.originalDate }
    : {}
}

/**
 * 第一次 run 失败且命中跨零点条件时，用今天重跑一次；绝不递归。
 * run 收到 { ...flags, date }，调用方负责把它翻译成 bridge 参数。
 * @returns {Promise<{result: object, retried: boolean, originalDate: string|null, retryDate: string|null, firstResult: object}>}
 */
export async function runDailyWithMidnightRetry({ run, date, flags = {}, today }) {
  const firstResult = await run({ ...flags, date })
  const currentDate = today()
  if (!shouldRetryAfterMidnight(firstResult, currentDate)) {
    return { result: firstResult, retried: false, originalDate: null, retryDate: null, firstResult }
  }
  const result = await run({ ...flags, date: currentDate })
  return {
    result,
    retried: true,
    originalDate: firstResult.date,
    retryDate: currentDate,
    firstResult,
  }
}
