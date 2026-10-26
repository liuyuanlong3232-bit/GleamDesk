# GleamDesk 开发

使用 PowerShell。先检查现有实现，局部修改后验证相关功能。不要提交配置、凭据、数据库、日志、构建产物或真实响应。

前端：`npm.cmd ci`、`npm.cmd run typecheck`、`npm.cmd test`、`npm.cmd run build`。原生：`npm.cmd run tauri -- build --debug --no-bundle`。Cargo 缓存保留在开发目录 `src-tauri/target`，禁止复制进验收归档。

凭据或远程服务变更需用户明确授权。UI 和 Windows 窗口行为需实际运行核验，不能用构建成功代替。

Windows NSIS 工具解压若被沙箱拒绝，可在已有授权范围内于沙箱外执行 `npm.cmd run tauri -- bundle --bundles nsis --ci`，无需重复编译。PowerShell 构建路径映射参数数组时，每个字符串拼接表达式单独加括号。
