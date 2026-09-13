# DSH Desktop Builder

从上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动构建 Windows x64 桌面安装包，
并用一层极小的品牌覆盖保持"跟随上游更新"的能力。

上游 `apps/desktop` 是官方 Electron 桌面端，它把 **Electron 壳版本和 `@deepseek-ai/dsh` 版本绑定为同一个
发行号** —— 每次 dsh 更新都必须重新产出一个桌面安装包。本仓库不复刻这套壳，只把"重新打包"这件事自动化。

```
取上游修订  →  锚点式品牌覆盖  →  官方打包流程  →  安装包
```

## 另一台电脑怎么用

两条独立的路，按目的选一条，不要混：

| 目的 | 做法 | 那台电脑要装什么 |
|---|---|---|
| **只想用 DSH Desktop** | 到 [Releases](../../releases) 下载 `deepseek-harness-<版本>-win-x64.exe`，双击安装 | 什么都不用装 |
| **想自己重新打包** | 装齐下面的[前置条件](#前置条件windows-x64-构建机)，`git clone` 本仓库后跑 `./build.ps1` | Node / pnpm / Python / VS Build Tools，≥ 20 GB 磁盘 |

安装包走 **Release 附件**而不是仓库文件：它 171 MB，而 GitHub 对普通 git 文件有 100 MB 硬限制，塞进仓库根本推不上去。

> 安装包是 **unsigned** 的，Windows SmartScreen 首次会拦一次：点「更多信息 → 仍要运行」。这是没有 EV 代码签名
> 证书的必然结果，不是包损坏。

装完首次启动要在应用内配置模型凭据（provider 的 API key）。凭据既不在这个仓库里，也不在安装包里，两台电脑
各自配各自的，互不影响。

## ⚠️ 默认跟踪 master，不是最新 tag

这是实测踩出来的结论，不是偏好：

- tag `dsh-v0.1.5-rc.2` 上**没有** `package:desktop:win:x64:unsigned` 脚本，也**没有** `DSH_DESKTOP_UNSIGNED`，
  `win.forceCodeSigning` 硬编码为 `true`。也就是说**从该 tag 出发，未签名构建在物理上不可能**。
- 未签名支持是 tag 之后才进 master 的；master 领先该 tag **139 个提交**。

所以默认 `-Channel master`。等上游发布包含未签名支持的新 tag 后，可以切到 `-Channel stable`。

## 前置条件（Windows x64 构建机）

| 依赖 | 版本 | 说明 |
|---|---|---|
| PowerShell | 5.1+ | Windows 自带即可，**不需要** PowerShell 7 |
| Node.js | `^22.19 \|\| >=24` | 建议 24；品牌覆盖脚本需要它在 PATH 上 |
| pnpm | `11.7.0` | 必须与 harness 的 `packageManager` 一致 |
| Python | 3.x | **不能是 Microsoft Store 的跳转桩**，原生模块编译需要 |
| Visual Studio Build Tools | C++ 工作负载 | `node-pty` 等原生模块需要 |
| 磁盘 | ≥ 20 GB | Electron + 内置 Node.js + pnpm + 完整生产依赖树 |

国内网络建议先设置镜像，否则 Electron 二进制和上游 Node.js 归档会下载失败：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:npm_config_registry = 'https://registry.npmmirror.com'
```

## 在另一台构建机上开工

```powershell
git clone https://github.com/Jasongeng/dsh-desktop-builder.git
cd dsh-desktop-builder
```

`harness/` 和 `dist/` 都在 `.gitignore` 里，所以克隆下来只有 8 个源文件、几百 KB。`build.ps1` 首次运行时会
自动把上游克隆到 `harness/`，不需要手工执行 `git submodule add`。

要改用你自己的 fork，重指远程即可：

```powershell
git remote set-url origin <你的仓库地址>
```

可选的品牌设置：

```powershell
$env:DSH_DESKTOP_APP_ID = 'com.yourorg.dsh'      # 必填，反向 DNS；不设会退回 com.example.dsh-desktop
$env:DSH_DESKTOP_PRODUCT_NAME = 'DSH Desktop'    # 可选，默认 DeepSeek Harness
```

把 `.ico` 放到 `branding/icon.ico` 即可换图标（需含 256×256）。没有图标时构建沿用 Electron 默认图标，
不会失败。需要一张临时图标时：

```powershell
./branding/make-placeholder-icon.ps1 -Text DSH
```

## 构建

```powershell
# 默认：跟踪 origin/master（含未签名支持）
./build.ps1

# 最新稳定 tag（需要该 tag 已包含未签名支持，否则未签名构建会明确报错）
./build.ps1 -Channel stable

# 最新 tag，含 -rc / -alpha
./build.ps1 -Channel prerelease

# 指定上游修订
./build.ps1 -Ref dsh-v0.1.6

# 产出未打包的应用目录，便于排查
./build.ps1 -Dir

# 重复构建同一提交
./build.ps1 -Force
```

一次完整的打包会依次执行仓库构建（`build:official`）、打包 dsh 生产闭包、准备内置 Node.js 和 pnpm、
裁剪运行时文件、校验完整性，最后交给 electron-builder。首次构建通常需要 30–60 分钟。

打包命令优先复用上游已发布的根命令：签名走 `package:desktop:win:x64`，未签名走
`package:desktop:win:x64:unsigned`。只有 `-Dir` 组合没有对应的上游根命令，会直接调用
`@deepseek-ai/dsh-desktop` 的 `package` 脚本。

## 签名与更新

**签名模式不需要手工选择**，`build.ps1` 按四个环境变量自动判定：

| 状态 | 结果 |
|---|---|
| 四个 `DSH_DESKTOP_WINDOWS_*` 全部就绪 | EV 签名安装包 + electron-updater 更新元数据 |
| 任一缺失 / 路径不存在 / PIN 含非法字符 | unsigned 安装包，无更新源，手动分发 |

签名需要这四个输入，私钥始终留在 USB Token 上：

```powershell
$env:DSH_DESKTOP_WINDOWS_CER_FILE      = 'C:\path\to\server.cer'
$env:DSH_DESKTOP_WINDOWS_SIGNTOOL      = 'C:\path\to\signtool.exe'
$env:DSH_DESKTOP_WINDOWS_KEY_CONTAINER = '<SafeNet 私钥容器名>'
$env:DSH_DESKTOP_WINDOWS_TOKEN_PIN     = '<Token PIN>'   # 不能含 ] 引号 或换行
```

签名路径还必须指定更新源，否则打包会在写发行记录时失败：

```powershell
$env:DOWNLOAD_TEST_ORIGIN = 'https://your-host.example.com'   # 只能是 HTTPS 源，不能带路径
```

### 更新源布局

安装包内的 electron-updater 会请求：

```
<DOWNLOAD_TEST_ORIGIN>/_/harness/desktop/stable/win-x64/<通道>.yml
```

`build.ps1` 已经把这个目录结构生成在 `dist/<版本>-<commit>/feed/` 下，整目录同步到你的 HTTPS 主机即可。
通道文件名由版本决定：稳定版是 `latest.yml`，预发布版（如 `0.1.5-rc.2`）是 `rc.yml` —— 以实际产出的
`.yml` 文件名为准，不要写死。

> **注意**：`package.json` 的版本号在 master 上不会随提交变化。electron-updater 按版本比较，因此从
> master 连续构建出的两个包版本号相同，**自动更新不会把它们视为新版本**。需要真正的自动更新时，请用
> `-Channel stable` 从 tag 构建，或等上游 bump 版本号。

## 产物

```
dist/
  <上游版本>-<commit>/                         安装包、.blockmap、更新元数据、build-info.json
    feed/_/harness/desktop/stable/win-x64/     仅签名构建生成
  last-build.json                              最近一次构建的摘要，CI 也读这个文件
```

目录名带 commit 短哈希，是因为同一版本号下 master 的不同提交内容并不相同，只按版本号归档会互相覆盖。
`build-info.json` 记录了上游 ref、commit、打包模式、签名判定原因、appId、productName。

### 把本机构建发到 Release

本机 `build.ps1` 产出的安装包可以直接发成 Release，不需要等 CI 重跑一遍：

```powershell
$info = Get-Content dist/last-build.json -Raw | ConvertFrom-Json
$tag = "dsh-desktop-$($info.upstreamVersion)-$($info.upstreamCommit)"
gh release create $tag `
  --title "$($info.productName) $($info.upstreamVersion) ($($info.upstreamCommit))" `
  --notes "Revision: $($info.upstreamRef) / Mode: $($info.releaseMode)" `
  (Get-ChildItem "$($info.outputRoot)\*" -File).FullName
```

tag **必须**是 `dsh-desktop-<版本>-<commit>`：`.github/workflows/desktop.yml` 用这个 tag 判断某个组合是否
已经发布过，命中就直接跳过构建，所以手工发布的产物不会被 CI 重复覆盖。

## 源码覆盖层

`overlay/apply-overlay.mjs` 是本仓库对上游源码的**全部**改动，共 6 处锚点编辑，作用于 2 个文件：

| 文件 | 锚点 | 改动 |
|---|---|---|
| `apps/desktop/electron-builder.config.mjs` | `productName: 'DeepSeek Harness',` | 改为读 `DSH_DESKTOP_PRODUCT_NAME` |
| `apps/desktop/electron-builder.config.mjs` | `win: {` | 其后插入 `icon: env.DSH_DESKTOP_ICON,` |
| `apps/desktop/tests/fixtures/runtime-payload-smoke.mjs` | `checkFsExt` 相关 3 处 + `node:fs` import 行 | 删除对 `fs-ext` 的检查 |

`appId` 上游本来就走环境变量，无需覆盖。

### 为什么要删掉 fs-ext 检查

这是**上游的一个缺陷**，不是本地偏好。时间线：

1. `c58097a826` 引入 `fs-ext`，做会话写锁的 POSIX flock
2. `d927cbff99`（09-07）新增自研预编译 Node-API flock，
   `packages/session/session-persistence-jsonl/src/lease.ts` 改为 `@deepseek-ai/node-addon-system/flock`，
   **`fs-ext` 就此离开依赖图**
3. `fc7abdcfb5`（09-09，晚了 2 天）新增 `runtime-payload-smoke.mjs`，**却仍然 `require('fs-ext')`**

当前状态下 `fs-ext` 不在 `pnpm-lock.yaml`、不在任何 `package.json`、源码零引用，因此 `prepare:dsh` 的
这个校验**在任何机器上都不可能通过**，`package:desktop:win:x64` 在 master 上是坏的。本仓库删除该检查，
让打包继续进行。

> 这是上游问题，建议向 deepseek-harness 提 issue。等上游修复后，删掉 `apply-overlay.mjs` 里对应的三条
> 编辑即可恢复原样。

### 为什么不用 `.patch` 文件

第一版用行上下文补丁，结果在 tag 上直接失败 —— 补丁是针对 master 生成的，而 tag 上 `win: {` 后面那行是
`forceCodeSigning: true`，master 上已经变成 `forceCodeSigning: !unsigned`。上下文对不上就整体失败。

锚点匹配现在同时满足：

- 跨版本可用：同一份覆盖在 tag 和 master 上都能用（已实测）；
- 幂等：重复执行输出 `already applied`；
- 严格：锚点匹配数不等于 1 就报错退出，**不会静默产出错误品牌的包**；
- 保留原文件的行尾风格（CRLF 或 LF）。

上游若改动任一锚点，`build.ps1` 会在第 2 步明确失败，此时改 `overlay/apply-overlay.mjs` 里的
`pattern` / `replace` 即可。

## 持续跟进

`.github/workflows/desktop.yml` 每天探测一次上游 `origin/master`，发现新提交就构建并发布到 GitHub
Release，已发布过的 `版本-commit` 组合自动跳过。

Hosted runner 接触不到 SafeNet Token，所以 **CI 只能产出 unsigned 安装包**。需要 EV 签名的正式版本必须在
持有 Token 的 Windows 机器上运行 `build.ps1`。

需要在 CI 里固定品牌时，把 `DSH_DESKTOP_APP_ID` / `DSH_DESKTOP_PRODUCT_NAME` 配成仓库 Variables。

## 脚本编码约定

`*.ps1` 里的字符串**全部使用 ASCII**，这是刻意的：Windows PowerShell 5.1 会用系统 ANSI 代码页
（本机为 936/GBK）读取无 BOM 的文件。中文若以 UTF-8 无 BOM 保存，会被误解码成乱码，全角标点甚至可能
吞掉紧跟的 `$`，直接破坏脚本语法（表现为 `The string is missing the terminator`）。中文说明放在
Markdown（`README.md`）里，PowerShell 不会去解析它。

`build.ps1` 写出的 JSON 一律为无 BOM 的 UTF-8，避免严格的 JSON 读取方解析失败。

`.gitattributes` 固定了 `* text=auto eol=lf`，并给 `overlay/*.patch` 加了 `-text` —— 如果以后新增
行上下文补丁，Windows 的 `core.autocrlf` 会把它改成 CRLF 从而让 `git apply` 上下文匹配失败。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `overlay patch ... did not apply` | 旧版补丁机制的错误；本仓库已改成锚点覆盖，请确认用的是 `overlay/apply-overlay.mjs` |
| `revision ... does not support unsigned Windows builds` | 该 tag 早于未签名支持。改用 `-Channel master`，或提供 EV 签名输入 |
| `anchor "..." matched 0 times` | 上游改动了品牌锚点，更新 `overlay/apply-overlay.mjs` |
| `pnpm install` 卡在 Electron 下载 | 设 `ELECTRON_MIRROR` / `npm_config_registry` |
| 原生模块编译失败 | Python 是 Store 跳转桩，或缺少 VS C++ Build Tools |
| `desktop version ... does not match dsh version` | 上游把壳版本和 dsh 版本解绑了；说明设计变了，需要重新评估本仓库 |
| 签名构建报更新源缺失 | 设置 `DOWNLOAD_TEST_ORIGIN`，或改用 `-Dir` 做本地验证 |
| `win-x64 requires a Windows x64 build host` | 打包只能在 Windows x64 上跑 |
| PowerShell 报 `Unexpected token '}'` | 脚本被改成了含中文的无 BOM UTF-8；恢复为 ASCII 或另存为 UTF-8 with BOM |
