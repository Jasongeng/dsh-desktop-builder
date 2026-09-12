# DSH Desktop Builder

从上游 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 自动构建 Windows x64 桌面安装包，
并用一层极小的品牌覆盖保持"跟随上游更新"的能力。

上游 `apps/desktop` 是官方 Electron 桌面端，它把 **Electron 壳版本和 `@deepseek-ai/dsh` 版本绑定为同一个
发行号** —— 每次 dsh 更新都必须重新产出一个桌面安装包。本仓库不复刻这套壳，只把"重新打包"这件事自动化。

```
上游发 tag  →  build.ps1 检出该 tag  →  应用品牌覆盖  →  官方打包流程  →  安装包
```

## 前置条件（Windows x64 构建机）

| 依赖 | 版本 | 说明 |
|---|---|---|
| PowerShell | 5.1+ | Windows 自带即可，**不需要** PowerShell 7 |
| Node.js | `^22.19 \|\| >=24` | 建议 24 |
| pnpm | `11.7.0` | 必须与 harness 的 `packageManager` 一致 |
| Python | 3.x | **不能是 Microsoft Store 的跳转桩**，原生模块编译需要 |
| Visual Studio Build Tools | C++ 工作负载 | `node-pty` 等原生模块需要 |
| 磁盘 | ≥ 20 GB | Electron + 内置 Node.js + pnpm + 完整生产依赖树 |

国内网络建议先设置镜像，否则 Electron 二进制和上游 Node.js 归档会下载失败：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:npm_config_registry = 'https://registry.npmmirror.com'
```

## 一次性初始化

```powershell
git init
git remote add origin <你的仓库地址>
```

`harness/` 和 `dist/` 都已加入 `.gitignore`。`build.ps1` 会在首次运行时自动把上游克隆到 `harness/`，
不需要手工执行 `git submodule add`。

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
# 构建最新的 dsh-v* tag
./build.ps1

# 只接受稳定版 tag（跳过 -rc / -alpha）
./build.ps1 -Channel stable

# 指定上游修订
./build.ps1 -Ref dsh-v0.1.5-rc.2

# 产出未打包的应用目录，便于排查
./build.ps1 -Dir

# 重复构建同一版本
./build.ps1 -Force
```

一次完整的打包会依次执行仓库构建（`build:official`）、打包 dsh 生产闭包、准备内置 Node.js 和 pnpm、
裁剪运行时文件、校验完整性，最后交给 electron-builder。首次构建通常需要 30–60 分钟。

打包命令优先复用上游已发布的根命令：签名走 package:desktop:win:x64，未签名走
package:desktop:win:x64:unsigned。只有 -Dir 组合没有对应的上游根命令，会直接调用
@deepseek-ai/dsh-desktop 的 package 脚本。

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

`build.ps1` 已经把这个目录结构生成在 `dist/<版本>/feed/` 下，整目录同步到你的 HTTPS 主机即可。
通道文件名由版本决定：稳定版是 `latest.yml`，预发布版（如 `0.1.5-rc.2`）是 `rc.yml` —— 以实际产出的
`.yml` 文件名为准，不要写死。

> 用 `-Channel stable` 构建可以避开预发布通道，客户端只会看到稳定更新。

## 产物

```
dist/
  <上游版本>/                                安装包、.blockmap、更新元数据、build-info.json
    feed/_/harness/desktop/stable/win-x64/   仅签名构建生成
  last-build.json                            最近一次构建的摘要，CI 也读这个文件
```

`build-info.json` 记录了上游 tag、commit、打包模式、签名判定原因、appId、productName，便于追溯某个
安装包到底来自哪次上游提交。

## 覆盖层维护

`overlay/*.patch` 是**唯一**对上游源码的改动，当前只有品牌相关的两行：

| 文件 | 改动 |
|---|---|
| `apps/desktop/electron-builder.config.mjs` | `productName` 读 `DSH_DESKTOP_PRODUCT_NAME`；`win.icon` 读 `DSH_DESKTOP_ICON` |

`appId` 上游本来就走环境变量，无需补丁。

上游如果改动了被补丁覆盖的行，`git apply --3way` 会**显式报错并中止**（不会静默产出错误品牌的包）。
此时重新生成补丁：

```powershell
# 在 harness/ 中手工应用改动后
git -C harness diff -- apps/desktop/electron-builder.config.mjs > overlay/0001-branding.patch
git -C harness checkout -- .
```

补丁文件受 `.gitattributes` 的 `overlay/*.patch -text` 保护，永远不会被改成 CRLF —— 否则
`git apply` 的上下文行会匹配失败。

## 持续跟进

`.github/workflows/desktop.yml` 每天探测一次上游 `dsh-v*` tag，发现新版本就构建并发布到 GitHub
Release，已发布过的版本自动跳过。

Hosted runner 接触不到 SafeNet Token，所以 **CI 只能产出 unsigned 安装包**。需要 EV 签名的正式版本必须在
持有 Token 的 Windows 机器上运行 `build.ps1`。

需要在 CI 里固定品牌时，把 `DSH_DESKTOP_APP_ID` / `DSH_DESKTOP_PRODUCT_NAME` 配成仓库 Variables。

## 脚本编码约定

`*.ps1` 里的字符串**全部使用 ASCII**，这是刻意的：Windows PowerShell 5.1 会用系统 ANSI 代码页
（本机为 936/GBK）读取无 BOM 的文件。中文若以 UTF-8 无 BOM 保存，会被误解码成乱码，全角标点甚至可能
吞掉紧跟的 `$`，直接破坏脚本语法。中文说明放在 Markdown（`README.md`）里，PowerShell 不会去解析它。

`build.ps1` 写出的 JSON 一律为无 BOM 的 UTF-8，避免严格的 JSON 读取方解析失败。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `pnpm install` 卡在 Electron 下载 | 设 `ELECTRON_MIRROR` / `npm_config_registry` |
| 原生模块编译失败 | Python 是 Store 跳转桩，或缺少 VS C++ Build Tools |
| `overlay patch ... did not apply` | 上游改了被覆盖的行，按"覆盖层维护"重新生成补丁 |
| `desktop version ... does not match dsh version` | 上游把壳版本和 dsh 版本解绑了；说明设计变了，需要重新评估本仓库 |
| 签名构建报更新源缺失 | 设置 `DOWNLOAD_TEST_ORIGIN`，或改用 `-Dir` 做本地验证 |
| `win-x64 requires a Windows x64 build host` | 打包只能在 Windows x64 上跑 |
| PowerShell 报 `Unexpected token '}'` | 脚本被改成了含中文的无 BOM UTF-8；恢复为 ASCII 或另存为 UTF-8 with BOM |
