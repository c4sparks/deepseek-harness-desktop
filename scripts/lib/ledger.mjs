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

/** appVersion 降序比较（0.10.0 > 0.2.0），用于 ledger 最新 app 版本置顶。 */
export function cmpAppVersionDesc(a, b) {
  const pa = String(a.appVersion || '').split('-')[0].split('.').map(Number)
  const pb = String(b.appVersion || '').split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * upsert + merge：同 channel + dshVersion 只保留一条。
 * 新条目字段覆盖旧条目、缺失字段保留——build-closure 写的富条目（packages 等）不会被
 * package-sidecar 的精简条目覆盖。按 appVersion 降序，最新 app 版本置顶。
 * @returns 总条数
 */
export function appendLedger(entry) {
  let ledger = []
  try { ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) } catch { /* 首次 */ }
  if (!Array.isArray(ledger)) ledger = []
  const idx = ledger.findIndex((e) => e.channel === entry.channel && e.dshVersion === entry.dshVersion)
  if (idx >= 0) ledger[idx] = { ...ledger[idx], ...entry }
  else ledger.push(entry)
  ledger.sort(cmpAppVersionDesc)
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  return ledger.length
}
