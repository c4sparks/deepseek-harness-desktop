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
 * Usage:
 *   node scripts/fetch-claude.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PLATFORM_PKG = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`
const BIN_NAME = process.platform === 'win32' ? 'claude.exe' : 'claude'
const TARGET_DIR = join(homedir(), '.dsh', 'bin')
const TARGET = join(TARGET_DIR, BIN_NAME)
const STAGE = join(homedir(), '.dsh', '.claude-stage')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error) throw r.error
  if (r.status !== 0) process.exit(r.status ?? 1)
}

function main() {
  if (existsSync(TARGET)) {
    console.log(`claude already present: ${TARGET}`)
    console.log(`确保 ${TARGET_DIR} 在 PATH 最前（这样 claude.exe 会赢过 claude.cmd shim）`)
    return 0
  }
  console.log(`[fetch-claude] installing ${PLATFORM_PKG} -> ${TARGET}`)
  rmSync(STAGE, { recursive: true, force: true })
  mkdirSync(STAGE, { recursive: true })
  run('npm', ['install', '--no-audit', '--no-fund', '--prefix', STAGE, PLATFORM_PKG])
  const src = join(STAGE, 'node_modules', ...PLATFORM_PKG.split('/'), BIN_NAME)
  if (!existsSync(src)) throw new Error(`binary not found after install: ${src}`)
  mkdirSync(TARGET_DIR, { recursive: true })
  cpSync(src, TARGET)
  if (process.platform !== 'win32') chmodSync(TARGET, 0o755)
  rmSync(STAGE, { recursive: true, force: true })
  console.log(`[fetch-claude] done: ${TARGET}`)
  console.log(`把 ${TARGET_DIR} 加到 PATH 最前，dsh 就能解析到 claude：`)
  if (process.platform === 'win32') {
    console.log(`  在"系统属性→环境变量"里把 ${TARGET_DIR} 放到 Path 最前`)
  } else {
    console.log(`  export PATH="${TARGET_DIR}:$PATH"   # 写入 ~/.bashrc 或 ~/.zshrc`)
  }
  return 0
}

process.exitCode = main()
