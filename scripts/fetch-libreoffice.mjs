#!/usr/bin/env node
/**
 * fetch-libreoffice.mjs — LibreOffice 引擎按需补装（**可移除**）。
 *
 * 为什么：`@deepseek-ai/libreoffice-kit-<platform>` 是上游 0.1.6 起为 office 文档转 PDF
 * （`@deepseek-ai/dsh-document-office-to-pdf`）捆绑的**整套 LibreOffice 引擎**
 * （win32-x64 的 `program/` 约 330MB，压缩后安装包 +87MB）。桌面壳把它剪出安装包
 * （见 package-sidecar.mjs 的 pruneOptionalBulk），由本脚本在首次启动时后台补装。
 *
 * 与 fetch-codex.mjs 的关键差异：codex 装到 `~/.dsh/codex` 并由 `CODEX_BIN` 指路
 * （壳注入 env，上游有一行 patch 配合）；LibreOffice 引擎的路径由上游**内部解析**
 * （`platformTarget()` → `libreoffice-kit-<platform>`，没有任何环境变量可覆盖），
 * 所以本脚本必须**补装回宿主 node_modules 的原位**：
 *   <install>/dsh-host/app/node_modules/@deepseek-ai/libreoffice-kit-<platform>
 * 补回去即恢复功能，**无需 patch 上游**。
 *
 * 探测优先：目标位置已有 package.json → 跳过。仅当缺失才下载（330MB 解压后）。
 * best-effort：失败只记日志（office→PDF 降级为 `ConversionError: unavailable`），
 * 不影响壳与宿主主流程。
 *
 * 移除点（日后不需要该功能 / 上游改为按需下载时）：
 *   1. `scripts/package-sidecar.mjs` 里 pruneOptionalBulk 的调用（或整段）
 *   2. `native/src/lib.rs` maybe_fetch_tools 里本脚本那一项
 *   3. `native/tauri.conf.json` bundle.resources 里本脚本那一行
 *
 * 用法：
 *   node scripts/fetch-libreoffice.mjs          # 探测 → 有则跳过，无则装
 *   node scripts/fetch-libreoffice.mjs --auto   # 静默（供壳启动时后台调用）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NPM_REGISTRY } from './lib/registry.mjs'
import { info, error } from './lib/log.mjs'

/**
 * 上游 `dsh-document-office-to-pdf` 精确锁定的引擎版本（`"0.0.1"`，非 `^`）。
 * **勿改用 latest**：registry 上已有 0.0.3，版本错配会让 createConverter 以
 * 资产校验失败拒绝。
 */
const KIT_VERSION = '0.0.1'
const KIT_PKG = '@deepseek-ai/libreoffice-kit'
const PLATFORM = `${process.platform}-${process.arch}`
const PLATFORM_PKG = `${KIT_PKG}-${PLATFORM}`

/** 本脚本被打到安装包根目录，宿主在 dsh-host/app（见 tauri.conf.json 的 bundle.resources）。 */
const INSTALL_ROOT = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(INSTALL_ROOT, 'dsh-host', 'app')
const TARGET_DIR = join(APP_DIR, 'node_modules', '@deepseek-ai', `libreoffice-kit-${PLATFORM}`)
/** 暂存放 ~/.dsh：安装目录未必可写（如装到 Program Files），家目录一定可写。 */
const STAGE = join(homedir(), '.dsh', '.libreoffice-stage')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

/** 引擎内容校验：上游平台包带 program/（原生引擎）；只有主包/空壳则视为不完整。 */
function hasEngine(programDir) {
  return existsSync(join(programDir, 'program')) || existsSync(join(programDir, 'bin'))
}

/** 上游只发布 macOS / Windows 的原生引擎；Linux 走共享 WASM，无需平台包。 */
function hasNativeKit() {
  return (process.platform === 'win32' || process.platform === 'darwin')
    && (process.arch === 'x64' || process.arch === 'arm64')
}

function main() {
  const auto = process.argv.includes('--auto')
  const emit = (fn, msg) => { fn('libreoffice', msg); if (!auto) console.log(`[libreoffice] ${msg}`) }

  if (!hasNativeKit()) {
    emit(info, `平台 ${PLATFORM} 无原生引擎包（走 WASM），跳过`)
    return 0
  }
  if (!existsSync(APP_DIR)) {
    emit(info, `未找到宿主目录，跳过：${APP_DIR}`)
    return 0
  }
  if (existsSync(join(TARGET_DIR, 'package.json'))) {
    emit(info, `引擎已存在，跳过：${TARGET_DIR}`)
    return 0
  }

  emit(info, `开始下载引擎（${PLATFORM_PKG}@${KIT_VERSION}，解压后约 330MB）`)
  try {
    rmSync(STAGE, { recursive: true, force: true })
    mkdirSync(STAGE, { recursive: true })
    // 装主包即可：其 optionalDependencies 会按当前平台连带装上平台包。
    run('npm', ['install', '--no-audit', '--no-fund', '--registry', NPM_REGISTRY,
      '--prefix', STAGE, `${KIT_PKG}@${KIT_VERSION}`])
    const srcPkg = join(STAGE, 'node_modules', ...PLATFORM_PKG.split('/'))
    if (!existsSync(srcPkg)) throw new Error(`平台包未安装：${PLATFORM_PKG}`)
    if (!hasEngine(srcPkg)) throw new Error(`平台包内容不完整（缺 program/）：${srcPkg}`)

    rmSync(TARGET_DIR, { recursive: true, force: true })
    mkdirSync(dirname(TARGET_DIR), { recursive: true })
    cpSync(srcPkg, TARGET_DIR, { recursive: true })
    if (!hasEngine(TARGET_DIR)) throw new Error(`复制不完整：${TARGET_DIR}`)
    rmSync(STAGE, { recursive: true, force: true })
    emit(info, `引擎已就位：${TARGET_DIR}`)
  } catch (e) {
    // best-effort：宿主照常启动，仅 office→PDF 以 unavailable 降级。
    emit(error, `引擎补装失败（office→PDF 将不可用）：${e.message}`)
  }
  return 0
}

process.exitCode = main()
