# DeepSeek Harness Desktop

**DeepSeek Harness Desktop** —— 基于 **Tauri v2（Rust 外壳）+ Node sidecar** 的独立桌面应用。

外壳负责窗口与系统集成；内嵌的 Node 宿主与 `dsh web` 运行**完全相同的引擎**，窗口内就是 dsh 完整的界面。浏览器形态的全部能力原样保留，一份代码、双端形态。

## 与 DeepSeek Harness 的关系

DeepSeek Harness Desktop 是一个**薄壳**，是 DeepSeek Harness 的非官方桌面发行版：自身只包含 Rust 外壳（窗口、托盘、进程管理）与打包逻辑，**全部功能能力来自 deepseek-harness 发布的 npm 包**（`@deepseek-ai/*`：宿主 `@deepseek-ai/dsh` + 约 200 个插件），运行时由 sidecar 组装为宿主包（`resources/app`）。

这意味着：

- **能力跟随上游**：桌面端能做什么，取决于锁定的 `@deepseek-ai/*` 版本。deepseek-harness 发新版前，桌面端不会自动获得新功能或修复。
- **不实时联动源码**：桌面端不随 deepseek-harness 仓库源码更新而更新。升级靠一条命令更新依赖（见「快速开始」的「升级上游」）：`node scripts/sync-deps.mjs --version <上游版本>` → 重新组装 sidecar 与宿主包 → 重新打包。
- **版本锁定**：`@deepseek-ai/*@0.1.0-rc.6`（205 个）+ `@deepseek-ai/cordis-plugin-group@1.0.1`，固定精确版本以保证可复现安装。

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
3. **日常操作**：
   - 主界面即 dsh 完整工作台，直接开始对话、使用工具。
   - **托盘**：左键单击切换窗口显示/隐藏；右键菜单可退出应用。
   - **关闭窗口**：当前行为为退出应用（同时结束后台宿主进程）。
   - **深链**：打开 `dsh://…` 会唤起本应用窗口。
4. **数据与配置**：位于 `DSH_HOME`（默认 `~/.dsh`），与 dsh CLI / Web 版互相共用。

## 快速开始（开发）

> 三平台共用同一套构建流程，差异只在「工具链前置」和「打包命令」。下面先给**通用步骤**，再按平台列**特定差异**。

> ⚠️ `native/binaries/`（sidecar）与 `resources/app/`（宿主包）是**构建产物**，已 gitignore，**仓库里没有**——首次运行前必须先组装。

### 一、通用步骤（三平台相同）

**前置**：Rust、Node.js ≥ 22、pnpm。

```bash
# 1) 安装依赖
pnpm install

# 2) 组装 sidecar + 宿主包（首次必做；需要一个本地 Node ≥ 22 可执行文件）
node scripts/package-sidecar.mjs --node-bin <本平台 Node 路径>

# 3) 开发模式启动（编译 Rust 壳并拉起 sidecar）
pnpm dev
```

说明：

- `--node-bin` 需要一个本机 Node ≥ 22 可执行文件（`@deepseek-ai/dsh` 的 engines 要求）；脚本不会自动下载 Node。`--triple <目标>` 默认取当前平台，也可显式指定目标平台（分平台裁剪会跟随该目标），Windows x64 可不传。
- 修改宿主依赖后需重跑第 2 步（会重建 `resources/app`，较慢）。
- 首次 `pnpm dev` 会编译 Rust 壳，需较长时间属正常。

### 二、各平台特定步骤

#### Windows

**补充前置**：Rust **MSVC 工具链**（含 VS Build Tools C++ 工作负载）；Git Bash 通常需手动补 PATH：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

> 不用 Git Bash？等价写法：
> - **cmd**：`set PATH=%USERPROFILE%\.cargo\bin;%PATH%`
> - **PowerShell**：`$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`
>
> 提示：rustup 安装时通常已把 `%USERPROFILE%\.cargo\bin` 写入用户 PATH，只有 Git Bash 在 rustup 安装**之后**才打开（PATH 未刷新）时才需要手动补。

```bash
# 组装 sidecar（node 为 .exe）
node scripts/package-sidecar.mjs --node-bin /path/to/node.exe

pnpm dev

# 打包 Windows NSIS 安装包（会重新组装 sidecar + 宿主包，较慢）
pnpm build
```

#### macOS

**补充前置**：`xcode-select --install`（Xcode 命令行工具）。

```bash
# 组装 sidecar（node 无扩展名）
node scripts/package-sidecar.mjs --node-bin $(which node)

pnpm dev

# 打包（.app + dmg）
cd native && tauri build --bundles dmg
```

#### Linux

**补充前置**：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

```bash
# 组装 sidecar（node 无扩展名）
node scripts/package-sidecar.mjs --node-bin $(which node)

pnpm dev

# 打包（deb + AppImage）
cd native && tauri build --bundles deb appimage
```

### 三、可选：启用"Claude Code 子 agent"（按需）

安装包不含 Claude 二进制（原因见「注意事项」）。需要"Claude Code 子 agent"功能的机器按需启用：

```bash
# 1) 把真实 claude 装到 ~/.dsh/bin
node scripts/fetch-claude.mjs

# 2) 把 ~/.dsh/bin 加到 PATH 最前（否则 npm 的 claude.cmd shim 先被命中 → 启动报 EINVAL）
```

完成后 dsh 即可从 PATH 解析 claude 并启用该子 agent。

### 四、注意事项

- **组装 sidecar + 宿主包必须在目标平台本机执行**：`npm install` 会把 node-pty / koffi 等原生模块按**当前平台**编译，跨平台不通用。
- **跨平台交叉出包不可行**（在 Windows 打 mac / Linux 包），需在对应平台本机或 CI 构建。
- **macOS / Linux 不要直接跑 `pnpm build`**（内部是裸 `tauri build`）：`native/tauri.conf.json` 的 `bundle.targets` 目前为 `["nsis"]`（Windows 专属），会按 nsis 出包、不产出 dmg / deb / AppImage，且 `package-sidecar.mjs` 缺 `--node-bin` 时没有 node 来源。要么用 `--bundles` 覆盖，要么把 `bundle.targets` 改为目标平台（如 `["dmg"]` / `["deb","appimage"]`）。
- **打包路径超限（Windows）**：npm 扁平 bundle 的深层 `.map` / `.d.ts`（传递依赖）在长项目路径下可能超 Windows MAX_PATH(260)，makensis 会中止打包（`failed opening file …`）。`scripts/package-sidecar.mjs` 已在 `npm install` 后自动清理这些运行时不需要的文件；如仍报错，多半是项目路径过长（换短路径）或存在其他超长路径文件。
- **Claude Agent SDK 外部化**：`@anthropic-ai/claude-agent-sdk-*` 平台二进制文件，不打进安装包——`dsh-subagent-claude-code` 插件从 PATH 解析 `claude` 并作为 `pathToClaudeCodeExecutable` 交给 SDK，不使用内置包（实测 SDK 需要真实可执行文件，npm 的 `.cmd` shim 会 `spawn EINVAL`）。需要"Claude Code 子 agent"功能的机器运行 `node scripts/fetch-claude.mjs` 把 claude 装到 `~/.dsh/bin` 并加入 PATH 最前。
- `native/.cargo/config.toml`（本地盘 target 重定向）是 Windows **本机专属**配置，已被 gitignore；macOS / Linux 没有该文件，cargo 默认用 `native/target/`，无需处理。
- macOS / Linux 的 sidecar 是重命名后的 node 可执行文件，需具备可执行权限（`--node-bin` 指向的 node 自带，复制后一般保留；异常时可 `chmod +x native/binaries/dsh-host-*`）。
- `native/icons/` 已含各平台图标（icns / png），无需重新生成。
- 打包出的**正式分发包**仍需代码签名 / 公证；本地打包验证不需要。

### 升级上游deepseek-ai包（deepseek-harness 发版后）


```bash
# 1) 查看可用版本（先列出，挑一个再升级）
node scripts/sync-deps.mjs --list

# 2) 上游增删了包时，先重新生成清单（从 module-graph.md），再对账
node scripts/sync-deps.mjs --refresh-manifest

# 3) 更新 @deepseek-ai/* 依赖版本（--sync 按 scripts/dsh-manifest.json 对账：补缺失 / 删残留 / 改版本）
node scripts/sync-deps.mjs --version <deepseek-ai包版本> --sync

# 4) 改完重新组装 + 打包
pnpm build
```

### 修改应用版本（发版时）

```bash
# 应用自身版本（package.json / tauri.conf.json / Cargo.toml / Cargo.lock 四处同步）
node scripts/sync-deps.mjs --app-version <应用新版本>
```

> `--dry-run` 可先预览不改文件。依赖版本 `--version` 与应用版本 `--app-version` 互不干扰。

## 目录结构

```
dsh-desktop/
├── src/            # 启动加载页（loading / 错误页）
├── native/         # Rust 外壳（Cargo 配置、tauri.conf.json、Rust 源码）
│   ├── binaries/   # sidecar 二进制（dsh-host，构建时生成）
│   └── icons/      # 应用图标（构建时生成，源图在 assets/）
├── assets/         # 设计源资产（图标源图 app-icon.png）
├── scripts/        # 构建脚本（sidecar 打包）
└── resources/app   # 宿主包（构建时生成）
```

## 技术说明

- 桌面版 = **Rust 外壳 + 一个与 `dsh web` 完全相同的 Node 宿主 + 指向它的 WebView**。通信走本机 `127.0.0.1`（HTTP + WebSocket），前端代码零改动复用。
- 当前仅 Windows（NSIS 安装包）；macOS / Linux 出包、代码签名、自动更新等发布能力尚未启用。

## 致谢

- **DeepSeek Harness** —— 本项目全部功能能力来自其宿主与插件生态，桌面壳只是它的一个入口。
- 以及所有直接或间接依赖的开源项目与贡献者。
