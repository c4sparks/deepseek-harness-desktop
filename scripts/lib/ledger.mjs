/**
 * ledger.mjs — dsh-releases.json 版本 ledger 的公共读写。
 *
 * 供 build-closure.mjs（生成闭包时记富条目）与 package-sidecar.mjs（打包时兜底记）共用，
 * 保证约束单一来源：同 channel + dshVersion 只保留一条（upsert + merge）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LEDGER_PATH = join(ROOT, 'scripts', 'dsh-releases.json')

/** 条目的"记录时间"排序键：recordedAt（写入时的精确时刻）优先，历史条目（无该字段）
 *  回退 appBuiltAt → dshPublishedAt；全部缺失视为最旧。ISO 字符串可字典序比较。 */
function recency(e) {
  return e.recordedAt || e.appBuiltAt || e.dshPublishedAt || ''
}

/** 记录时间降序：最近一次构建/记录的条目置顶（rc/补丁版本号与时间错位不影响）。 */
export function cmpRecordedDesc(a, b) {
  const ta = recency(a)
  const tb = recency(b)
  if (ta === tb) return 0
  if (!ta) return 1
  if (!tb) return -1
  return ta < tb ? 1 : -1
}

/**
 * upsert + merge：同 channel + dshVersion 只保留一条。
 * 新条目字段覆盖旧条目、缺失字段保留——build-closure 写的富条目（packages 等）不会被
 * package-sidecar 的精简条目覆盖。每次写入都会盖 recordedAt（UTC ISO 精确时刻）作为
 * 排序键，按记录时间降序、最新构建置顶——不按 appVersion 排（预发布/补丁会与时间错位）。
 * @returns 总条数
 */
export function appendLedger(entry) {
  let ledger = []
  try { ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) } catch { /* 首次 */ }
  if (!Array.isArray(ledger)) ledger = []
  const idx = ledger.findIndex((e) => e.channel === entry.channel && e.dshVersion === entry.dshVersion)
  const rec = { ...entry, recordedAt: new Date().toISOString() }
  if (idx >= 0) ledger[idx] = { ...ledger[idx], ...rec }
  else ledger.push(rec)
  ledger.sort(cmpRecordedDesc)
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  return ledger.length
}
