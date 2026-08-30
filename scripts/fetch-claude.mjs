#!/usr/bin/env node
/**
 * On-demand Claude Code binary installer for dsh desktop.
 *
 * Why: the Claude Agent SDK's platform binary (claude.exe, ~253MB) is NOT
 * bundled into the installer (see pruneNativeCrossPlatform in
 * package-sidecar.mjs). The `dsh-subagent-claude-code` plugin resolves `claude`
 * from PATH and hands it to the SDK as `pathToClaudeCodeExecutable` — so the
 * feature works whenever a real `claude` executable is on PATH. This script
 * installs one into `~/.dsh/bin` on demand, for machines that don't already
 * have Claude Code.
 *
 * Note: the SDK requires a real executable (a `.cmd`/`.bat` npm shim fails with
 * spawn EINVAL on Windows). Placing the platform binary at `~/.dsh/bin` and
 * putting that directory FIRST on PATH makes `claude.exe` win over any
 * `claude.cmd` shim.
 *
 * 探测优先：PATH 上已有**真实 claude**（跳过 .cmd/.bat shim）→ 直接用用户的，不重复下载、不遮蔽。
 * 仅当 PATH 上确实没有可用 claude 时才装到 ~/.dsh/bin。
 *
 * Usage:
 *   node scripts/fetch-claude.mjs            # 探测 → 有则跳过，无则装
 *   node scripts/fetch-claude.mjs --auto     # 静默（供后台/启动调用）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NPM_REGISTRY } from './lib/registry.mjs'
import { info, error } from './lib/log.mjs'

const PLATFORM_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const BIN_NAME = process.platform === 'win32' ? 'claude.exe' : 'claude'
const TARGET_DIR = join(homedir(), '.dsh', 'bin')
const TARGET = join(TARGET_DIR, BIN_NAME)
const STAGE = join(homedir(), '.dsh', '.claude-stage')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

/** PATH 上找真实 claude（跳过 .cmd/.bat/.ps1 shim，Windows where 会列出所有匹配）。 */
function findRealClaude() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return null
  const hit = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    .find((p) => !/\.(cmd|bat|ps1)$/i.test(p) && existsSync(p))
  return hit || null
}

function main() {
  const auto = process.argv.includes('--auto')
  const emit = (fn, msg) => { fn('claude', msg); if (!auto) console.log(`[claude] ${msg}`) }

  // 1) PATH 上已有真实 claude → 用用户的，不重复下载、不遮蔽。
  const existing = findRealClaude()
  if (existing) {
    emit(info, `检测到系统已有 claude：${existing}，跳过`)
    return 0
  }

  // 2) ~/.dsh/bin 已装过 → 跳过。
  if (existsSync(TARGET)) {
    emit(info, `已存在，跳过：${TARGET}`)
    return 0
  }

  // 3) 下载安装到 ~/.dsh/bin。
  emit(info, '开始下载')
  try {
    rmSync(STAGE, { recursive: true, force: true })
    mkdirSync(STAGE, { recursive: true })
    run('npm', ['install', '--no-audit', '--no-fund', '--registry', NPM_REGISTRY, '--prefix', STAGE, PLATFORM_PKG])
    const src = join(STAGE, 'node_modules', ...PLATFORM_PKG.split('/'), BIN_NAME)
    if (!existsSync(src)) throw new Error(`binary not found after install: ${src}`)
    mkdirSync(TARGET_DIR, { recursive: true })
    cpSync(src, TARGET)
    if (process.platform !== 'win32') chmodSync(TARGET, 0o755)
    rmSync(STAGE, { recursive: true, force: true })
    emit(info, '下载完成')
  } catch (e) {
    emit(error, `下载失败：${e.message}`)
    throw e
  }
  if (!auto) {
    console.log(`把 ${TARGET_DIR} 加到 PATH 最前，dsh 就能解析到 claude：`)
    if (process.platform === 'win32') {
      console.log(`  在"系统属性→环境变量"里把 ${TARGET_DIR} 放到 Path 最前`)
    } else {
      console.log(`  export PATH="${TARGET_DIR}:$PATH"   # 写入 ~/.bashrc 或 ~/.zshrc`)
    }
  }
  return 0
}

process.exitCode = main()
