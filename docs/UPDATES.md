# 版本与更新

## 使用方式

- 设置中心 → **版本与更新**，可以手动检查、打开发布页，或关闭“启动后检查更新”。
- 启动检查默认开启，在 HUD 挂载约 5 秒后读取一次 GitHub 正式发布信息；不会自动下载或安装。发现新版后 HUD 显示“新版”入口。
- 手动检查会重新请求；普通检查在同一进程内复用一小时缓存，短暂失败合并 15 秒。没有持续轮询或失败自动重试。
- 网络失败显示具体失败信息，不当作“已经是最新版”。启动检查失败不打断桌面使用；手动检查入口始终保留。
- 安装版检测到完整签名附件时，选择“下载并更新”，保存输入、勾选确认，再点击“确认退出并更新”。下载与校验通过后安装器关闭当前进程，保留配置和历史，完成后重新启动。
- 便携版和开发版只提供发布页入口，不把免安装版本悄悄转换为安装版。便携版需先退出，再手动替换解压后的程序文件；应用数据仍在原来的本机配置目录。

**已发布的旧版不能凭空获得更新模块。** 用户必须先手动安装一次包含此功能的新版本，之后才有启动检查与应用内安装能力。本地源码完成或 CI 成功并不等于已经更新 GitHub Release。

## 为什么旧安装器要求先卸载

NSIS 的默认维护页面对旧版本显示“推荐先卸载当前版本后再进行安装”，同时有“请勿卸载”选项。这是安装器内部升级流程，不是要求手动删除应用文件夹或 AppData。手动升级前请从顶部 HUD 完全退出程序；关闭工作台只是隐藏窗口。**不要选择删除应用数据。**

应用内升级使用 Tauri 官方 updater 的 NSIS `/UPDATE` 流程，不再让用户先手动卸载。应用标识、安装范围和凭据名称保持不变。安装失败或中途断电后的具体恢复行为仍受 Windows 安装器影响，不能承诺整个安装过程具有事务回滚能力。

## 来源与校验

检查固定访问 `https://api.github.com/repos/liuyuanlong3232-bit/GleamDesk/releases/latest`，不使用 GitHub 登录令牌，不携带用户账号、配置或历史，也不通过维护者 VPS。GitHub 会收到通常的 IP 和请求信息。无法访问 GitHub 的网络仍可在能够访问发布页的环境手动下载；软件不会替用户调整代理。

客户端只考虑正式版，使用语义版本比较；不提供降级安装。GitHub 上的版本、仓库、附件名称和初始附件 URL 必须与目标版本一致。安装前从该版本自己的 `latest.json` 读取更新信息，而不是再次跟随可能已变化的 latest 版本。

安装包需要独立的更新签名，并绑定签署时的版本号。固定公钥随程序分发；校验失败不执行安装器。下载通过 HTTPS，用户不能通过前端参数指定任意安装 URL。远程网页没有本机更新命令权限。

更新签名与 Windows Authenticode 发行者证书不同：前者用于已安装客户端验证后续更新，后者影响 Windows 发布者显示与信任。生成更新密钥不代表已经获得 Microsoft 或 SignPath 的信任，也不能保证消除 SmartScreen 提示。

## 维护者发布步骤

1. 保留并安全备份更新私钥，公钥位于 `src-tauri/updater-public-key.txt`，同时写入 `tauri.conf.json` 的 updater 配置。首次公开发行后不要随意更换公钥；丢失旧私钥通常需要用户重新手动安装以建立新信任。
2. 维护者单独授权后，在 GitHub 仓库 Secrets 中配置 `TAURI_SIGNING_PRIVATE_KEY`；如使用密码保护，另配 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。**本轮没有执行这个远程配置操作。** 不把密钥或密码放进源码、日志、安装包或验收资料。
3. Windows workflow 在没有密钥时仍生成原有未签名下载包；有密钥时，打包后仅签名步骤获得密钥环境变量，并调用 `scripts/sign-updates.ps1`。
4. 本机签名可在当前 PowerShell 会话设置 `TAURI_SIGNING_PRIVATE_KEY_PATH`，再调用该脚本的 `-OutputDirectory`。脚本先核对已有包的版本与校验值，再调用 `tauri signer sign --app-version`，生成 NSIS `.sig` 和 `latest.json`。签名动作不会运行测试包或安装器。
5. 在同一个 `v版本号` 的 GitHub Release 中上传对应的安装包、便携包、`.sig`、`latest.json`、`SHA256SUMS.txt` 和 `BUILD-METADATA.json`。上传前完成真实升级验收，不能用签名测试代替安装验收。Workflow 本身不发布 Release。

没有 `.sig` 或 `latest.json` 的旧 Release 仍可手动下载；客户端不因此跳过校验。当前 `requireSignedVersion=true`、`allowDowngrades=false`，不要关闭这些条件来迁就错误或缺失的签名。

## 安装器隔离验收

开发者在已生成本版 NSIS 安装器后，可复用其模板建立独立的 `GleamDesk Upgrade Acceptance` 测试产品。它有独立的安装登记、目录和应用标识；载荷仅是无联网、无凭据功能的合成窗口，不调用真实应用初始化。一次性测试密钥与正式更新信任分开。

```powershell
# CARGO_TARGET_DIR 指向开发构建目录；不指向 artifacts。
./scripts/test-windows-upgrade.ps1 -Stage Prepare
./scripts/test-windows-upgrade.ps1 -Stage InstallOld
# 仅显式启动忽略测试；Windows SDK 成功派发后会退出该测试进程。
$env:GLEAMDESK_UPGRADE_ACCEPTANCE = Join-Path (Get-Location) 'node_modules/.cache/upgrade-acceptance'
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline --locked app_updates::tests::installer_acceptance::isolated_nsis_upgrade_through_sdk -- --ignored --exact
./scripts/test-windows-upgrade.ps1 -Stage Verify
# 测试窗口自动关闭后，仅卸载独立测试产品，保留合成文件和证据。
./scripts/test-windows-upgrade.ps1 -Stage Cleanup
```

完整测试名为 `app_updates::tests::installer_acceptance::isolated_nsis_upgrade_through_sdk`，请勿省略其命名空间配合 `--exact`。准备脚本遇到已有测试安装或数据会停止；不覆盖陌生文件，也不删除个人数据。

2026-10-27 的开发机验收通过了实际 SDK 验签、内容篡改和版本替换拒绝、独立 NSIS 0.1.2 → 0.1.3 覆盖安装、重启测试窗口及五份合成文件逐字节保留。未访问 Windows 凭据管理器。**这只是安装器链路验收，不代表真实应用在干净 Windows、全新 WebView2、断电或完整凭据迁移场景均已通过。**

参考：[Tauri updater](https://v2.tauri.app/plugin/updater/)。
