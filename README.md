# DeepSeek Harness Desktop

**基于 Tauri v2（Rust 外壳）+ Node sidecar 的独立桌面应用。**

外壳负责窗口与系统集成；内嵌的 Node 宿主与 `dsh web` 运行**完全相同的引擎**——窗口内就是 dsh 完整的界面。浏览器形态的全部能力原样保留，一份代码、双端形态。

**文档导航**：使用指南 [使用指南](./docs/使用指南.md) · 原理/排障 [FAQ](./docs/FAQ.md) · 发布 [部署与发布](./docs/部署与发布.md) · 贡献 [CONTRIBUTING](./docs/CONTRIBUTING.md) · 改动点 [CHANGELOG](./CHANGELOG.md)

## 与 DeepSeek Harness 的关系

DeepSeek Harness Desktop 是**薄壳**（非官方桌面发行版）：自身只有 Rust 外壳（窗口/托盘/进程管理）+ 打包逻辑，
**全部能力来自 deepseek-harness 的 `@deepseek-ai/*` 包族**（宿主 `@deepseek-ai/dsh` + 一批插件），由
sidecar 组装为宿主包。能力跟随锁定的 `@deepseek-ai/*` 版本，依赖经**依赖闭包**统一管理：

- **依赖闭包**：`deepseek-harness/package.json`——两条更新通道从这里取依赖
  - **npm 通道**：锁已发布版本
  - **源码通道**：从本地 deepseek-harness 源码构建闭包

## 功能特性

### 完整的 dsh 能力

桌面窗口内即 dsh 完整工作台（与 Web 版同一份界面、同一套接口）：

- **AI agent 会话**：多轮对话、计划（goal）、子 agent 协作
- **工具执行**：bash / 终端（PTY）、文件读写与搜索、网页抓取与搜索等
- **模型管理**：模型选择与配置
- **会话管理**：历史会话、会话导出
- **设置与反馈**：设置面板、消息反馈等完整交互

### 桌面原生体验

- **独立窗口**：默认 1280×800，可缩放
- **系统托盘 + 菜单**：左键单击切换窗口显示/隐藏；右键菜单可显示/隐藏/退出
- **侧车模式（设置项 `trayMode`）**：无窗口后台运行，托盘左键/菜单在默认浏览器打开原始 dsh（`http://127.0.0.1:<port>`）；托盘菜单「切换为侧车模式/切换为窗口模式」随时切换并记住选择（写入 `$DSH_HOME/desktop-settings.json`）；「打开桌面窗口」可临时切回内嵌窗口——两个形态共享同一宿主
- **可配置 profile（设置项 `profile`）**：启动哪个 dsh profile 不写死——读取 `$DSH_HOME/desktop-settings.json` 的 `profile`（默认 `web`，可设为任意 `$DSH_HOME/profiles/` 下的名字，如 `desktop`）；托盘「切换 Profile」随时切换并重启宿主。桌面端可与 Web 端共用或隔离各自的插件集
- **系统通知**：宿主启动失败时桌面提醒
- **深链 `dsh://`**：在浏览器或命令行打开 `dsh://…` 唤起并聚焦已有窗口（运行中与冷启动均支持）
- **单实例**：重复启动自动唤起已有窗口，不另开进程
- **崩溃自愈**：宿主异常退出自动指数退避重启；多次失败后显示错误页，可手动重试
- **干净退出**：关闭窗口即退出应用，后台宿主进程同步结束，无残留

### 数据一致与安全

- 与 dsh CLI / Web 版**共享同一份数据**：`DSH_HOME`（默认 `~/.dsh`）下的会话、配置、预设
- 宿主只监听本机 `127.0.0.1`，不对外暴露；WebView 使用严格 CSP

## 使用

1. **安装**：运行 Windows 安装包（`deepseek-harness-desktop_<版本>_x64-setup.exe`，NSIS）。
2. **启动**：从开始菜单或桌面快捷方式打开。首次启动先显示加载页，就绪后自动进入完整界面。
   > ⚠️ **首次启动会在后台自动安装部分可选依赖**（"Claude Code 子 agent"的 claude、"codex 子 agent"的
   > codex，需联网）。已下载后不会重复下载。**下载失败不影响主程序**——只是对应子 agent
   > 暂不可用，可查日志 `~/.dsh/logs/desktop.log` 看原因。
3. **日常操作**：
   - 主界面即 dsh 完整工作台，直接开始对话、使用工具。
   - **托盘**：左键单击切换窗口显示/隐藏；右键菜单可退出应用。
   - **侧车模式**：托盘右键菜单选「切换为侧车模式」即可（窗口隐藏、托盘左键/菜单在默认浏览器打开原始 dsh），选择会被记住；也可直接编辑设置文件 `$DSH_HOME/desktop-settings.json` 的 `trayMode`（`true`/`false`）后重启应用。再次切换用托盘菜单「切换为窗口模式」。
   - **关闭窗口**：窗口模式为退出应用（同时结束后台宿主进程）；侧车模式下关窗仅隐藏，退出请用托盘「退出」。
   - **深链**：打开 `dsh://…` 会唤起本应用窗口（侧车模式下则打开浏览器）。
4. **数据与配置**：位于 `DSH_HOME`（默认 `~/.dsh`），与 dsh CLI / Web 版互相共用；桌面端启动行为（`trayMode` 侧车模式、`profile` 启动的 dsh profile）设置在 `$DSH_HOME/desktop-settings.json`。

## 快速开始（开发）

> 前置：Rust、Node.js ≥ 22、pnpm。各平台前置依赖见 [FAQ](./docs/FAQ.md)「构建环境」。

```bash
# 1) 安装依赖
pnpm install

# 2) 组装 sidecar + 宿主包（首次必做；--node-bin 填本机 Node ≥ 22 路径）
node scripts/package-sidecar.mjs --node-bin <本平台 Node 路径>

# 3) 开发模式启动
pnpm dev
```

### 打包（平台差异只在打包命令）

| 平台 | 打包 | 产物 |
|---|---|---|
| Windows | `pnpm build` | NSIS 安装包 |
| macOS | `cd native && tauri build --bundles dmg` | .app + dmg |
| Linux | `cd native && tauri build --bundles deb appimage` | deb + AppImage |

> ⚠️ sidecar + 宿主必须在目标平台本机组装（原生模块按平台编译）；`pnpm build` 是 Windows 专属（`bundle.targets` 为 nsis）。

### 升级（npm 通道，deepseek-harness 发版后）

```bash
pnpm run sync:list                                     # ① 查看可用版本
pnpm run sync:manifest -- --ref dsh-v<版本>            # ② 上游增删包时刷清单（必须用 git 标签，别用 master）
pnpm run build:closure -- --version <新版本> --sync   # ③ 生成 npm 模式闭包
pnpm build                                             # ④ 重新组装 + 打包
```

### 源码通道（跟随 deepseek-harness 源码）

```bash
node scripts/build-closure.mjs --source <源码目录>     # ① 生成 source 模式闭包（源码目录需已构建）
pnpm build                                             # ② 统一打包（组装宿主 + 出安装包）
```

**切换通道 = 重跑 `build-closure` 对应模式，然后统一 `pnpm build`**：

- **npm 通道**（正式版，用已发布版本）：`pnpm run build:closure -- --version <版本> --sync` → `pnpm build`
- **源码通道**（最新源码）：`node scripts/build-closure.mjs --source <源码目录>` → `pnpm build`

> 两条通道**唯一区别**是 `build-closure` 的入参（`--version` 用 npm / `--source` 用源码），组装和打包完全相同（`pnpm build`）。
> 两通道**共享 `~/.dsh`**：源码版仅向前（试用前备份 `~/.dsh`）、别同时跑两个通道。日常/发布用 npm 通道，追最新源码用源码通道。

### 修改应用版本（发版时）

```bash
node scripts/bump-version.mjs <新版本>   # 提前执行：同步 package.json/tauri.conf.json/Cargo.toml/Cargo.lock
pnpm build                               # build 只打包，不改版本
```

> 版本格式 `x.y.z`（可带 `-rc.N`/`-alpha.N`/`-beta.N`），非法拒绝写入；**低于当前版本会警告 + 确认**
> （`--yes` 放行）。本地便利入口 `pnpm build:local`：打包前检查版本一致性。

## 目录结构

```
dsh-desktop/
├── src/            # 启动加载页（loading / 错误页）
├── native/         # Rust 外壳（Cargo 配置、tauri.conf.json、Rust 源码）
│   ├── binaries/   # sidecar 二进制（dsh-host，构建时生成）
│   └── icons/      # 应用图标（构建时生成，源图在 assets/）
├── assets/         # 设计源资产（图标源图 app-icon.png）
├── scripts/        # 构建/维护脚本（package-sidecar / build-closure / bump-version / build-local / sync-deps / fetch-claude / fetch-codex / apply-codex-shrink / dsh-releases.json / lib）
├── deepseek-harness/  # 依赖闭包（build-closure.mjs 生成，已 gitignore）
├── .npmrc          # pnpm 配置（verify-deps-before-run=false，关预校验）
└── resources/app   # 宿主包（构建时生成）
```

## 技术说明

- 桌面版 = **Rust 外壳 + 一个与 `dsh web` 完全相同的 Node 宿主 + 指向它的 WebView**。通信走本机 `127.0.0.1`（HTTP + WebSocket），前端代码零改动复用。
- 当前仅 Windows（NSIS 安装包）；macOS / Linux 出包、代码签名、自动更新等发布能力尚未启用。

## 致谢

- **DeepSeek Harness** —— 本项目全部功能能力来自其宿主与插件生态，桌面壳只是它的一个入口。
- 以及所有直接或间接依赖的开源项目与贡献者。
