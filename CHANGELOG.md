# 更新记录（Changelog）

> 本文件按**项目版本**记录本项目的升级改动点；dsh 依赖升级是改动内容之一。
>
> **格式约束（勿乱写，工具依赖它）**：
> - 每条版本**第一行标题**必须是 `## [<版本号>]（<日期>）— <标题>`（`build:local` 用正则取第一处做版本一致性校验）。
> - 版本号格式 `x.y.z`（可带 `-rc.N`/`-alpha.N`/`-beta.N`），且必须与 `bump-version` 后的 app 版本一致。
> - 建议分节：新增 / 变更 / 修复 / 依赖升级 / 升级要点。
> - 发版顺序：先 `bump-version <新版本>` → 更新 CHANGELOG 顶部该版本条目 → `pnpm build:local`（校验一致性）。

## [0.2.0]（2026-08-30）— 双通道架构 + 依赖闭包

**新增**
- **源码通道**：跟随 deepseek-harness 源码构建依赖闭包，可试跑未发布到 npm 的代码（如 `0.1.2-alpha.1`）
- 脚本 `scripts/build-closure.mjs`（双模式：`--version` npm 模式 / `--source` source 模式）
- 版本 ledger `scripts/dsh-releases.json`（每次构建记录）
- 本地打包入口 `scripts/build-local.mjs`（`pnpm build:local`：只打包不改版本；打包前检查版本 vs CHANGELOG / 4 处一致 + 确认 + 产物验证）
- 独立版本脚本 `scripts/bump-version.mjs`（应用版本同步 4 处，**提前执行**，与 dsh 依赖升级解耦）
- 本文件 `CHANGELOG.md`

**变更**
- 依赖配方从根 `package.json` 的 210 行收敛到**依赖闭包** `deepseek-harness/package.json`；根 `package.json` 只声明 `"deepseek-harness": "file:./deepseek-harness"`
- `scripts/package-sidecar.mjs` 统一从闭包装宿主依赖（两条通道同一代码路径）
- 命名统一：**npm 通道 / 源码通道**（原"预览通道"）
- 文档：README 精简为使用说明，原理移到 `docs/FAQ.md`、设计文档
- `pnpm run` 关闭依赖预校验（`.npmrc` `verify-deps-before-run=false`）：source 模式闭包引用未发布版本，预校验会拦下所有 pnpm run；宿主依赖由 package-sidecar 用 npm 装
- **版本校验策略**：项目版本（`bump-version`）保留格式校验（cargo/tauri 要求 semver）；上游 dsh 版本（`build-closure --version` / `sync-deps --version`）**不拦格式**，registry 确认不了就中止（上游格式不必是 `x.y.z[-rc]`）
- 新增 package.json 别名：`build:closure` / `sync:list` / `sync:manifest`；`sync-deps --version`（旧流程写 root 依赖）已过时，升版本职责在 `build-closure`
- 启动加载页重设计：雷达脉冲 + 径向微光背景（告别纯黑屏），尊重 `prefers-reduced-motion`
- **claude 子 agent 自动按需**：`fetch-claude.mjs` 增强（PATH 探测：已有真实 claude 直接用、无才下载；
  下载源默认 npmmirror 国内镜像、`DSH_NPM_REGISTRY` 可覆盖）+ 打进安装包，桌面启动后台静默 `--auto`；
  壳把 `~/.dsh/bin` 注入 sidecar PATH（无需用户手动配 PATH）。失败不影响主程序，不干扰用户自定义安装
- **codex 子 agent 自动按需 + 瘦身**：剪掉 `@openai/codex-*` 平台二进制（374M，宿主 601M→228M，
  安装包预计 138M→~65M）；新增 `fetch-codex.mjs` 下载到 `~/.dsh/bin`；`dsh-subagent-codex` 一行 patch
  支持 `CODEX_BIN` 环境变量（壳注入）；下载源统一到 `scripts/lib/registry.mjs`（npmmirror 默认）。
  **codex 处理独立成 `scripts/apply-codex-shrink.mjs`**（可移除）：上游支持后删 package-sidecar 一行调用
  + lib.rs 的 `CODEX_BIN` env + `maybe_fetch_tools` codex 项 → codex 保持原始体积（374M 打包进安装包）。
  claude 处理为**永久**（走 PATH，不随上游移除）。
- **运行日志**：`~/.dsh/logs/desktop.log`——壳和 fetch-claude/fetch-codex 统一写（带时间戳，--auto 静默也写），
  排查后台下载/配置操作是否正常

**依赖升级**
- npm 通道锁定 `@deepseek-ai/*@0.1.1-rc.2`（npm 已发布最新）
- 源码通道基于 deepseek-harness **源码 0.1.2-alpha.1**（尚未发布 npm）构建宿主

**修复**
- **浏览器认证 401**：dsh 0.1.2-alpha.1 起用浏览器认证——宿主根 URL 带 `?token=<launchToken>`，客户端
  打开它才被签发 session cookie（`packages/client/connection/src/browser-auth.ts`）。旧桌面壳
  `readiness_url` 只提取 `http://127.0.0.1:<port>`、**丢弃 `?token=`**，WebView 导航到无 token 的
  URL → dsh 返回 401「authentication required」。修复：壳保留完整 URL（含 token），WebView/浏览器
  打开即完成认证。**需重建壳生效**（`pnpm dev` 或重新打包）。

**升级要点**
- npm 通道：`pnpm run sync:list` → `pnpm run sync:manifest -- --ref <标签>` → `pnpm run build:closure -- --version <新版本> --sync` → `pnpm build`
- 源码通道：`pnpm run build:closure -- --source <源码目录>` → `package-sidecar` → `cd native && tauri build`
- 改版本是**提前独立步骤**：`pnpm run bump:version -- <新版本>`（格式校验），再 `pnpm build`
