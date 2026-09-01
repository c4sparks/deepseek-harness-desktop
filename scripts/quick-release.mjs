#!/usr/bin/env node
/**
 * quick-release.mjs — 一键"只升级 dsh"的快速打包部署脚本。
 *
 * 交互式引导整条固定发版流程，**每一步执行后输出 check 结果、确认后才进下一步，任何一步可中断**：
 * 通道选择用 ↑/↓ 箭头 + 绿色高亮（零依赖 ANSI 选择器 scripts/lib/select.mjs）。
 *
 *   ① 选通道（npm / source）—— 箭头选择
 *   ② 按通道问参数（npm：dsh 版本号；source：本地 dsh 源码路径）
 *   ③ 输应用版本号（默认当前小版本 +1，可自定义）
 *   ④ bump-version 同步 4 处应用版本文件 —— check 4 处一致
 *   ⑤ build-closure 生成依赖闭包 —— check 闭包 dsh 版本正确 + ledger 已记
 *   ⑥ 模板化写 CHANGELOG（同版本覆盖）—— check 顶部版本一致
 *   ⑦ 打印 git commit 提交模板
 *   ⑧ 打包（build-local）—— check 安装包生成
 *
 * 用法：
 *   node scripts/quick-release.mjs -h                 # 帮助
 *   node scripts/quick-release.mjs                    # 交互式
 *   node scripts/quick-release.mjs --dry-run          # 只预览计划，不执行任何命令/写文件
 *   node scripts/quick-release.mjs --yes              # 非交互：跳过确认（值仍需交互或用 flag 提供）
 *   node scripts/quick-release.mjs --channel npm --dsh-version 0.1.2-alpha.3 --app-version 0.2.1 --yes
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline/promises'
import { select } from './lib/select.mjs'
import { startTee } from './lib/tee-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** 小版本 +1：x.y.z → x.y.(z+1)；带预发布后缀先去掉后缀（0.2.1-rc.1 → 0.2.2）。 */
function nextPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''))
  if (!m) return String(v ?? '')
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

// ---- 读取 ----
function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')) }
function pkgVersion() { return readJson(join(ROOT, 'package.json')).version }
function tauriVersion() { return readJson(join(ROOT, 'native', 'tauri.conf.json')).version }
function cargoTomlVersion() {
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(join(ROOT, 'native', 'Cargo.toml'), 'utf8'))
  return m?.[1]
}
function cargoLockVersion() {
  const name = readJson(join(ROOT, 'package.json')).name
  const m = new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(readFileSync(join(ROOT, 'native', 'Cargo.lock'), 'utf8'))
  return m?.[1]
}
function changelogTopVersion() {
  try {
    const m = /^## \[([^\]]+)\]/m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))
    return m?.[1]
  } catch { return null }
}

/** 查询 npm 上 @deepseek-ai/dsh 可用版本（最新在前）；失败/无网络返回 []。 */
function listNpmVersions() {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/d', '/s', '/c', 'node scripts/sync-deps.mjs --list'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
      : spawnSync('node', ['scripts/sync-deps.mjs', '--list'], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 })
    if (r.status !== 0) return []
    // 版本行形如 "  0.1.2-alpha.3  (alpha)" 或 "  0.1.2-alpha.2"——取行首版本号，去重保序
    const versions = [...String(r.stdout).matchAll(/^\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)/gm)].map((m) => m[1])
    return [...new Set(versions)]
  } catch { return [] }
}
function closurePkg() {
  try { return readJson(join(ROOT, 'deepseek-harness', 'package.json')) } catch { return null }
}
function closureVersion() { return closurePkg()?.version ?? null }
function readLedger() {
  try { return readJson(join(ROOT, 'scripts', 'dsh-releases.json')) } catch { return [] }
}
/** 从 ledger 找 某 channel + dshVersion 的条目。 */
function ledgerEntry(channel, dshVersion) {
  return readLedger().find((e) => e.channel === channel && e.dshVersion === dshVersion) ?? null
}

/** 4 处版本文件是否全 == v；返回 [ok, 详情串]。 */
function fourFilesOk(v) {
  const files = [['package.json', pkgVersion()], ['tauri.conf.json', tauriVersion()], ['Cargo.toml', cargoTomlVersion()], ['Cargo.lock', cargoLockVersion()]]
  const bad = files.filter(([, fv]) => fv !== v)
  return [bad.length === 0, bad.length ? `${bad.map(([n, fv]) => `${n}=${fv ?? '?'}`).join('  ')} ≠ ${v}` : `4 处均 ${v}`]
}

// ---- 交互 ----
const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name) => argv.includes(name)
const DRY_RUN = has('--dry-run')
const YES = has('--yes')
const TTY = process.stdin.isTTY
/** 模块级 tee（main 里赋值）：交互输入期间暂停写日志，避免 prompt/输入回显进日志。 */
let logTee = null

/** 文本输入（保留 readline）。问题单独一行，输入另起一行。 */
async function ask(question, { def, flagName } = {}) {
  const flagVal = flagName ? flag(flagName) : undefined
  if (flagVal !== undefined) return flagVal
  if (TTY) {
    const suffix = def !== undefined ? `（默认 ${def}）` : ''
    console.log(`\n${question}${suffix}`)
    logTee?.pause() // 交互期间不写日志
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const ans = (await rl.question('> ')).trim()
    rl.close()
    logTee?.resume()
    return ans === '' && def !== undefined ? def : ans
  }
  if (def !== undefined) return def
  throw new Error(`非交互环境缺参数：${question}（请用 flag 传入）`)
}

/** 箭头选择器：↑/↓ 选择、Enter 确认，选中项绿色高亮。取消返回 null。 */
async function choose(question, choices, { flagName, def = 0 } = {}) {
  const flagVal = flagName ? flag(flagName) : undefined
  if (flagVal !== undefined) return flagVal
  if (!TTY) return choices[def].value
  logTee?.pause() // 选择器重绘不写日志
  const v = await select(question, choices, { default: def })
  logTee?.resume()
  return v
}

/** Y/n 确认：箭头选择（是/否），取消（null）当作否。 */
async function confirm(question, { def = true } = {}) {
  if (YES || !TTY) return def
  logTee?.pause() // 选择器重绘不写日志
  const v = await select(question, [
    { value: true, label: '是（继续）' },
    { value: false, label: '否（停止）' },
  ], { default: def ? 0 : 1 })
  logTee?.resume()
  return v ?? false
}

/** 跑一条 node 脚本命令，返回 exit code。 */
function runNode(script, args, { cwd = ROOT } = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd, stdio: 'inherit' })
  return r.status ?? 1
}

// ---- 平台兼容（win / mac / linux）----
const PLATFORM = process.platform // win32 | darwin | linux

/** 平台可验证性说明（mac/linux 无本机验证，仅按命令走）。 */
function platformNote() {
  if (PLATFORM === 'win32') return 'Windows（NSIS）'
  if (PLATFORM === 'darwin') return 'macOS（dmg）— 未在本机验证'
  return 'Linux（deb / AppImage）— 未在本机验证'
}

/** 各平台打包命令 → { label, run: () => exitCode }。 */
function buildStep() {
  if (PLATFORM === 'win32') {
    return { label: 'build-local（检查 + NSIS 打包）', run: () => runNode('scripts/build-local.mjs', ['--yes']) }
  }
  // mac/linux：build-local 内部走 `npm run build`（bundle.targets 为 nsis），须用 --bundles 覆盖
  const bundles = PLATFORM === 'darwin' ? ['dmg'] : ['deb', 'appimage']
  return {
    label: `package-sidecar → tauri build --bundles ${bundles.join(' ')}`,
    run: () => {
      const c1 = runNode('scripts/package-sidecar.mjs', [])
      if (c1 !== 0) return c1
      const r = spawnSync('tauri', ['build', '--bundles', ...bundles], { cwd: join(ROOT, 'native'), stdio: 'inherit' })
      return r.status ?? 1
    },
  }
}

/** 找最新安装包（按平台扫对应 bundle 目录）。 */
function findInstaller() {
  const cargoConfig = join(ROOT, 'native', '.cargo', 'config.toml')
  let targetDir
  try {
    const t = /target-dir\s*=\s*"?([^"\s]+)"?/.exec(readFileSync(cargoConfig, 'utf8'))
    targetDir = t ? resolve(ROOT, t[1]) : join(ROOT, 'native', 'target')
  } catch { targetDir = join(ROOT, 'native', 'target') }
  const dirs = PLATFORM === 'win32' ? [['nsis', '.exe']]
    : PLATFORM === 'darwin' ? [['dmg', '.dmg']]
    : [['deb', '.deb'], ['appimage', '.AppImage']]
  for (const [sub, ext] of dirs) {
    const bundleDir = join(targetDir, 'release', 'bundle', sub)
    if (!existsSync(bundleDir)) continue
    const candidates = readdirSync(bundleDir).filter((f) => f.endsWith(ext))
    if (!candidates.length) continue
    const newest = candidates
      .map((f) => ({ f, mtime: statSync(join(bundleDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0].f
    const sizeMB = (statSync(join(bundleDir, newest)).size / 1024 / 1024).toFixed(1)
    return { path: join(bundleDir, newest), name: newest, sizeMB }
  }
  return null
}

/**
 * 一步：执行 → 打印 check 结果。
 * check 通过 → 自动继续（不弹确认）；check 失败 → 停下问是否继续（默认中断）。
 * 返回 false 表示应中断。
 */
async function step(title, checkResult) {
  console.log(`\n──── Step ${title} ────`)
  const [ok, detail] = checkResult
  console.log(`  ${ok ? '✓' : '✗'} ${detail}`)
  if (DRY_RUN) return true
  if (ok) return true // 通过即自动下一步，不逐级确认
  if (YES) { console.log('  [--yes] 忽略告警继续'); return true }
  console.log('  上一步 check 未通过。')
  return confirm('  仍继续下一步（忽略该告警）？', { def: false })
}

// ---- 包 diff（统计 + 详情）----

/** 从闭包依赖表解析 name@version 列表（npm 模式 spec 即版本；source 模式从 tgz 文件名解析）。 */
function depsList(pkg) {
  if (!pkg?.dependencies) return []
  return Object.entries(pkg.dependencies).map(([name, spec]) => {
    let v = '?'
    if (typeof spec === 'string') {
      if (spec.startsWith('file:./tgz/')) {
        const short = name.replace('@deepseek-ai/', '')
        const fname = spec.slice('file:./tgz/'.length)
        if (fname.endsWith('.tgz') && fname.startsWith(`deepseek-ai-${short}-`)) {
          v = fname.slice(`deepseek-ai-${short}-`.length, -'.tgz'.length)
        }
      } else {
        v = spec
      }
    }
    return `${name}@${v}`
  })
}

/** diff 两个 name@version 列表 → { added, removed, changed }。 */
function diffPkgLists(oldList, newList) {
  const parse = (p) => { const i = p.lastIndexOf('@'); return { n: p.slice(0, i), v: p.slice(i + 1) } }
  const oldMap = new Map(oldList.map(parse).map((x) => [x.n, x.v]))
  const newMap = new Map(newList.map(parse).map((x) => [x.n, x.v]))
  const all = new Set([...oldMap.keys(), ...newMap.keys()])
  const added = [], removed = [], changed = []
  for (const n of all) {
    if (!oldMap.has(n)) added.push(n)
    else if (!newMap.has(n)) removed.push(n)
    else if (oldMap.get(n) !== newMap.get(n)) changed.push({ n, from: oldMap.get(n), to: newMap.get(n) })
  }
  return { added, removed, changed }
}

/** 统计摘要（check / CHANGELOG 用，不罗列详情）。 */
function pkgStats(oldList, newList) {
  const { added, removed, changed } = diffPkgLists(oldList, newList)
  const thirdChanged = changed.filter((c) => !c.n.startsWith('@deepseek-ai/')).length
  return {
    prevTotal: oldList.length, newTotal: newList.length,
    added: added.length, removed: removed.length,
    changed: changed.length, thirdChanged,
  }
}

// ---- 详情文档 ----
const NOTES_DIR = join(ROOT, 'scripts', 'release-notes')

/** 写发版详情文档（含包变化完整明细），返回相对路径。 */
function writeReleaseNotes({ date, appVersion, prevAppVersion, channel, dshVersion, prevDshVersion, sourcePath, oldList, newList, commitMsg }) {
  const { added, removed, changed } = diffPkgLists(oldList, newList)
  const delta = newList.length - oldList.length
  const lines = [
    `# 发版详情：app ${appVersion} / dsh ${dshVersion}`,
    '',
    '- 日期：' + date,
    '- 通道：' + channel,
    `- 应用版本：${prevAppVersion} → ${appVersion}`,
    `- dsh 版本：${prevDshVersion ?? '（无）'} → ${dshVersion}`,
    ...(channel === 'source' && sourcePath ? [`- 源码目录：${sourcePath}`] : []),
    `- 包数量：${oldList.length} → ${newList.length}（${delta >= 0 ? '+' : ''}${delta}）`,
    `- 提交：${commitMsg}`,
    '',
    `## 新增包（${added.length}）`,
    ...(added.length ? added.map((n) => `- ${n}`) : ['- （无）']),
    '',
    `## 移除包（${removed.length}）`,
    ...(removed.length ? removed.map((n) => `- ${n}`) : ['- （无）']),
    '',
    `## 版本变更（${changed.length}）`,
    ...(changed.length ? changed.map((c) => `- ${c.n} ${c.from} → ${c.to}`) : ['- （无）']),
    '',
  ]
  if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true })
  const fname = `app${appVersion}-dsh${dshVersion}.md`
  writeFileSync(join(NOTES_DIR, fname), lines.join('\n'), 'utf8')
  return join('scripts', 'release-notes', fname)
}

// ---- CHANGELOG 模板（统计版）----
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 日志文件名时间戳：YYYYMMDD-HHMMSS。 */
function tsForFile() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function buildChangelogEntry({ appVersion, prevAppVersion, channel, dshVersion, prevDshVersion, stats, sourcePath }) {
  const date = todayStr()
  const total = stats.prevTotal ? `${stats.prevTotal} → ${stats.newTotal}（${stats.newTotal - stats.prevTotal >= 0 ? '+' : ''}${stats.newTotal - stats.prevTotal}）` : `${stats.newTotal} 包`
  const depLine = channel === 'npm'
    ? `- **npm 通道**锁定 \`@deepseek-ai/*@${dshVersion}\`（registry 解析，${stats.newTotal} 包）`
    : `- **源码通道**基于 deepseek-harness 源码 \`${dshVersion}\`（file: 本地解析，${stats.newTotal} 包）`
  const verLine = prevDshVersion && prevDshVersion !== dshVersion
    ? `- **dsh 依赖**：\`${prevDshVersion}\` → \`${dshVersion}\``
    : `- **dsh 依赖**：\`${dshVersion}\``
  const pkgLine = `- **包变化**：${total}；新增 ${stats.added} 包 / 移除 ${stats.removed} 包 / 版本变更 ${stats.changed} 个${stats.thirdChanged ? `（三方 ${stats.thirdChanged} 个）` : ''}`
  const appLine = prevAppVersion === appVersion
    ? `- **应用版本**保持 \`${appVersion}\``
    : `- **应用版本**：\`${prevAppVersion}\` → \`${appVersion}\``
  const srcLine = channel === 'source' && sourcePath ? `- 源码目录：\`${sourcePath}\`` : ''
  const commitMsg = `build(deps): upgrade deepseek-harness to ${dshVersion} (${channel}) and app to ${appVersion}`
  return [
    `## [${appVersion}]（${date}）— 依赖升级 dsh ${dshVersion}`,
    '',
    '**发版概要**',
    verLine,
    depLine,
    pkgLine,
    appLine,
    srcLine,
    '',
    '**提交信息（模板）**',
    '```bash',
    `git add -A && git commit -m "${commitMsg}"`,
    '```',
    '',
    '**升级要点**',
    '- 一键发版：`node scripts/quick-release.mjs`（或 `pnpm quick:release`）',
    '- 手工：`build-closure` → `bump-version <新版本>` → `pnpm build`',
    '',
  ].map((l) => l.trimEnd()).filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

/** CHANGELOG 按版本 upsert：已有该版本则整块覆盖，否则插入到第一个 ## 之前。 */
function upsertChangelog(entryText, path = join(ROOT, 'CHANGELOG.md')) {
  const text = readFileSync(path, 'utf8')
  const ver = /^## \[([^\]]+)\]/.exec(entryText)?.[1]
  if (!ver) throw new Error('CHANGELOG 条目缺少版本号')
  const esc = ver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const blockRe = new RegExp(`^## \\[${esc}\\][\\s\\S]*?(?=^## \\[|$)`, 'm')
  if (blockRe.test(text)) {
    writeFileSync(path, text.replace(blockRe, entryText.trimEnd()), 'utf8')
  } else {
    // 插到第一个 "## [" 之前（保留文件头的说明块）
    const m = text.search(/^## \[/m)
    const head = m < 0 ? text : text.slice(0, m)
    const rest = m < 0 ? '' : text.slice(m)
    writeFileSync(path, `${head.trimEnd()}\n\n${entryText.trimEnd()}\n\n${rest.trim()}\n`, 'utf8')
  }
}

// ---- 帮助 ----
function printHelp() {
  console.log(`用法: node scripts/quick-release.mjs [选项]

交互式一键发版（只升级 dsh）：选通道 → 输参数 → bump 版本 → 生成闭包 → 写 CHANGELOG + 详情文档 → 打包。
每步执行后输出 check 结果、确认后才进下一步（↑/↓ 箭头选择、Enter 确认，可随时取消）。

选项:
  --channel <npm|source>       通道（默认交互选择）
  --dsh-version <版本>         npm 通道的 dsh 版本（如 0.1.2-alpha.3）
  --source <目录>              source 通道的本地 dsh 源码目录
  --refresh-manifest <y|n>     npm 通道是否刷新 manifest（上游增删包时用 y）
  --app-version <版本>         应用版本号（默认当前小版本 +1，可自定义）
  --dry-run                    只预览计划，不执行任何命令/写文件
  --yes                        非交互：跳过确认（值用 flag 传入或默认）
  -h, --help                   显示本帮助

示例:
  node scripts/quick-release.mjs
  node scripts/quick-release.mjs --channel npm --dsh-version 0.1.2-alpha.3 --app-version 0.2.2 --yes
  node scripts/quick-release.mjs --dry-run`)
}

// ---- 主流程 ----
async function main() {
  if (has('-h') || has('--help')) { printHelp(); return 0 }
  // 发版日志落盘：每次打版一个文件（应用名-时间戳.log，启动即定名，免重命名）
  const appName = readJson(join(ROOT, 'package.json')).name
  const tee = startTee(join('logs', `${appName}-${tsForFile()}.log`))
  logTee = tee
  const stopLog = () => { try { tee.stop() } catch { /* 忽略 */ } }
  process.once('exit', stopLog) // 兜底：任何 return/异常退出都停 tee
  const prevAppVersion = pkgVersion()
  const prevDshVersion = closureVersion()
  // 闭包生成前的包清单快照（build-closure 会重写闭包，先留存以便 diff 详情）
  const prevPkgList = depsList(closurePkg())
  console.log('\n════ quick-release · 一键发版（只升级 dsh）════')
  console.log(`  发版日志  : ${tee.path}`)
  console.log(`  平台     : ${platformNote()}`)
  console.log(`  当前 app : ${prevAppVersion}`)
  console.log(`  当前 dsh : ${prevDshVersion ?? '（无）'}（${prevPkgList.length} 包）`)
  if (DRY_RUN) console.log('  [DRY-RUN] 只预览，不执行')

  // ① 通道（↑/↓ 箭头选择，绿色高亮）
  const channel = await choose('选择通道', [
    { value: 'npm', label: 'npm（通过registry解析，适合dsh已发布到npm）' },
    { value: 'source', label: 'source（通过本地源码构建闭包）' },
  ], { flagName: '--channel' })
  if (!['npm', 'source'].includes(channel)) { console.error(`✗ 通道必须是 npm / source，得到 ${channel}`); return 1 }
  let dshVersion = null, sourcePath = null, refreshManifest = false
  if (channel === 'npm') {
    // 列出 npm 可用版本（最新在前），箭头选择；查询失败退化为文本输入
    const versions = listNpmVersions()
    if (versions.length) {
      console.log('\n── npm 可用 dsh 版本 ──')
      versions.forEach((v, i) => console.log(`  ${i === 0 ? '（最新）' : ''} ${v}`))
      dshVersion = await choose('选择 dsh 版本', versions.map((v) => ({ value: v, label: v })), { flagName: '--dsh-version', def: 0 })
    } else {
      dshVersion = await ask('dsh 版本号（查询 npm 可用版本失败，请手动输入）', { flagName: '--dsh-version' })
    }
    if (!dshVersion) { console.error('✗ 未提供 dsh 版本号'); return 1 }
    const _rm = await choose('上游是否增删包？需要刷新 manifest', [
      { value: false, label: '否（不刷新，用现有 manifest）' },
      { value: true, label: '是（刷新到 dsh-v<版本> 标签）' },
    ], { flagName: '--refresh-manifest', def: 0 })
    refreshManifest = _rm === true || _rm === 'y' || _rm === 'yes'
  } else {
    sourcePath = await ask('本地 dsh 源码目录（已 pnpm install && pnpm build）', { flagName: '--source' })
    if (!sourcePath) { console.error('✗ 未提供源码目录'); return 1 }
    const srcPkg = join(resolve(sourcePath), 'package.json')
    if (!existsSync(srcPkg) && !DRY_RUN) {
      console.error(`✗ 源码目录无效: ${sourcePath}`)
      return 1
    }
    const srcVer = DRY_RUN && !existsSync(srcPkg) ? '<源码版本>' : readJson(srcPkg).version
    // --dsh-version flag 已传则直接用；否则检测源码版本 → Y/n 确认，选"否"退回手动输入
    const dsvFlag = flag('--dsh-version')
    dshVersion = dsvFlag ?? (await confirm(`检测到源码版本 v${srcVer}，确认使用该版本？`) ? srcVer : await ask('手动输入 dsh 版本号', { flagName: '--dsh-version' }))
  }

  // ② 应用版本（默认小版本 +1，可自定义；非法重问）。banner 已打印当前版本，这里不重复历史。
  const defaultApp = nextPatch(prevAppVersion)
  const appVersionFlag = flag('--app-version') // flag 固定值：非法直接退出，不重问
  let appVersion = await ask('请输入应用版本号', { def: defaultApp, flagName: '--app-version' })
  while (!VERSION_RE.test(appVersion)) {
    console.error(`✗ 非法版本「${appVersion}」，应为 x.y.z（可带 -rc.N/-alpha.N/-beta.N）`)
    if (appVersionFlag !== undefined) return 1 // 非交互 flag 非法 → 退出
    appVersion = await ask('请输入应用版本号', { def: defaultApp, flagName: '--app-version' })
  }

  // ③ 预览
  console.log('\n── 发版计划 ──')
  console.log(`  平台        : ${platformNote()}`)
  console.log(`  通道        : ${channel}`)
  console.log(`  dsh 版本    : ${dshVersion}`)
  if (channel === 'source') console.log(`  源码目录    : ${sourcePath}`)
  if (refreshManifest) console.log(`  manifest    : 将刷新（--ref dsh-v${dshVersion}）`)
  console.log(`  应用版本    : ${prevAppVersion} → ${appVersion}${prevAppVersion === appVersion ? '（不变）' : ''}`)
  console.log(`  打包        : ${buildStep().label}`)
  if (DRY_RUN) { console.log('\n[DRY-RUN] 预览完毕，未执行任何命令。'); return 0 }
  if (!(await confirm('\n确认按此计划执行？'))) { console.log('已取消。'); return 0 }

  // ④ bump 应用版本（提前执行；相同版本跳过）
  let needBump = appVersion !== prevAppVersion
  if (needBump) {
    console.log('\n──── Step 1/5：bump-version ────')
    const code = runNode('scripts/bump-version.mjs', [appVersion, YES ? '--yes' : ''].filter(Boolean))
    if (code !== 0) { console.error('  ✗ bump-version 失败'); return 1 }
  } else {
    console.log('\n──── Step 1/5：bump-version（版本未变，跳过）────')
  }
  if (!(await step('1/5 应用版本一致性', fourFilesOk(appVersion)))) return 0

  // ⑤ manifest 刷新（可选，仅 npm 且用户要求）
  if (refreshManifest) {
    console.log('\n──── Step 2/5：刷新 manifest ────')
    const code = runNode('scripts/sync-deps.mjs', ['--refresh-manifest', '--ref', `dsh-v${dshVersion}`])
    if (code !== 0) { console.error('  ✗ sync:manifest 失败（网络/上游标签问题）'); return 1 }
    const ok = (() => { try { return readJson(join(ROOT, 'scripts', 'dsh-manifest.json')).source.includes(`dsh-v${dshVersion}`) } catch { return false } })()
    if (!(await step('2/5 manifest 已刷新到目标 ref', [ok, ok ? `manifest → dsh-v${dshVersion}` : 'manifest 未更新到目标 ref（网络失败？）']))) return 0
  } else {
    console.log('\n──── Step 2/5：刷新 manifest（跳过）────')
  }

  // ⑥ build-closure
  console.log('\n──── Step 3/5：build-closure ────')
  const closureArgs = channel === 'npm'
    ? ['--version', dshVersion, '--sync']
    : ['--source', resolve(sourcePath)]
  const ccode = runNode('scripts/build-closure.mjs', closureArgs)
  if (ccode !== 0) { console.error('  ✗ build-closure 失败'); return 1 }
  const gotClosure = closureVersion()
  const entry = ledgerEntry(channel, dshVersion)
  const closureOk = gotClosure === dshVersion && !!entry
  if (!(await step('3/5 闭包 dsh 版本 + ledger', [closureOk, `闭包=${gotClosure ?? '?'}（期望 ${dshVersion}） ledger=${entry ? `${entry.packages?.length ?? '?'} 包` : '未记录'}`]))) return 0

  // ⑦ 写 CHANGELOG（统计版，同版本覆盖）+ 详情文档
  console.log('\n──── Step 4/5：写 CHANGELOG + 详情文档 ────')
  const newPkgList = depsList(closurePkg())
  const stats = pkgStats(prevPkgList, newPkgList)
  const commitMsg = `build(deps): upgrade deepseek-harness to ${dshVersion} (${channel}) and app to ${appVersion}`
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] 统计预览：${stats.prevTotal} → ${stats.newTotal}（+${stats.added}/-${stats.removed}，三方变更 ${stats.thirdChanged}）— 未写文件`)
  } else {
    const notesPath = writeReleaseNotes({ date: todayStr(), appVersion, prevAppVersion, channel, dshVersion, prevDshVersion, sourcePath, oldList: prevPkgList, newList: newPkgList, commitMsg })
    const entryText = buildChangelogEntry({ appVersion, prevAppVersion, channel, dshVersion, prevDshVersion, stats, sourcePath })
    upsertChangelog(entryText)
    console.log(`  ✓ CHANGELOG ## [${appVersion}]（${todayStr()}）已写入（统计：${stats.prevTotal} → ${stats.newTotal}，+${stats.added}/-${stats.removed}）`)
    console.log(`  ✓ 详情文档: ${notesPath}`)
  }
  const topOk = changelogTopVersion() === appVersion
  if (!(await step('4/5 CHANGELOG 顶部版本', [DRY_RUN || topOk, DRY_RUN ? '预览未写' : `顶部 [${changelogTopVersion()}]（期望 ${appVersion}）`]))) return 0

  // ⑧ git commit 模板
  console.log('\n── git commit 提交模板 ──')
  console.log(`  git add -A && git commit -m "${commitMsg}"`)
  if (!(await confirm('\n确认继续打包？'))) { console.log('已中断（CHANGELOG 已写，可手动提交）。'); return 0 }

  // ⑨ 打包（平台兼容）
  console.log(`\n──── Step 5/5：打包（${buildStep().label}）────`)
  const bcode = buildStep().run()
  if (bcode !== 0) { console.error('  ✗ 打包失败'); return 1 }
  const pkg = findInstaller()
  const [pkgOk, pkgDetail] = pkg
    ? [true, `安装包: ${pkg.name}（${pkg.sizeMB} MB）@ ${pkg.path}`]
    : [false, '未找到安装包（按平台 bundle 目录扫描）']
  if (!(await step('5/5 安装包产物', [pkgOk, pkgDetail]))) return 0

  console.log('\n✅ 一键发版完成。')
  console.log('  提交命令:')
  console.log(`    git add -A && git commit -m "${commitMsg}"`)
  console.log(`  本次打版日志: ${tee.path}`)
  return 0
}

// 可测试性：直接跑 node 时执行 main；被 import 时不执行（测试用）。
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = await main()

export { nextPatch, depsList, diffPkgLists, pkgStats, writeReleaseNotes, buildChangelogEntry, upsertChangelog, todayStr }
