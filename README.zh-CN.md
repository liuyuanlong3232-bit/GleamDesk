# 栖光桌面 · GleamDesk

**让状态常驻，让工作更轻。**

[English](README.md) · [使用指南](docs/USAGE.md) · [编译说明](docs/BUILDING.md) · [问题反馈](https://github.com/liuyuanlong3232-bit/GleamDesk/issues)

基于 Tauri、React、TypeScript 和 Rust 的 Windows 桌面工作台，将顶部 HUD、Dock、系统资源、公开数据和 Agent Room 放在一起。

![工作台界面预览](docs/images/overview.png)

> 截图来自独立的干净浏览器预览。首页金额为标明的开发模拟数据；其他页面未连接私人账户、服务器或模型。截图不是实际账户、投资收益或服务连接成功的证明。Windows 原生功能需在桌面版使用。

## 功能

| 模块 | 能做什么 |
| --- | --- |
| HUD 与 Dock | 常驻状态、应用入口、按需展开工作台、HUD 退出整个程序 |
| 系统资源 | Windows 本机 CPU、内存、磁盘、网络与事件状态 |
| 新闻、市场与农业 | 电脑直连公开来源；保留来源、日期、单位与缺失状态 |
| 自选 | 添加 A股、美股、港股及受支持的期货代码 |
| Agent Room | 模型成员与房间界面，按需配置自己的模型连接 |
| 个性化 | 主题、布局、显示名字与本机头像 |
| 可选服务 | Beszel、3x-ui、sing-box、Tailscale；用户自行配置 |

**不依赖作者 VPS。** 新安装没有作者账户、服务器配置、个人自选和凭据。免费数据来源默认启用；SSH、可选服务和自动付费生成默认关闭。

## 开始使用

当前为早期源码发布，应用版本 `0.1.0`，尚未发布签名安装包或预编译下载。使用源码构建需 Windows、Node.js 22、Rust stable、Visual Studio C++ 构建工具和 WebView2 Runtime。

```powershell
git clone https://github.com/liuyuanlong3232-bit/GleamDesk.git
cd GleamDesk
npm.cmd ci
npm.cmd run tauri -- dev
```

详细命令与构建输出见 [编译说明](docs/BUILDING.md)。本项目以 Windows 为目标；未提供或验证 macOS/Linux 发行版本。

## 更多截图

### Agent Room

![未连接模型的 Agent Room](docs/images/agent-room.png)

### 外观设置

![主题与外观设置](docs/images/settings.png)

## 数据与隐私

- 公共来源可能延迟、限流、改变接口或在部分网络无法访问。免费不等于全部地区无需代理。
- 保留实际来源日期、币种和单位；不把读取时间当成行情时间，不推测缺失价格或主力关系。
- 用户配置、头像和历史保存在本机；支持的凭据通过 Windows 凭据管理器保存。模型、邮箱和服务连接使用用户自己的账户。
- 本项目不提供投资建议。第三方数据、商标和服务权利不由项目许可证授予。

详见 [数据来源](docs/open-source-data-connections.md)与[隐私说明](docs/PRIVACY.md)。

## 文档与参与

[使用指南](docs/USAGE.md) · [架构](docs/ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md) · [行为准则](CODE_OF_CONDUCT.md) · [安全反馈](SECURITY.md) · [变更记录](CHANGELOG.md) · [致谢](ACKNOWLEDGMENTS.md)

原创代码采用 [MIT](LICENSE)。第三方代码与素材保留各自许可证。使用 OpenAI Codex 辅助开发，不代表 OpenAI 官方项目或背书。
