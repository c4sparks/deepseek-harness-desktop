#!/usr/bin/env node
/**
 * apply-codex-shrink.mjs — codex 瘦身处理（**可移除**）。
 *
 * 对已安装的宿主（resources/app）：
 *   1. 剪掉 `@openai/codex-<平台>` 平台二进制（~374MB），保留 `@openai/codex` 16K 包装
 *      （dsh-subagent-codex 加载时要 resolve 它）。
 *   2. patch `dsh-subagent-codex`：让 codex 解析优先 `process.env.CODEX_BIN`（壳注入 ~/.dsh/bin/codex）。
 *
 * 为什么独立成脚本：**上游 deepseek-harness 若原生支持 codex 走 PATH / CODEX_BIN，
 * 删除 package-sidecar.mjs 里对它的调用即可 → codex 保持原始体积（374M 打进安装包）**。
 *
 * 移除点（上游支持后）：
 *   1. `scripts/package-sidecar.mjs` 里调用本脚本的那一行
 *   2. `native/src/lib.rs` 的 `CODEX_BIN` env（sidecar spawn 处）
 *   3. `native/src/lib.rs` 的 `maybe_fetch_tools` 里 `fetch-codex.mjs` 那一项
 *   （`scripts/fetch-codex.mjs` 可留，无害）
 *
 * 用法：
 *   node scripts/apply-codex-shrink.mjs <appDir> [--dry-run]
 */
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const appDir = args.find((a) => !a.startsWith('--'))
  if (!appDir) {
    console.error('用法: node scripts/apply-codex-shrink.mjs <appDir> [--dry-run]')
    return 2
  }

  let removed = 0

  // 1) 剪平台二进制（保留 16K 包装 @openai/codex）。
  const openaiDir = join(appDir, 'node_modules', '@openai')
  if (existsSync(openaiDir)) {
    for (const e of readdirSync(openaiDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('codex-') && e.name !== 'codex') {
        if (!dryRun) rmSync(join(openaiDir, e.name), { recursive: true, force: true })
        removed++
        console.log(dryRun ? `[dry-run] would prune ${e.name}` : `pruned ${e.name}`)
      }
    }
  }
  console.log(`[apply-codex-shrink] 剪掉 ${removed} 个 codex 平台包`)

  // 2) patch dsh-subagent-codex：CODEX_BIN 优先。
  const target = join(appDir, 'node_modules', '@deepseek-ai', 'dsh-subagent-codex', 'lib', 'index.js')
  if (!existsSync(target)) {
    console.log('[apply-codex-shrink] dsh-subagent-codex 不存在，跳过 patch')
    return 0
  }
  let code = readFileSync(target, 'utf8')
  const from = 'const CODEX_PACKAGE_BIN = resolve(dirname(codexPackageJsonPath), codexPackageManifest.bin.codex);'
  const to = 'const CODEX_PACKAGE_BIN = process.env.CODEX_BIN || resolve(dirname(codexPackageJsonPath), codexPackageManifest.bin.codex);'
  if (code.includes(to)) {
    console.log('[apply-codex-shrink] CODEX_BIN patch 已存在')
    return 0
  }
  if (!code.includes(from)) {
    console.warn('[apply-codex-shrink] ⚠ 未找到 codex 解析行，patch 未生效（上游可能已改？）')
    return 1
  }
  if (!dryRun) writeFileSync(target, code.replace(from, to), 'utf8')
  console.log(dryRun ? '[apply-codex-shrink] [dry-run] would patch CODEX_BIN 优先' : '[apply-codex-shrink] patched dsh-subagent-codex: CODEX_BIN 优先')
  return 0
}

process.exitCode = main()
