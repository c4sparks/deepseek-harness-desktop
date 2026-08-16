#!/usr/bin/env node
/**
 * sync-deps.mjs — one-command maintenance for the @deepseek-ai/* dependency set.
 *
 * The desktop shell pins an explicit closure of @deepseek-ai/* packages because
 * dsh's Cordis plugin tree is assembled at runtime via dynamic import(): the full
 * plugin set is NOT reachable from @deepseek-ai/dsh's static graph (see README
 * "与 deepseek-harness 的关系"). Hand-editing that list means touching ~205 lines;
 * this script turns the common cases into one command.
 *
 * Usage:
 *   node scripts/sync-deps.mjs --version <上游版本>                 # bump @deepseek-ai/* dep versions
 *   node scripts/sync-deps.mjs --version <上游版本> --sync           # ... + reconcile against scripts/dsh-manifest.json (add missing / drop stale)
 *   node scripts/sync-deps.mjs --version <上游版本> --remove @deepseek-ai/dsh-e2b
 *   node scripts/sync-deps.mjs --version <上游版本> --dry-run        # preview, write nothing
 *   node scripts/sync-deps.mjs --app-version <上游版本>              # bump the app's own version (package.json + tauri.conf.json + Cargo.toml)
 *   node scripts/sync-deps.mjs --list                               # list available @deepseek-ai/dsh versions
 *   node scripts/sync-deps.mjs --refresh-manifest                    # regenerate scripts/dsh-manifest.json from upstream module-graph.md
 *
 * After a successful run: pnpm install && pnpm build   (re-assembles sidecar + host bundle).
 * The target dep version must already be published on npm.
 *
 * The authoritative package set is the upstream module-graph
 * (deepseek-harness repo, docs/module-graph.md), checked into
 * scripts/dsh-manifest.json. --sync reconciles package.json's @deepseek-ai/dsh-*
 * deps against it (add missing, drop stale, bump versions). @deepseek-ai/dsh and
 * the SPECIAL entries are always preserved. Run --refresh-manifest when upstream
 * adds/removes packages.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_PATH = join(resolve(HERE, '..'), 'package.json')
const MANIFEST_PATH = join(HERE, 'dsh-manifest.json')
const MANIFEST_URL = 'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/module-graph.md'

// Version lines independent of the dsh release line — never auto-bumped.
const SPECIAL = {
  '@deepseek-ai/cordis-plugin-group': '1.0.1',
}

// Packages in the upstream module-graph the desktop does not ship: demos /
// testkits / sdk / mock servers / harness-only tooling. Edit when upstream adds
// or removes one, then re-run --refresh-manifest.
const EXCLUDE = new Set([
  '@deepseek-ai/dsh-acp',
  '@deepseek-ai/dsh-acp-demo',
  '@deepseek-ai/dsh-acp-snapshot',
  '@deepseek-ai/dsh-agent-loop-testkit',
  '@deepseek-ai/dsh-agent-spine-demo',
  '@deepseek-ai/dsh-client-test-runtime',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hooks-codex',
  '@deepseek-ai/dsh-llm-mock-server',
  '@deepseek-ai/dsh-llm-replay',
  '@deepseek-ai/dsh-loader-smoke',
  '@deepseek-ai/dsh-sdk-client',
  '@deepseek-ai/dsh-sdk-jsonrpc-demo',
  '@deepseek-ai/dsh-sdk-jsonrpc-server',
  '@deepseek-ai/dsh-sdk-protocol',
])

function parseArgs(argv) {
  const opts = { version: undefined, appVersion: undefined, sync: false, refreshManifest: false, list: false, remove: [], dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--version') opts.version = argv[++i]
    else if (a === '--app-version') opts.appVersion = argv[++i]
    else if (a === '--sync') opts.sync = true
    else if (a === '--refresh-manifest') opts.refreshManifest = true
    else if (a === '--list') opts.list = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--remove') opts.remove.push(argv[++i])
    else throw new Error(`unknown option: ${a}`)
  }
  return opts
}

/** The pinned @deepseek-ai/dsh-* package set (scripts/dsh-manifest.json). */
function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).packages
  } catch {
    console.error(`sync-deps: cannot read ${MANIFEST_PATH} — run 'node scripts/sync-deps.mjs --refresh-manifest' first`)
    return undefined
  }
}

/** Regenerate scripts/dsh-manifest.json from upstream docs/module-graph.md. */
async function refreshManifest(dryRun) {
  let text
  try {
    const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    text = await res.text()
  } catch (e) {
    console.error(`sync-deps: fetch ${MANIFEST_URL} failed: ${e.message}`)
    return 2
  }
  const all = new Set()
  for (const m of text.matchAll(/pkg_[a-z0-9_]+\["([^"]+)"\]/g)) all.add(`@deepseek-ai/dsh-${m[1]}`)

  // previous manifest (first run: empty)
  let prev = new Set()
  try {
    prev = new Set(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).packages)
  } catch {
    /* first run */
  }

  const included = [...all].filter((n) => !EXCLUDE.has(n)).sort()
  const includedSet = new Set(included)
  const added = included.filter((n) => !prev.has(n))
  const dropped = [...prev].filter((n) => !includedSet.has(n)).sort()
  const excluded = [...all].filter((n) => EXCLUDE.has(n)).sort()

  console.log(`refresh-manifest: ${all.size} upstream → ${included.length} in manifest (+${added.length} / -${dropped.length}), ${excluded.length} excluded`)
  if (added.length) {
    console.log(`  +${added.length} new:`)
    for (const n of added) {
      const dev = /demo|testkit|mock|replay|smoke|-test|sdk/.test(n)
      console.log(`    ${n}${dev ? '   ⚠️ 疑似 dev/demo 类，若桌面不需要请加入 EXCLUDE 后重跑' : ''}`)
    }
  }
  if (dropped.length) {
    console.log(`  -${dropped.length} no longer in upstream (will drop from package.json on next --sync):`)
    for (const n of dropped) console.log(`    ${n}`)
  }
  if (dryRun) {
    console.log('refresh-manifest: --dry-run, nothing written')
    return 0
  }
  const manifest = { source: MANIFEST_URL, generatedAt: new Date().toISOString(), packages: included }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(`refresh-manifest: wrote ${MANIFEST_PATH}`)
  return 0
}

function npmViewJson(args) {
  const full = ['view', ...args, '--json']
  // Windows: spawnSync can't launch `.cmd` shims directly (EINVAL) — route through
  // cmd.exe so npm.cmd resolves. Args are package names / flags (no spaces).
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', `npm ${full.join(' ')}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    : spawnSync('npm', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) throw new Error(`npm view ${args[0]} failed: ${(r.stderr || '').trim()}`)
  return JSON.parse(r.stdout)
}

/** Rough 0.x.y[-rc.N] desc sort — enough to order dsh's release line. */
function sortVersionsDesc(list) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/.exec(v)
    return m ? { ma: +m[1], mi: +m[2], pa: +m[3], rc: m[4] === undefined ? Infinity : +m[4] } : null
  }
  return [...list].sort((a, b) => {
    const pa = parse(a), pb = parse(b)
    if (!pa || !pb) return String(b).localeCompare(String(a))
    return pb.ma - pa.ma || pb.mi - pa.mi || pb.pa - pa.pa || pb.rc - pa.rc
  })
}

/** List available @deepseek-ai/dsh versions (the anchor for the release line). */
function listVersions() {
  const ANCHOR = '@deepseek-ai/dsh'
  let versions
  let tags = {}
  try {
    versions = npmViewJson([ANCHOR, 'versions'])
    tags = npmViewJson([ANCHOR, 'dist-tags'])
  } catch (e) {
    console.error(`sync-deps: cannot fetch versions for ${ANCHOR}: ${e.message}`)
    return 2
  }
  const tagOf = new Map(Object.entries(tags).map(([tag, v]) => [v, tag]))
  console.log(`available versions of ${ANCHOR}:`)
  for (const v of sortVersionsDesc(versions)) {
    const tag = tagOf.get(v) ? `  (${tagOf.get(v)})` : ''
    console.log(`  ${v}${tag}`)
  }
  console.log('\nupgrade: node scripts/sync-deps.mjs --version <版本> --sync')
  return 0
}

function bumpAppVersion(newVer, dryRun) {
  const root = resolve(HERE, '..')
  const edits = []

  // package.json
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  if (pkg.version !== newVer) edits.push({ file: 'package.json', from: pkg.version, to: newVer })
  pkg.version = newVer
  if (!dryRun) writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // native/tauri.conf.json
  const confPath = join(root, 'native', 'tauri.conf.json')
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  if (conf.version !== newVer) edits.push({ file: 'native/tauri.conf.json', from: conf.version, to: newVer })
  conf.version = newVer
  if (!dryRun) writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n', 'utf8')

  // native/Cargo.toml — first top-level `version = "…"` (the [package] one)
  const cargoPath = join(root, 'native', 'Cargo.toml')
  const cargo = readFileSync(cargoPath, 'utf8')
  const cm = /^version\s*=\s*"([^"]+)"/m.exec(cargo)
  if (cm && cm[1] !== newVer) edits.push({ file: 'native/Cargo.toml', from: cm[1], to: newVer })
  if (!dryRun) writeFileSync(cargoPath, cargo.replace(/^version\s*=\s*"[^"]+"/m, `version = "${newVer}"`), 'utf8')

  // native/Cargo.lock — root package version (cargo would regenerate anyway)
  const lockPath = join(root, 'native', 'Cargo.lock')
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

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`sync-deps: ${e.message}`)
    console.error('usage: node scripts/sync-deps.mjs --version <v> [--sync] [--remove <name>...] [--dry-run] | --app-version <v> | --refresh-manifest')
    return 2
  }
  if (opts.appVersion) {
    return bumpAppVersion(opts.appVersion, opts.dryRun)
  }
  if (opts.refreshManifest) {
    return refreshManifest(opts.dryRun)
  }
  if (opts.list) {
    return listVersions()
  }
  if (!opts.version) {
    console.error('sync-deps: --version (dep version), --app-version (app version), --list, or --refresh-manifest is required')
    return 2
  }

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
  const deps = pkg.dependencies || {}
  const changes = []

  // 1) version bump — everything @deepseek-ai/* except SPECIAL.
  for (const [name, ver] of Object.entries(deps)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (name in SPECIAL) continue
    if (ver !== opts.version) changes.push({ type: 'bump', name, from: ver, to: opts.version })
  }

  // 2) explicit removals.
  for (const name of opts.remove) {
    if (deps[name]) changes.push({ type: 'remove', name, from: deps[name], to: undefined })
    else console.warn(`sync-deps: skip --remove ${name} (not a dependency)`)
  }

  // 3) sync — reconcile package.json against scripts/dsh-manifest.json:
  //    add missing dsh-* packages, drop stale ones. @deepseek-ai/dsh and the
  //    SPECIAL entries are always in the desired set (never dropped).
  if (opts.sync) {
    const manifest = readManifest()
    if (!manifest) return 2
    const desired = new Set([...manifest, '@deepseek-ai/dsh', ...Object.keys(SPECIAL)])
    const current = new Set(Object.keys(deps).filter((n) => n.startsWith('@deepseek-ai/')))
    for (const name of desired) {
      if (!current.has(name)) {
        changes.push({ type: 'add', name, from: undefined, to: name in SPECIAL ? SPECIAL[name] : opts.version })
      }
    }
    for (const name of current) {
      if (name.startsWith('@deepseek-ai/dsh-') && !desired.has(name)) {
        changes.push({ type: 'remove', name, from: deps[name], to: undefined })
      }
    }
  }

  if (changes.length === 0) {
    console.log(`sync-deps: no changes (${opts.version} already in place)`)
    return 0
  }

  console.log(`sync-deps: ${changes.length} change(s)`)
  for (const c of changes) {
    const label = c.type.padEnd(6)
    const from = c.from ?? '<none>'
    const to = c.to ?? '<removed>'
    console.log(`  ${label} ${c.name}  ${from} -> ${to}`)
  }

  if (opts.dryRun) {
    console.log('\nsync-deps: --dry-run, package.json not written')
    return 0
  }

  for (const c of changes) {
    if (c.type === 'remove') delete deps[c.name]
    else deps[c.name] = c.to
  }
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  console.log('\nsync-deps: wrote package.json. Next: pnpm install && pnpm build')
  return 0
}

process.exitCode = await main()
