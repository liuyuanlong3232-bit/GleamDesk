export const settingsModules = [
  { id: "appearance", label: "外观", icon: "◐", group: "界面", description: "主题颜色、透明度、动画与壁纸适配" },
  { id: "layout", label: "显示器布局", icon: "▣", group: "界面", description: "保存、导入和切换当前显示器的布局" },
  { id: "widgets", label: "组件", icon: "▦", group: "界面", description: "选择显示的组件并调整顺序" },
  { id: "applications", label: "应用管理", icon: "⊞", group: "界面", description: "管理 Dock 应用、启动目标与图标" },
  { id: "webapps", label: "网站与工具", icon: "◉", group: "界面", description: "管理工作区网站、Web工具、分类与显示顺序" },
  { id: "desktop", label: "桌面与启动", icon: "⌂", group: "系统", description: "桌面模式、鼠标穿透与启动窗口" },
  { id: "agents", label: "AI 客户端状态", icon: "◈", group: "数据连接", description: "订阅额度、运行状态与本地模型" },
  { id: "api", label: "API 余额与费用", icon: "↔", group: "数据连接", description: "查看连接状态，按需配置账户余额与费用读取" },
  { id: "mail", label: "邮箱账户", icon: "✉", group: "数据连接", description: "连接邮箱、检查授权状态并管理邮件读取" },
  { id: "beszel", label: "VPS 连接", icon: "▤", group: "数据连接", description: "连接现有 Beszel Hub，查看服务器状态" },
  { id: "data", label: "数据来源", icon: "↥", group: "数据连接", description: "按需配置可选数据来源" },
  { id: "analysis", label: "AI 历史分析", icon: "✳", group: "数据连接", description: "选择推理服务并管理独立凭据" },
  { id: "simulation", label: "开发模拟", icon: "◇", group: "高级", description: "选择界面演示场景与模拟数据" },
  { id: "diagnostics", label: "系统诊断", icon: "◎", group: "高级", description: "查看版本、数据源状态与历史记录" },
] as const;

export type SettingsModuleId = typeof settingsModules[number]["id"];
