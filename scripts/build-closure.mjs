#!/usr/bin/env node
/**
 * build-closure.mjs — 生成 deepseek-harness 依赖闭包（两种模式）。
 *
 * 闭包 = <repo 根>/deepseek-harness/package.json，是两条通道共用的依赖配方：
 *   --mode npm（默认，正式版）：
 *       依赖来自 npm 已发布版本（dsh-manifest.json + --version），registry 解析；
 *       SPECIAL（cordis-plugin-group）自动对齐 npm latest，查询失败才回退钉死值。
 *   --mode source（源码版）：
 *       依赖来自 deepseek-harness 源码，不依赖 npm 发布——pnpm pack 成 tarball，
 *       file: 本地依赖 + overrides 强制本地解析；三方依赖仍走 npm registry。
 *
 * 用法：
 *   node scripts/build-closure.mjs --version <npm 版本> [--sync] [--dry-run]   # npm 模式
 *   node scripts/build-closure.mjs --source <本地源码目录> [--dry-run]          # source 模式
 *
 * 产物：<repo 根>/deepseek-harness/{package.json[, tgz/*.tgz]}；
 * 版本 ledger 追加到 scripts/dsh-releases.json。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendLedger, LEDGER_PATH } from './lib/ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DEFAULT_OUT = join(ROOT, 'deepseek-harness') // 与 scripts 同级
const MANIFEST_PATH = join(ROOT, 'scripts', 'dsh-manifest.json')
const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', 'coverage', 'tmp', 'test-support'])
/** 独立版本线的包：不跟随 dsh 版本走（npm 模式用它自己的版本）。 */
const SPECIAL = { '@deepseek-ai/cordis-plugin-group': '1.0.1' }
/** npm 模式的锚定包（registry 上确认版本的入口）。 */
const ANCHOR = '@deepseek-ai/dsh'

function parseArgs(argv) {
  const opts = { source: undefined, version: undefined, sync: false, dryRun: false, out: DEFAULT_OUT }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue // pnpm run -- 传参时透传的裸 --
    else if (a === '--source') opts.source = argv[++i]
    else if (a === '--version') opts.version = argv[++i]
    else if (a === '--sync') opts.sync = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--out') opts.out = argv[++i]
    else { console.error(`unknown option: ${a}`); process.exit(2) }
  }
  const mode = opts.version ? 'npm' : opts.source ? 'source' : null
  if (!mode) {
    console.error('用法:')
    console.error('  npm 模式:   node scripts/build-closure.mjs --version <npm 版本> [--sync] [--dry-run]')
    console.error('  source 模式: node scripts/build-closure.mjs --source <本地源码目录> [--dry-run]')
    process.exit(2)
  }
  return { ...opts, mode }
}

/** 判断是否看起来像 git URL（当前不实现，给出指引）。 */
function isGitUrl(s) { return /^(https?:\/\/|git@|git:\/\/)/.test(s) }

/** Windows 下经 cmd 调用 .cmd shim（pnpm）；含空格的参数加引号。 */
function quoteArg(a) { return /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a }
function run(cmd, args, cwd) {
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', [cmd, ...args].map(quoteArg).join(' ')], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`${cmd} exited with ${r.status}\n${(r.stderr || r.stdout || '').slice(0, 800)}`)
  }
}

/** 递归收集目录内所有 package.json 路径（跳过 node_modules/.git 等）。 */
function collectPackageFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(p)
      } else if (entry.name === 'package.json') {
        out.push(p)
      }
    }
  }
  walk(root)
  return out
}

/** 从 package.json 路径读 {name, version, private, dir}，解析失败返回 null。 */
function readPkg(p) {
  try {
    const pkg = JSON.parse(readFileSync(p, 'utf8'))
    return { name: pkg.name, version: pkg.version, private: !!pkg.private, dir: dirname(p) }
  } catch { return null }
}

/** 确定性 tgz 文件名：deepseek-ai-<name>-<version>.tgz。 */
function tgzName(name, version) {
  const short = name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length) : name
  return `deepseek-ai-${short}-${version}.tgz`
}

/** 当前应用版本（package.json），记入 ledger 以便追溯"哪个 app 版本用了哪个 dsh"。 */
function appVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

/** best-effort 查某 dsh 版本的 npm 发布时间；未发布/网络失败返回 null（不硬失败）。 */
function npmPublishedAt(version) {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/d', '/s', '/c', `npm view ${ANCHOR}@${version} time --json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync('npm', ['view', `${ANCHOR}@${version}`, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status !== 0) return null
    const time = JSON.parse(r.stdout)
    return time?.[version] ?? null
  } catch { return null }
}

/** 读 scripts/dsh-manifest.json 的包名列表；缺失返回 null。 */
function readManifest() {
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).packages } catch { return null }
}

/** npm 模式：从 dsh-manifest.json + --version 生成 version-specs 闭包（registry 解析）。 */
function buildNpm(opts) {
  if (!opts.version) return 2
  const manifest = readManifest()
  if (!manifest) {
    console.error(`[build-closure] 缺 ${MANIFEST_PATH}，先运行: node scripts/sync-deps.mjs --refresh-manifest --ref <标签>`)
    return 2
  }
  // desired = manifest ∪ dsh 本体 ∪ SPECIAL（SPECIAL 走自己的版本线）。
  const desired = new Set([...manifest, ANCHOR, ...Object.keys(SPECIAL)])
  const sorted = [...desired].sort()
  const deps = {}
  for (const name of sorted) deps[name] = opts.version
  // SPECIAL 走独立版本线：best-effort 对齐 npm latest，网络失败回退钉死值。
  for (const [name, pinned] of Object.entries(SPECIAL)) {
    if (!sorted.includes(name)) continue
    let latest = null
    try {
      const r = process.platform === 'win32'
        ? spawnSync('cmd', ['/d', '/s', '/c', `npm view ${name} dist-tags.latest --json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        : spawnSync('npm', ['view', name, 'dist-tags.latest', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const v = JSON.parse(r.stdout)
      if (typeof v === 'string' && v) latest = v
    } catch { /* 网络失败 */ }
    deps[name] = latest ?? pinned
    if (latest && latest !== pinned) console.log(`[build-closure] SPECIAL ${name}: 钉死 ${pinned} → npm latest ${latest}`)
    else if (!latest) console.warn(`[build-closure] SPECIAL ${name}: 无法查询 npm latest，回退钉死值 ${pinned}`)
  }

  // 与现有闭包 diff（--sync 语义：补缺失/删残留；默认只提示）。
  let prev = new Set()
  try { prev = new Set(Object.keys(JSON.parse(readFileSync(join(opts.out, 'package.json'), 'utf8')).dependencies || {})) } catch { /* 首次 */ }
  const added = sorted.filter((n) => !prev.has(n))
  const dropped = [...prev].filter((n) => !sorted.includes(n))
  if (added.length || dropped.length) {
    console.log(`[build-closure] npm 模式: +${added.length} / -${dropped.length} 个包（相对现有闭包）`)
    for (const n of added) console.log(`  + ${n}`)
    for (const n of dropped) console.log(`  - ${n}`)
  }

  // 校验锚定版本在 registry 存在：找不到直接中止（不生成脏闭包）。
  let publishedAt = null
  try {
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/d', '/s', '/c', `npm view ${ANCHOR}@${opts.version} time --json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      : spawnSync('npm', ['view', `${ANCHOR}@${opts.version}`, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.status !== 0) throw new Error('npm view 查询失败')
    const time = JSON.parse(r.stdout)
    publishedAt = time?.[opts.version] ?? null
    if (!publishedAt) throw new Error(`registry 未找到 ${opts.version}`)
    console.log(`[build-closure] ${ANCHOR}@${opts.version} 已发布 ✓（${publishedAt}）`)
  } catch (e) {
    console.error(`[build-closure] ${ANCHOR}@${opts.version} 未能在 registry 确认（${e.message}），中止`)
    return 1
  }

  console.log(`[build-closure] npm 模式: ${sorted.length} 个依赖 → ${opts.out}/package.json`)
  if (opts.dryRun) {
    console.log('[build-closure] --dry-run，未写入。样例:')
    for (const n of sorted.slice(0, 8)) console.log(`    ${n}: ${deps[n]}`)
    if (sorted.length > 8) console.log(`    … 等 ${sorted.length} 个`)
    console.log(`    将追加 ledger: ${LEDGER_PATH}`)
    return 0
  }

  const closure = {
    name: 'deepseek-harness',
    version: opts.version,
    private: true,
    description: `npm 通道依赖闭包：@deepseek-ai/*@${opts.version}，registry 解析（${sorted.length} 包）`,
    dependencies: deps,
  }
  writeFileSync(join(opts.out, 'package.json'), JSON.stringify(closure, null, 2) + '\n', 'utf8')
  // 清掉 source 模式遗留的 tgz/（npm 模式不打包，孤儿目录会误导）。
  if (existsSync(join(opts.out, 'tgz'))) rmSync(join(opts.out, 'tgz'), { recursive: true, force: true })
  console.log(`[build-closure] 已写入 ${join(opts.out, 'package.json')}（${sorted.length} 个依赖，无 overrides）`)

  const count = appendLedger({
    channel: 'npm',
    // app 组
    appVersion: appVersion(),
    appBuiltAt: new Date().toISOString().slice(0, 10), // 年月日即可（重打包版本会增）
    // dsh 组
    dshVersion: opts.version,
    dshPublishedAt: publishedAt,
    dshCommit: null,
    packages: sorted.map((n) => `${n}@${deps[n]}`),
  })
  console.log(`[build-closure] ledger 已追加 ${LEDGER_PATH}（共 ${count} 条）`)
  return 0
}

/** source 模式：从源码 pnpm pack 成 tgz，file: 依赖 + overrides 强制本地解析。 */
function buildSource(opts) {
  if (isGitUrl(opts.source)) {
    console.error('[build-closure] git URL 模式未实现。请先 clone 到本地并用 --source <目录>：')
    console.error('  git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness.git && pnpm install && pnpm build')
    return 2
  }
  const src = resolve(opts.source)
  const srcPkgPath = join(src, 'package.json')
  if (!existsSync(srcPkgPath)) {
    console.error(`[build-closure] 源码目录缺少 package.json: ${src}`)
    return 2
  }
  const srcVersion = readPkg(srcPkgPath)?.version ?? 'unknown'
  // 源码 git HEAD（best-effort，作为源码版"发布时间"的替代）。
  let commit = ''
  try { commit = spawnSync('git', ['-C', src, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim() } catch { /* 非 git 目录 */ }

  // 1) 枚举 @deepseek-ai/* 且非 private 的包。
  const pkgs = collectPackageFiles(src)
    .map(readPkg)
    .filter((p) => p && p.name && p.name.startsWith('@deepseek-ai/') && !p.private)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (pkgs.length === 0) {
    console.error(`[build-closure] 源码目录下没有可打包的 @deepseek-ai/* 包: ${src}`)
    return 2
  }

  const tgzDir = join(opts.out, 'tgz')
  const byName = new Map()
  for (const p of pkgs) byName.set(p.name, p)

  console.log(`[build-closure] source=${src} version=${srcVersion} commit=${commit || '(非 git)'}`)
  console.log(`[build-closure] @deepseek-ai/* 可打包 ${pkgs.length} 个，输出 ${opts.out}`)
  if (opts.dryRun) {
    console.log('[build-closure] --dry-run，未打包、未写入：')
    for (const p of pkgs.slice(0, 12)) console.log(`    ${p.name}@${p.version}`)
    if (pkgs.length > 12) console.log(`    … 等 ${pkgs.length} 个`)
    console.log(`    将生成: ${join(opts.out, 'package.json')} + ${tgzDir}/ 下 ${pkgs.length} 个 tgz`)
    console.log(`    将追加 ledger: ${LEDGER_PATH}`)
    return 0
  }

  // 2) 清空并重建输出目录，逐包 pnpm pack。
  rmSync(opts.out, { recursive: true, force: true })
  mkdirSync(tgzDir, { recursive: true })
  let failures = 0
  const seen = new Set() // 已处理产物名（pnpm 默认名与确定性名一致时无需 rename）
  for (const p of pkgs) {
    const outFile = join(tgzDir, tgzName(p.name, p.version))
    try {
      run('pnpm', ['pack', '--pack-destination', tgzDir], p.dir)
      const produced = readdirSync(tgzDir).filter((f) => f.endsWith('.tgz') && !seen.has(f))
      if (produced.length !== 1) throw new Error(`pack 产物数量异常: ${produced.join(', ')}`)
      const srcFile = join(tgzDir, produced[0])
      if (srcFile !== outFile) renameSync(srcFile, outFile)
      seen.add(basename(outFile))
      process.stdout.write(`  pack ${p.name}@${p.version} ✓\n`)
    } catch (e) {
      failures++
      console.error(`  pack ${p.name} FAILED: ${e.message}`)
    }
  }
  if (failures > 0) {
    console.error(`[build-closure] ${failures}/${pkgs.length} 个包打包失败，仍生成清单（失败的包不在闭包内）`)
  }

  // 3) 生成 package.json：file: 依赖 + overrides 强制本地解析。
  const packed = [...byName.values()].filter((p) => existsSync(join(tgzDir, tgzName(p.name, p.version))))
  const deps = {}
  for (const p of packed) deps[p.name] = `file:./tgz/${tgzName(p.name, p.version)}`
  const closure = {
    name: 'deepseek-harness',
    version: srcVersion,
    private: true,
    description: `源码通道依赖闭包：从 deepseek-harness 源码构建，file: 解析（${packed.length} 包）`,
    dependencies: deps,
    overrides: { ...deps },
  }
  writeFileSync(join(opts.out, 'package.json'), JSON.stringify(closure, null, 2) + '\n', 'utf8')
  console.log(`[build-closure] 已写入 ${join(opts.out, 'package.json')}（${packed.length} 个依赖 + overrides）`)

  // 4) 追加版本 ledger。
  const count = appendLedger({
    channel: 'source',
    // app 组
    appVersion: appVersion(),
    appBuiltAt: new Date().toISOString().slice(0, 10), // 年月日即可（重打包版本会增）
    // dsh 组
    dshVersion: srcVersion,
    // best-effort：该源码版本若已发布到 npm 则记发布时间，未发布记 null（字段始终在）。
    dshPublishedAt: npmPublishedAt(srcVersion),
    dshCommit: commit || null,
    // 不记本地绝对路径（不可移植）；dshVersion + dshCommit 已定位这次构建。
    packages: packed.map((p) => `${p.name}@${p.version}`),
  })
  console.log(`[build-closure] ledger 已追加 ${LEDGER_PATH}（共 ${count} 条）`)
  return 0
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  return opts.mode === 'npm' ? buildNpm(opts) : buildSource(opts)
}

process.exitCode = main()
