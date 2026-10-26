# AgentRoom

Windows 桌面工作台：顶部 HUD、Dock、系统资源、新闻、市场行情、农业数据和 Agent Room。使用 Tauri 2、React、TypeScript 与 Rust。

## 使用

- 启动后显示 Dock 和顶部 HUD；从 HUD 打开工作台或退出程序。
- 点击工作台头像修改图片与显示名字。市场中心 → 管理自选可添加 A股、美股、港股及支持的期货代码。
- 免费数据由电脑直接请求公开来源，不依赖作者服务器。网络或来源不可用时显示失败或旧数据日期，不填模拟数值。公开行情可能延迟；来源、单位与时间以卡片说明为准。
- Beszel、3x-ui、sing-box、Tailscale、SSH、邮箱与付费 AI 均为可选连接，需要用户自行配置。项目不会提供作者账户、服务器、密钥或第三方软件安装。
- 已安装本机 Beszel Hub 的用户，可在设置 → VPS 连接中选择随软件启动，填写程序和原数据目录。仅监听本机地址；不创建空数据库，不修改 Windows 开机启动。退出 AgentRoom 后 Hub 保持运行。

## 开发

Windows 10/11，需安装 Node.js 22、Rust stable、Visual Studio C++ 构建工具及 WebView2 Runtime。

```powershell
npm.cmd ci
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run tauri -- dev
```

生成 Windows 便携程序：

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
npm.cmd run tauri -- build --debug --no-bundle
```

首次构建需要联网下载依赖。浏览器预览可检查页面样式，Windows 资源、凭据和服务连接需在桌面版运行。当前构建未进行代码签名。

## 配置与数据

新安装不含姓名、个人自选或服务凭据，SSH、可选服务和自动付费生成默认关闭。免费数据来源可在设置中开关。用户配置、头像、历史和凭据只保存在运行电脑上；凭据使用 Windows 凭据管理器，不存入源码。

源码发布不包含本机配置、数据库、调试日志、旧开发历史或原始行情响应。升级前请自行备份自己的本机数据。

## 许可证

本项目新增原创代码采用 [MIT](LICENSE)。第三方代码与素材保留各自声明，见 [许可证目录](licenses/vps-services/README.md)、[HUD 来源说明](docs/licenses/agent-hud-THIRD-PARTY-NOTICES.txt)及 `vendor/wry`。数据服务、商标和品牌图标不由本项目授予使用权；本项目与相关品牌无隶属关系。数据来源说明见 [免费数据连接](docs/open-source-data-connections.md)。
