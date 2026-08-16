#!/usr/bin/env node
/**
 * dsh desktop sidecar packager (M0).
 *
 * Assembles the Tauri sidecar: a Node runtime (>=22.19, engines of @deepseek-ai/dsh)
 * + the dsh host bundle (apps/cli production deps, via `pnpm deploy`), renamed to
 * the Tauri sidecar convention `dsh-host-<target-triple>[.exe]` and placed under
 * `native/binaries/`. The Rust shell spawns it with `--profile web --port 0`
 * and reads its readiness line (wired in M1).
 *
 * Isolation: writes only under apps/desktop/{native/binaries,resources,scripts};
 * never writes into packages/ or apps/cli.
 *
 * Usage:
 *   node scripts/package-sidecar.mjs [--triple <triple>] [--node-version <v>]
 *        [--node-bin <path>] [--dry-run]
 *
 * --node-bin: copy a local Node executable instead of downloading (recommended
 *             for local verification). Downloading a pinned Node archive is a
 *             CI concern (M3); the URL is printed for reference.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const SRC_TAURI = join(PKG_ROOT, 'native')
const BINARIES = join(SRC_TAURI, 'binaries')
const RESOURCES = join(PKG_ROOT, 'resources') // stable host-bundle dir (M1 wires bundle.resources)

const DEFAULT_NODE_VERSION = '22.20.0' // satisfies dsh engines ^22.19.0 || >=24

/** platform-arch -> Tauri target triple metadata. */
const TRIPLES = {
  'win32-x64':    { triple: 'x86_64-pc-windows-msvc',   ext: '.exe', os: 'win',    arch: 'x64' },
  'win32-arm64':  { triple: 'aarch64-pc-windows-msvc',   ext: '.exe', os: 'win',    arch: 'arm64' },
  'darwin-x64':   { triple: 'x86_64-apple-darwin',       ext: '',    os: 'darwin', arch: 'x64' },
  'darwin-arm64': { triple: 'aarch64-apple-darwin',      ext: '',    os: 'darwin', arch: 'arm64' },
  'linux-x64':    { triple: 'x86_64-unknown-linux-gnu',  ext: '',    os: 'linux',  arch: 'x64' },
  'linux-arm64':  { triple: 'aarch64-unknown-linux-gnu', ext: '',    os: 'linux',  arch: 'arm64' },
}

function parseArgs(argv) {
  const opts = { triple: undefined, nodeVersion: DEFAULT_NODE_VERSION, nodeBin: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--triple') opts.triple = argv[++i]
    else if (a === '--node-version') opts.nodeVersion = argv[++i]
    else if (a === '--node-bin') opts.nodeBin = argv[++i]
    else throw new Error(`unknown option: ${a}`)
  }
  return opts
}

function resolveTriple(over) {
  if (over) {
    const hit = Object.values(TRIPLES).find((t) => t.triple === over)
    if (!hit) throw new Error(`unsupported --triple ${over}`)
    return hit
  }
  const key = `${process.platform}-${process.arch}`
  const hit = TRIPLES[key]
  if (!hit) throw new Error(`unsupported platform/arch ${key}`)
  return hit
}

function sidecarName(t) {
  return `dsh-host-${t.triple}${t.ext}`
}

function nodeDistUrl(version, t) {
  const base = `https://nodejs.org/dist/v${version}/node-v${version}-${t.os}-${t.arch}`
  return t.os === 'win' ? `${base}.zip` : `${base}.tar.gz`
}

/** Quote one command-line argument that contains whitespace or quotes. */
function quoteArg(a) {
  return /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
}

/**
 * Run an external command. On Windows, `.cmd` shims (pnpm) are not directly
 * spawnable, so route through `cmd /d /s /c`; args containing spaces are
 * quoted. Other platforms spawn directly.
 */
function run(cmd, args, opts) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  if (opts.dryRun) return
  const r = process.platform === 'win32'
    ? spawnSync('cmd', ['/d', '/s', '/c', [cmd, ...args].map(quoteArg).join(' ')], { stdio: 'inherit' })
    : spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.error) throw new Error(`${cmd} failed to start: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} exited with ${r.status}`)
}

function ensureNodeRuntime(opts) {
  const t = resolveTriple(opts.triple)
  const out = join(BINARIES, sidecarName(t))
  if (existsSync(out)) {
    console.log(`sidecar already present: ${out}`)
    return out
  }
  if (opts.nodeBin) {
    console.log(`copying local node binary -> ${out}`)
    if (!opts.dryRun) {
      mkdirSync(BINARIES, { recursive: true })
      cpSync(opts.nodeBin, out)
    }
    return out
  }
  // M0 does not implement network download + archive extraction (needs system
  // tar on Windows; CI concern in M3). Print the intended URL for reference.
  console.log(`[download not implemented in M0] intended: ${nodeDistUrl(opts.nodeVersion, t)}`)
  console.log(`hint: pass --node-bin <node executable> to assemble without a download.`)
  throw new Error('no node runtime source: pass --node-bin or run on CI (M3 implements download)')
}

/**
 * Prune sourcemaps / TypeScript declarations from the installed host bundle.
 *
 * Why: npm's flat node_modules still contains deep .map / .d.ts files (e.g.
 * @mistralai/mistralai, @opentelemetry/*). Resolved from a long project-root
 * path they exceed Windows MAX_PATH (260), and makensis (NSIS, 32-bit, not
 * long-path-aware) aborts bundling with "failed opening file …d.ts.map".
 * These files are dev-only (sourcemaps / type declarations), never needed at
 * runtime — pruning fixes packaging and shrinks the installer.
 */
function pruneHostBundle(appDir, opts) {
  if (opts.dryRun) {
    console.log('[dry-run] would prune *.map / *.d.ts from host bundle')
    return
  }
  let removed = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name))
      } else if (entry.isFile() && (entry.name.endsWith('.map') || entry.name.endsWith('.d.ts'))) {
        rmSync(join(dir, entry.name), { force: true })
        removed++
      }
    }
  }
  walk(appDir)
  console.log(`pruned ${removed} non-runtime files (*.map / *.d.ts) from host bundle`)
}

function prepareHostBundle(opts) {
  const appDir = join(RESOURCES, 'app')
  console.log(`installing deepseek-harness-desktop production deps (npm, flat) -> ${appDir}`)
  // Fresh staging dir carrying the desktop package.json (the 205
  // @deepseek-ai/* deps, incl. peer @deepseek-ai/cordis-plugin-group).
  if (!opts.dryRun) {
    rmSync(appDir, { recursive: true, force: true })
    mkdirSync(appDir, { recursive: true })
    cpSync(join(PKG_ROOT, 'package.json'), join(appDir, 'package.json'))
  }
  // npm produces a flat, self-contained node_modules (no .pnpm store) — pnpm's
  // isolated layout (.pnpm hash dirs + junctions) exceeds Windows MAX_PATH(260)
  // and breaks makensis/NSIS. npm flat is far shorter, but deep .map/.d.ts
  // files + a long project root can still cross 260, so prune right after
  // install (see pruneHostBundle). Native modules (node-pty/koffi) compile via
  // npm install scripts.
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefix', appDir.replace(/\\/g, '/')], opts)
  // Dev-only sourcemaps / type declarations would exceed MAX_PATH when bundled
  // (see pruneHostBundle) — remove them before tauri build packages this dir.
  pruneHostBundle(appDir, opts)
  // The host lives under the installed dependency, not the bundle root.
  const bin = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!opts.dryRun && !existsSync(bin)) {
    throw new Error(`installed host missing ${bin}`)
  }
  return bin
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const t = resolveTriple(opts.triple)
  const name = sidecarName(t)
  console.log(`[deepseek-harness-desktop sidecar] target=${t.triple} node=${opts.nodeVersion} dryRun=${opts.dryRun}`)
  if (opts.dryRun) {
    console.log('-- dry-run: steps below are NOT executed --')
    console.log(`  sidecar  -> ${join(BINARIES, name)}`)
    console.log(`  hostBundle-> ${join(RESOURCES, 'app')}  (pnpm --filter @deepseek-ai/dsh deploy)`)
    console.log(`  node runtime: ${opts.nodeBin ?? nodeDistUrl(opts.nodeVersion, t)}`)
    return 0
  }
  rmSync(RESOURCES, { recursive: true, force: true })
  mkdirSync(RESOURCES, { recursive: true })
  ensureNodeRuntime(opts)
  prepareHostBundle(opts)
  console.log(`[deepseek-harness-desktop sidecar] done. sidecar=${join(BINARIES, name)} hostBundle=${join(RESOURCES, 'app')}`)
  return 0
}

process.exitCode = main()
