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

提交作者使用当前提交者自己的 GitHub 账号及对应 noreply 邮箱；不要用共享的 contributors@users.noreply.github.com 冒充脱敏身份，它可能关联到其他账号。保持其他贡献者各自署名，不为修正显示而改写已发布历史。

隔离 AppData 或 WebView 不会隔离 Windows 凭据管理器。GleamDesk 仅使用 GleamDesk.* 凭据；CodexDesktop.* 只允许在用户确认的旧版导入中读取，首次使用验收也要核对这一层。正常升级保留应用标识和数据目录。

PowerShell 核对 package-lock.json 的根包版本时，使用 ConvertFrom-Json -AsHashtable；packages 的根包键为空字符串，普通对象解析会失败。

Tauri 更新包使用 signer sign --app-version 绑定版本，客户端 requireSignedVersion=true；只有公钥进入源码，私钥不进入包、日志或 artifacts。原生升级验收必须单独使用测试安装，不能对日常使用实例执行更新。
Tauri 增量缓存若提示硬链接失败会回退复制，构建仍可能通过但 target 占用增大；复用固定开发 target，不把缓存复制到 artifacts。
沙箱内 Get-Process 可能漏掉正常用户环境启动的预览；EXE 替换被拒绝时，应在正常用户环境按完整路径核对占用，不能以沙箱未枚举判定已退出。
工作台使用 Windows 原生标题栏和任务栏；重新打开先取消最小化，同屏保留大小位置，不得复用 HUD/Dock 的整屏复位逻辑。窗口验收须覆盖最小化后的入口恢复及普通大小与最大化之间的切换。

Windows 透明 HUD 的 Computer Use 可能同时返回 14×14 小区域与完整窗口截图；必须选完整图的 screenshotId 再点击，不能默认使用 screenshot-0。原生预览在沙箱内无窗口时，核对进程并按已获授权范围在正常用户环境启动。

登录启动不能只凭程序内写入及回读成功判为通过；需要交叉核对 Windows 启动应用清单，并单独记录真实登录验收结果。快捷方式方案仅管理当前用户启动文件夹中的 GleamDesk.lnk，升级保留、卸载按目标路径清理，不创建终端启动链。

登录启动独立验收先保存仅自身的原始清单和读取错误，再按当前用户、路径与参数核对；WMI 查询失败或未枚举只能记为未确认，不能等同系统不存在，格式未确认也不能放行。
本机 Win32_StartupCommand 对启动文件夹条目曾返回 Command=GleamDesk.lnk；不能强制它等于 EXE 完整路径，也不能仅凭文件名放行，应关联当前用户的已核对快捷方式。
原生快捷方式临时文件替换测试在沙箱中可能失败；先在普通用户环境复测，仅操作测试临时目录，不据此修改实际系统启动项。

复制并修改生成的 NSIS 测试脚本时保留 UTF-8 BOM；否则 NSIS 可能将中文路径按 ANSI 解码并报 LicenseData 文件不存在。隔离升级测试使用独立产品登记和一次性测试密钥，不使用正式更新密钥签署合成可执行文件。

离线英译中使用固定版本 Transformers.js 与 OPUS-MT ONNX；首次开发运行 `npm.cmd run prepare:translation` 下载并校验模型，构建只检查本机资源，不自动联网下载。`public/translation-models` 和 `public/translation-runtime` 可重新生成，不提交 Git；运行时禁止远程模型及 CDN。
主屏交互面板须放在 `.main-screen` 内并标记 `data-main-hit-region`，否则原生透明窗口裁剪会让面板在可访问树中存在却不可见、不可点击。
每日推荐的英文简介自动使用本机离线模型翻译并缓存，保留原文；不接入付费翻译 API，不恢复独立 HUD 翻译按钮或完整邮箱模块。邮箱仅提供用户确认的新邮件提醒和验证码复制。
邮箱验证码使用独立的 GleamDesk.MailOtp.* 凭据命名空间；不读取旧邮箱凭据。IMAP 只用 EXAMINE/BODY.PEEK，游标按账户和 UIDVALIDITY 隔离；邮件正文、验证码与提示历史只留内存，不能写入诊断或通知历史。真实邮箱验收需用户在设置页本人连接。
预览 EXE 被占用时，可用临时 Tauri 配置的 mainBinaryName 在固定 target 中生成独立命名候选；不另建编译目录，启动候选前仍须退出共用配置的其他实例。
HUD 邮箱面板的按钮须显式重置 appearance、背景和边框，避免 WebView 默认灰色按钮；长列表独立滚动，账户行不显示重复的邮箱类型介绍。
HUD 展开面板须同时保留 CSS 视口宽度上限和侧边可用空间限制；只依赖 resize 更新的变量，缩小窗口的首帧可能沿用旧宽度。
离线翻译资源可复用同版本开发副本的 `public/translation-models` 与 `public/translation-runtime`，仍须由 `npm run build` 重新校验；缺包先按锁文件运行 `npm ci`，不要跳过模型检查。
豆包登录读取须按 `Local State` 的 `profile.last_used` 选择当前配置档，不能写死 `Default` 或跨档回退；赠送额度与订阅窗口分开读取，仅查询官方只读额度接口。
豆包运行时可能独占 Cookies 数据库，首次退出后导入本机 DPAPI 加密缓存；DPAPI 测试需在正常 Windows 用户环境运行，沙箱失败不能判为加密实现错误。
NSIS 安装后的 EXE 与便携 EXE 可能仅有 `__TAURI_BUNDLE_TYPE_VAR_UNK` → `NSS` 三字节差异；验签原安装包，并逐字节确认只有该唯一标记变化，不能直接把两种 EXE 的哈希不同判为安装损坏。
从 Codex（MSIX）直接启动的进程可能把 AppData 写入 `Packages\OpenAI.Codex_*\LocalCache`；仅核对环境变量或 EXE 路径不足以证明使用了日用配置。启动验收须确认进程无包身份（`GetPackageFullName` 返回 15700），并核对配置文件句柄的真实路径；发现重定向时，保留两边数据后恢复到正常目录，不从代理进程直接启动日用实例。
设计类任务（图标、配色、版式、动效等）先只出稿：给出 2–3 个方向并附 16/32/48px 小尺寸预览，等用户明确选定后才修改仓库文件、替换资源并重新构建；未经确认不得提交或推送设计改动。
工作台刷新快照时，使用当前时间判断有效期；30 秒显示时钟可能落后于刚收到的快照，不能据此把新余额误判为“读取时间未确认”。
卡片实时排序时，把 Pointer Capture（指针捕获）留在稳定的父容器；捕获在卡片自身上，DOM 换位可能导致拖动中断。移动和缩放只预览，松手才保存，取消不写设置。
Hub 拖动图标时仍在原按钮捕获指针，以保留轻点行为；越过拖动阈值后只拦截本次 click，下一次按下要清除拦截。Hub 保持四边吸附与沿边偏移保存，不能因去掉手柄改成桌面任意坐标定位。
工作台和 Hub 是独立窗口；手动刷新 AI 连接成功后用 Tauri 全局事件通知额度视图，不能只 dispatch 当前窗口事件，否则设置已连接而 Hub 仍保留旧读数。事件不携带账号或额度内容，视图仍按原授权读取。
账号切换不能只靠五分钟额度刷新：先核对当前登录来源，前后端缓存按本次账号修订隔离，读取前后再次核对并丢弃旧请求。豆包目录不能证明账号归属；登录库锁定或当前会话无法确认时不使用旧登录缓存，提示退出客户端后刷新。
release 原生测试 EXE 通过 Python subprocess.run 等待并捕获真实退出码；PowerShell 直接启动 Windows 子系统测试程序可能提前返回，不能据此判断测试结束。
