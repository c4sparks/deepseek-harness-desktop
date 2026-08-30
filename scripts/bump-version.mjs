#!/usr/bin/env node
/**
 * bump-version.mjs — 同步本项目的应用版本号（与 dsh 依赖升级解耦）。
 *
 * 同步 4 处：package.json / native/tauri.conf.json / native/Cargo.toml / native/Cargo.lock。
 * 降级保护：新版本**低于**当前版本 → 警告 + 输入 `yes` 确认；非交互默认拒绝，加 `--yes` 放行。
 *
 * 用法：
 *   node scripts/bump-version.mjs <新版本>            # 同步 4 处
 *   node scripts/bump-version.mjs <新版本> --dry-run  # 预览，不写入
 *   node scripts/bump-version.mjs <新版本> --yes      # 非交互/跳过降级确认
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 版本格式：x.y.z 必填，预发布后缀可选（-rc.N / -alpha.N / -beta.N）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 版本比较：a < b → -1（忽略预发布后缀，只比数字段）。 */
function cmpVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map(Number)
  const pb = String(b).split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--yes')
  const newVer = args.find((a) => !a.startsWith('--'))
  if (!newVer) {
    console.error('用法: node scripts/bump-version.mjs <新版本> [--dry-run] [--yes]')
    return 2
  }
  if (!VERSION_RE.test(newVer)) {
    console.error(`✗ 非法版本 ${newVer}，应为 x.y.z（可带 -rc.N / -alpha.N / -beta.N），如 0.2.1 或 0.2.0-rc.1`)
    return 1
  }

  const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

  // 降级保护：新版本 < 当前 → 默认拦，输入 yes 才放行（防手滑写低）。
  if (cmpVersions(newVer, current) < 0) {
    if (force) {
      console.log(`--yes：放行降级 ${current} → ${newVer}`)
    } else if (!process.stdin.isTTY) {
      console.warn(`⚠ 新版本 ${newVer} 低于当前 ${current}（降级）；非交互环境拒绝，确需降级加 --yes`)
      return 1
    } else {
      console.warn(`⚠ 新版本 ${newVer} 低于当前 ${current}（降级）`)
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const ans = (await rl.question('  确认降级？输入 yes 继续（其他取消）: ')).trim().toLowerCase()
      rl.close()
      if (ans !== 'yes') {
        console.error('  已取消')
        return 0
      }
    }
  }

  const edits = []

  // 1) package.json
  const pkgPath = join(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  if (pkg.version !== newVer) edits.push({ file: 'package.json', from: pkg.version, to: newVer })
  pkg.version = newVer
  if (!dryRun) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 2) native/tauri.conf.json
  const confPath = join(ROOT, 'native', 'tauri.conf.json')
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  if (conf.version !== newVer) edits.push({ file: 'native/tauri.conf.json', from: conf.version, to: newVer })
  conf.version = newVer
  if (!dryRun) writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8')

  // 3) native/Cargo.toml — 第一个顶层 `version = "…"`（[package] 那个）
  const cargoPath = join(ROOT, 'native', 'Cargo.toml')
  const cargo = readFileSync(cargoPath, 'utf8')
  const cm = /^version\s*=\s*"([^"]+)"/m.exec(cargo)
  if (cm && cm[1] !== newVer) edits.push({ file: 'native/Cargo.toml', from: cm[1], to: newVer })
  if (!dryRun) writeFileSync(cargoPath, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVer}"`), 'utf8')

  // 4) native/Cargo.lock — 根包版本（cargo 也会自行重生成）
  const lockPath = join(ROOT, 'native', 'Cargo.lock')
  const lock = readFileSync(lockPath, 'utf8')
  const lm = new RegExp(`name = "${pkg.name}"\\nversion = "([^"]+)"`).exec(lock)
  if (lm && lm[1] !== newVer) edits.push({ file: 'native/Cargo.lock', from: lm[1], to: newVer })
  if (!dryRun && lm) {
    writeFileSync(
      lockPath,
      lock.replace(new RegExp(`name = "${pkg.name}"\\nversion = "[^"]+"`), `name = "${pkg.name}"\nversion = "${newVer}"`),
      'utf8',
    )
  }

  if (edits.length === 0) {
    console.log(`bump-version: ${newVer} already in place`)
    return 0
  }
  console.log(`bump-version: ${edits.length} file(s) -> ${newVer}`)
  for (const e of edits) console.log(`  ${e.file}  ${e.from} -> ${e.to}`)
  if (dryRun) {
    console.log('\nbump-version: --dry-run, nothing written')
    return 0
  }
  console.log('\nbump-version: done')
  return 0
}

process.exitCode = await main()
