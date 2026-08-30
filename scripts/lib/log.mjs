/**
 * log.mjs — 标准运行日志（~/.dsh/logs/desktop.log）。
 *
 * 格式：[YYYY-MM-DD HH:MM:SS] [LEVEL] 组件: 消息
 * LEVEL: INFO / WARN / ERROR。后台下载 / 配置等操作（fetch-claude / fetch-codex）即使 --auto
 * 静默也写日志，方便排查"下载/配置到底正不正常"。Rust 壳的关键事件也写这里。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DESKTOP_LOG = join(homedir(), '.dsh', 'logs', 'desktop.log')

/** 标准格式日志：`[YYYY-MM-DD HH:MM:SS] [LEVEL] 组件: 消息`；写失败静默忽略。 */
export function log(level, component, message) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const line = `[${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] [${level}] ${component}: ${message}\n`
  try {
    mkdirSync(dirname(DESKTOP_LOG), { recursive: true })
    appendFileSync(DESKTOP_LOG, line)
  } catch { /* 忽略 */ }
}

export const info = (component, message) => log('INFO', component, message)
export const warn = (component, message) => log('WARN', component, message)
export const error = (component, message) => log('ERROR', component, message)
