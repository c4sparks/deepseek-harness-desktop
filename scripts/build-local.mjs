#!/usr/bin/env node
/**
 * build-local.mjs — 本地打包入口：打包前检查 + 确认 + 打包 + 产物验证。
 *
 * **不修改版本号**（bump 由 bump-version.mjs 提前做）。它做的是"值回票价"的活：
 *   - 检查：当前版本 vs CHANGELOG 顶部、4 处版本文件一致性、安装包名预览
 *   - 确认：交互 Y/n（非交互跳过，直接打包）
 *   - 验证：打包后找最新安装包，报路径 + 体积
 *
 * 用法：
 *   node scripts/build-local.mjs            # 检查 + 确认 + 打包 + 验证
 *   node scripts/build-local.mjs --yes      # 跳过确认（CI）
 *   node scripts/build-local.mjs --check-only  # 只检查，不打包
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---- 读取 ----

function pkgVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function tauriVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'native', 'tauri.conf.json'), 'utf8')).version
}

function cargoTomlVersion() {
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'native', 'Cargo.toml'), 'utf8'))
  return m?.[1]
}

function cargoLockVersion() {
  const name = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
  const m = new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(readFileSync(join(ROOT, 'native', 'Cargo.lock'), 'utf8'))
  return m?.[1]
}

/** CHANGELOG 顶部版本（## [x.y.z] 第一处）；文件缺失/不可读返回 null（不崩）。 */
function changelogTopVersion() {
  try {
    const m = /^## \[([^\]]+)\]/m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))
    return m?.[1]
  } catch {
    return null
  }
}

// ---- 检查 ----

/** 返回 { ok, warnings: string[], info: string[] }。 */
function check(v) {
  const warnings = []
  const info = []
  const files = [
    ['package.json', pkgVersion()],
    ['tauri.conf.json', tauriVersion()],
    ['Cargo.toml', cargoTomlVersion()],
    ['Cargo.lock', cargoLockVersion()],
  ]
  const mismatched = files.filter(([, fv]) => fv !== v)
  if (mismatched.length) {
    warnings.push(`版本文件不一致：${files.map(([n, fv]) => `${n}=${fv ?? '?'}`).join('  ')}`)
  } else {
    info.push(`4 处版本文件一致（${v}）`)
  }
  const ch = changelogTopVersion()
  if (ch === null) {
    warnings.push('CHANGELOG.md 缺失（无法校验版本一致性）')
  } else if (ch !== v) {
    warnings.push(`CHANGELOG 顶部版本 [${ch}] ≠ 当前 ${v}（可能漏记/忘 bump）`)
  } else {
    info.push(`CHANGELOG 顶部 [${v}] 一致`)
  }
  return { ok: warnings.length === 0, warnings, info }
}

/** 平台对应的安装包名预览。 */
function installerName(v) {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `deepseek-harness-desktop_${v}_${arch}-setup.exe`
  if (process.platform === 'darwin') return `deepseek-harness-desktop_${v}_${arch}.dmg`
  return `deepseek-harness-desktop_${v}_${arch}.deb`
}

/** 找最新安装包：读 cargo target-dir（含重定向），扫 bundle/nsis。 */
function findInstaller() {
  const cargoConfig = join(ROOT, 'native', '.cargo', 'config.toml')
  let targetDir
  try {
    const t = /target-dir\s*=\s*"?([^"\s]+)"?/.exec(readFileSync(cargoConfig, 'utf8'))
    targetDir = t ? resolve(ROOT, t[1]) : join(ROOT, 'native', 'target')
  } catch {
    targetDir = join(ROOT, 'native', 'target')
  }
  const bundleDir = join(targetDir, 'release', 'bundle', 'nsis')
  if (!existsSync(bundleDir)) return null
  const candidates = readdirSync(bundleDir).filter((f) => f.endsWith('.exe'))
  if (!candidates.length) return null
  const newest = candidates
    .map((f) => ({ f, mtime: statSync(join(bundleDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f
  const sizeMB = (statSync(join(bundleDir, newest)).size / 1024 / 1024).toFixed(1)
  return { path: join(bundleDir, newest), name: newest, sizeMB }
}

// ---- 主流程 ----

async function main() {
  const checkOnly = process.argv.includes('--check-only')
  const skipConfirm = process.argv.includes('--yes') || !process.stdin.isTTY
  const v = pkgVersion()

  console.log(`\n[build-local] 打包前检查（当前版本 ${v}）`)
  const { warnings, info } = check(v)
  for (const i of info) console.log(`  ✓ ${i}`)
  for (const w of warnings) console.log(`  ⚠ ${w}`)
  console.log(`  → 安装包名: ${installerName(v)}`)

  if (warnings.length && !skipConfirm) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = (await rl.question('\n有警告，仍继续打包？[Y/n] ')).trim().toLowerCase()
    rl.close()
    if (ans === 'n' || ans === 'no') {
      console.log('[build-local] 已取消')
      return 0
    }
  } else if (warnings.length) {
    console.log('[build-local] --yes / 非交互：忽略警告继续')
  }

  if (checkOnly) {
    console.log('\n[build-local] --check-only，未打包')
    return 0
  }

  console.log('\n[build-local] 开始打包…')
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', 'npm run build'], { stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { stdio: 'inherit' })
  if (r.error || r.status !== 0) {
    console.error('[build-local] 打包失败')
    process.exit(r.status ?? 1)
  }

  const pkg = findInstaller()
  if (pkg) {
    console.log(`\n[build-local] ✅ 安装包已生成`)
    console.log(`  路径: ${pkg.path}`)
    console.log(`  体积: ${pkg.sizeMB} MB`)
  } else {
    console.error('\n[build-local] ⚠ 未找到安装包（bundle/nsis 下无 .exe），请检查打包输出')
    process.exit(1)
  }
  return 0
}

process.exitCode = await main()
