# DSH Desktop Builder

从 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的固定提交构建 Windows x64 桌面安装包。构建器维护品牌覆盖、发布配置和产物归档，运行时及安装程序继续使用上游 `apps/desktop` 打包流程。

## 前置条件

| 依赖 | 要求 |
|---|---|
| 系统 | Windows x64，PowerShell 5.1+ |
| Node.js | `^22.19.0` 或 `>=24.0.0`，建议使用 Node 24 |
| pnpm | 与上游 `packageManager` 一致，目前为 `11.7.0` |
| 原生构建工具 | Visual Studio C++ Build Tools、可运行的 Python 3、tar |
| 磁盘和网络 | 留出至少 20 GB 空间；构建需要下载依赖、Electron 和工作区运行时 |

`harness/` 是可刷新的构建副本，功能开发应放在独立的 DSH 源码仓库。构建会备份并恢复已知覆盖文件；存在其他受 Git 管理的改动时会停止。切换上游提交或发现已删除包的残留目录时，构建器调用上游 `clean` 清理生成文件，并先将已有打包记录保存到 `dist/build-evidence/`。其他未跟踪文件不会被清理。

## 本地构建

```powershell
# 固定上游版本，生成手动分发的未签名安装包，明确关闭强制更新服务。
./build.ps1 -Ref dsh-v0.2.1-alpha.1 -Mode unsigned -DisableMandatoryUpdate

# 跟随最新 master；其他构建设置同上。
./build.ps1 -Mode unsigned -DisableMandatoryUpdate

# 只准备依赖并检查配置、工具链。
./build.ps1 -Mode unsigned -DisableMandatoryUpdate -CheckOnly

# 生成可直接运行的应用目录。
./build.ps1 -Mode unsigned -DisableMandatoryUpdate -Dir
```

`-Channel stable` 选择最新正式版标签，`-Channel prerelease` 也包含预发布标签；默认跟踪 `origin/master`。每次构建先将引用解析为完整提交，再检出该提交。覆盖层针对当前 `0.2.1-alpha.1` 的配置组织；更早版本不保证兼容，锚点变化会明确失败。

`-DisableMandatoryUpdate` 是本地未签名发行选项：安装包不嵌入强制更新策略，也没有自动更新源，需要手动安装后续版本。它不会关闭代码签名验证或 Windows 的系统安全策略。签名构建拒绝该选项。不使用该选项时，未签名构建也必须提供上游要求的策略服务配置。

默认名称为 `DSH Desktop`，应用 ID 为 `com.example.dsh-desktop`。升级已有安装时应保持应用 ID 一致。通过以下环境变量设置品牌：

```powershell
$env:DSH_DESKTOP_APP_ID = 'com.yourorg.dsh'
$env:DSH_DESKTOP_PRODUCT_NAME = 'DSH Desktop'
```

将 Windows 图标放在 `branding/icon.ico`，要求包含 256×256 图像。缺少该文件时保留上游图标。应用内部界面、托盘和协议名称不属于此安装包品牌覆盖的范围。内部程序文件保留 `DeepSeek Harness.exe`，供上游 CLI 启动器和运行时检查使用；安装界面名称仍为配置的产品名。

## 发布配置和签名

上游打包入口只从 `harness/apps/desktop/.env.windows` 读取发布配置。构建器将允许的发布环境变量及可选输入文件转换为该文件，文件中的值优先于环境变量。默认输入是构建器根目录的 `.env.windows`，也可以传 `-ReleaseConfig <文件>`；凭据文件路径相对于该输入文件解析。

生成文件带有构建器标记。已有上游 `.env.windows` 若不是构建器生成且内容不同，构建器会拒绝覆盖；将自定义设置移到输入文件后再重试。凭据不会出现在构建摘要中，不要提交或分享本地 dotenv 文件。

`-Mode auto` 在四个签名输入都存在且证书、工具路径有效时选择签名，否则在全部缺省时选择未签名。仅配置一部分签名输入会失败。`-Mode signed` 强制要求签名；`-Mode unsigned` 明确选择未签名。

签名构建使用以下输入：

```dotenv
DSH_DESKTOP_APP_ID=com.yourorg.dsh
DSH_DESKTOP_AUTO_UPDATE_ENV=test
DOWNLOAD_TEST_ORIGIN=https://downloads.example.com
DOWNLOAD_TEST_RELEASE_ID=<32位小写十六进制发布批次ID>
DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN=https://policy.example.com
DSH_DESKTOP_MANDATORY_UPDATE_CONFIG='{"allowedAuthOrigins":["https://login.example.com"]}'
DSH_DESKTOP_WINDOWS_CER_FILE=C:\signing\publisher.cer
DSH_DESKTOP_WINDOWS_SIGNTOOL=C:\signing\signtool.exe
DSH_DESKTOP_WINDOWS_KEY_CONTAINER=<私钥容器名>
DSH_DESKTOP_WINDOWS_TOKEN_PIN=<本地Token密码>
```

示例域名需要替换为已部署的服务。test 模式必须提供策略服务及登录域名；production 模式改用 `DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN`，且不允许 `allowedAuthOrigins`。上游 production 自动更新地址固定为官方域名，自有签名发行应采用配置了自有地址的 test 部署。

```powershell
./build.ps1 -Mode signed -ReleaseConfig .env.windows
```

打包使用 `node --import tsx/esm apps/desktop/scripts/package-target.ts`，并显式传递工作区内的 pnpm JavaScript 入口。官方流程会构建源码、准备生产依赖和独立工作区运行时、执行运行时检查，再生成安装包；此过程耗时取决于缓存与网络。

## 版本和产物

默认安装版本取自上游。需要为同一上游版本发行多个构建时，使用上游支持的扩展版本：

```powershell
./build.ps1 -Mode unsigned -DisableMandatoryUpdate -BuildVersion 0.2.1-alpha.1.20261004.1
```

产物保存在 `dist/<构建版本>-<提交前10位>-<signed或unsigned>/`，目录模式额外带 `-dir`，可执行程序位于其 `win-unpacked/`。构建成功后写入 `build-info.json` 和 `dist/last-build.json`，记录完整上游提交、实际版本、品牌、签名模式、强制更新选项及产物摘要。失败不会更新最后成功构建记录。

完成记录已存在时默认跳过；`-Force` 重新构建，并在成功打包后将旧输出移到带时间戳的备份目录。`-NoInstall` 跳过依赖安装，`-NoFetch` 使用已有 Git 引用；仅在对应依赖和固定提交已准备好时使用。

签名安装包额外生成 `feed/`，按当前上游 `dsh-desk/<test发布批次ID>/feeds/win-x64/` 和 `bin/win-x64/` 布局组织文件，`nightly.yml` 中的下载地址指向对应二进制。production 路径不包含发布批次 ID。构建器只生成这些文件，不会自动上传。

## 自动构建

`.github/workflows/desktop.yml` 按计划或手动检查上游，按版本和提交识别已发布的构建。Hosted runner 运行未签名模式；工作流中的强制更新选项决定它是否依赖策略服务。自动发布只在该工作流实际执行时发生，本地 `build.ps1` 不创建 GitHub Release。

仓库 Variables 可设置 `DSH_DESKTOP_APP_ID` 和 `DSH_DESKTOP_PRODUCT_NAME`。保留 Release 标签格式 `dsh-desktop-<上游版本>-<提交前10位>`，工作流将完整检测提交传给构建命令，防止检测和构建之间 master 移动。

## 覆盖与验证

`overlay/apply-overlay.mjs` 修改当前上游的 `scripts/electron-builder-config.mjs` 和 `scripts/desktop-package-environment.mjs`：品牌名称、Windows 图标、明确选择的本地未签名策略选项。它先验证所有锚点，再写文件，保留行尾风格并支持重复运行。运行时检查保持上游原样，旧 `fs-ext` 修补已移除。

```powershell
node --test tests/*.test.mjs
```

这些测试覆盖锚点失效、配置来源、未签名选项限制、产物收集和更新目录。实际安装包仍须通过官方打包检查，并单独验收桌面启动和安装升级。`build.ps1` 使用 ASCII 字符串，生成 JSON 和 dotenv 使用 UTF-8；请保持 PowerShell 5.1 的兼容性。
