#!/usr/bin/env node
/**
 * On-demand Codex binary installer for dsh desktop.
 *
 * Why: the Codex platform binary (`@openai/codex-<platform>-<arch>`, ~374MB) is NOT
 * bundled into the installer (see apply-codex-shrink.mjs, which prunes the platform
 * packages). The desktop shell sets `CODEX_BIN` for the sidecar, and dsh-subagent-codex
 * honors it via a one-line patch (see apply-codex-shrink.mjs). This script downloads
 * the platform package on demand and installs the **whole package** to `~/.dsh/codex/`
 * (preserves the vendor/ tree so codex can find its sibling binaries: sandbox, ripgrep,
 * command-runner).
 *
 * 平台二进制不是独立 npm 包：装 @openai/codex 包装，其 optionalDependencies 会经别名
 * （npm:@openai/codex@<v>-<platform>）连带装平台包 @openai/codex-<platform>-<arch>。
 * 复制整个平台包（含 vendor/）→ ~/.dsh/codex/，CODEX_BIN 指向其中的 codex 二进制。
 *
 * 探测优先：CODEX_BIN 或 ~/.dsh/codex 已存在 → 跳过。仅当缺失才下载。
 *
 * Usage:
 *   node scripts/fetch-codex.mjs            # 探测 → 有则跳过，无则装
 *   node scripts/fetch-codex.mjs --auto     # 静默（供后台/启动调用）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { NPM_REGISTRY } from './lib/registry.mjs'
import { info, error } from './lib/log.mjs'

const INSTALL_PKG = '@openai/codex'
const PLATFORM_DIR = `@openai/codex-${process.platform}-${process.arch}`
const TARGET_DIR = join(homedir(), '.dsh', 'codex')
const STAGE = join(homedir(), '.dsh', '.codex-stage')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

/** 平台包里是否有 vendor/ 树（验证复制完整）。 */
function hasVendorTree(dir) {
  return existsSync(join(dir, 'vendor'))
}

function main() {
  const auto = process.argv.includes('--auto')
  const emit = (fn, msg) => { fn('codex', msg); if (!auto) console.log(`[codex] ${msg}`) }

  // 1) CODEX_BIN 或 ~/.dsh/codex 已有 → 跳过。
  if (process.env.CODEX_BIN && existsSync(process.env.CODEX_BIN)) {
    emit(info, `CODEX_BIN 指向文件已存在，跳过：${process.env.CODEX_BIN}`)
    return 0
  }
  if (existsSync(join(TARGET_DIR, 'package.json'))) {
    emit(info, `已存在，跳过：${TARGET_DIR}`)
    return 0
  }

  // 2) 下载并复制整个平台包到 ~/.dsh/codex/。
  emit(info, '开始下载')
  try {
    rmSync(STAGE, { recursive: true, force: true })
    mkdirSync(STAGE, { recursive: true })
    run('npm', ['install', '--no-audit', '--no-fund', '--registry', NPM_REGISTRY, '--prefix', STAGE, INSTALL_PKG])
    const srcPkg = join(STAGE, 'node_modules', ...PLATFORM_DIR.split('/'))
    if (!existsSync(srcPkg)) throw new Error(`平台包未安装：${PLATFORM_DIR}`)
    rmSync(TARGET_DIR, { recursive: true, force: true })
    mkdirSync(TARGET_DIR, { recursive: true })
    cpSync(srcPkg, TARGET_DIR, { recursive: true })
    if (!hasVendorTree(TARGET_DIR)) throw new Error(`复制不完整：${TARGET_DIR} 缺 vendor/`)
    rmSync(STAGE, { recursive: true, force: true })
    emit(info, '下载完成')
  } catch (e) {
    emit(error, `下载失败：${e.message}`)
    throw e
  }
  return 0
}

process.exitCode = main()
