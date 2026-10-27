# GleamDesk 开发

使用 PowerShell。先检查现有实现，局部修改后验证相关功能。不要提交配置、凭据、数据库、日志、构建产物或真实响应。

前端：`npm.cmd ci`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。原生：`npm.cmd run tauri -- build --debug --no-bundle`。Cargo 缓存保留在开发目录 `src-tauri/target`，禁止复制进验收归档。

凭据或远程服务变更需用户明确授权。UI 和 Windows 窗口行为需实际运行核验，不能用构建成功代替。

Windows NSIS 工具解压若被沙箱拒绝，可在已有授权范围内于沙箱外执行 `npm.cmd run tauri -- bundle --bundles nsis --ci`，无需重复编译。PowerShell 构建路径映射参数数组时，每个字符串拼接表达式单独加括号。

空白配置验收先用 `SHGetKnownFolderPath` 核对测试子进程的 Roaming/Local 路径，并隔离 WebView 数据目录；这不等于干净 Windows 或独立凭据存储。原生工作台被遮挡时可能暂停刷新，先置于前台再读验收结果；自动点击的几何定位失败单独记为工具限制。

Windows Jumbo 图标可能只有大画布中的小块内容，也可能完全透明；统一裁剪透明边距并对空白结果回退，旧系统图标按版本刷新，不能按应用名称写死或覆盖手动图标。Windows PowerShell 5.1 的中文临时脚本使用带 BOM 的 UTF-8。

Dock 普通应用、快捷方式和网址使用 Windows 原生 Shell 启动；不要恢复编码 PowerShell 启动链。只有明确配置的 command 入口会调用终端。原生验收使用 `src-tauri/tests/fixtures/launcher-gui.cs` 编译的一次性 GUI，在含空格/中文的临时目录命名为 `launch fixture.exe`，设置 `GLEAMDESK_LAUNCH_FIXTURE` 后显式运行忽略测试 `launcher::tests::native_launch_acceptance`；不启动用户工作应用。

Tauri 打包结束时可能重写主 EXE，使其修改时间晚于刚生成的 NSIS 安装包；不能用文件时间先后判断二者是否配套。发布包应在同一干净构建任务中生成，并记录版本、源码提交和校验值。

参与证据批次摘要的排序必须固定为 UTF-16 序号顺序，不能使用默认 localeCompare；原生端使用 encode_utf16 比较，以免中文/英文 Windows 的批次校验值不同。
