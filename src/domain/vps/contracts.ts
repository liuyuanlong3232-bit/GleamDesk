export type VpsState = "online" | "offline" | "warning" | "unknown";
export type VpsAvailability = "ready" | "unconfigured" | "platform-unsupported" | "credentials-missing" | "failed";

// Only locally defined messages are safe to persist. Never echo an unexpected
// transport error, which could contain an endpoint, response body or credential.
export function safeBeszelError(value: unknown): string {
  const message = typeof value === "string" ? value.trim() : value instanceof Error ? value.message.trim() : "";
  const known = [
    "尚未配置服务凭据", "Windows 凭据格式无效", "凭据为空、过长或包含控制字符",
    "服务凭据已更新，请重新读取", "Beszel API 令牌无效或无权读取该系统",
    "找不到 Beszel 系统，请检查 System ID 和访问权限", "Beszel 返回了无法识别的数据",
    "服务 网络连接失败或请求超时", "无法初始化 Windows HTTP 客户端", "无法设置网络超时",
    "无法连接到 服务", "无法创建服务 API 请求", "无法设置 HTTP 重定向策略",
    "无法读取 服务 API 响应状态", "读取 服务 API 响应失败", "服务 API 响应超过 2 MB 限制",
    "Beszel 读取任务无法完成", "Beszel VPS 状态 超过采样时限", "Beszel VPS 状态 返回了无效数据",
    "Beszel 地址必须以 http:// 或 https:// 开头", "Beszel 地址只支持 HTTP 或 HTTPS",
    "Beszel 地址主机名无效", "Beszel 地址不能包含查询参数或片段", "Beszel IPv6 地址格式无效",
    "Beszel 端口无效", "Beszel 主机名或端口格式无效；IPv6 地址请使用方括号", "Beszel 地址主机名或端口无效",
    "Beszel System ID 只能包含字母、数字、连字符或下划线",
    "Beszel 读取需要 PocketBase 用户认证 JWT；请填写登录用户获得的令牌，不带 Bearer 前缀。Agent 注册 Token 不适用于此读取。",
    "Beszel API 连接目前仅支持 Windows 桌面版本",
    "Beszel 读取失败，详细原因未识别", "上次失败原因未保留，等待自然重试",
  ];
  if (known.includes(message) || /^Beszel API 请求失败（HTTP [1-5]\d{2}）$/.test(message)) return message;
  return "Beszel 读取失败，详细原因未识别";
}

export interface VpsObservation {
  name: string;
  host?: string | null;
  serverId: string;
  state: VpsState;
  availability: VpsAvailability;
  uptimeSeconds: number | null;
  latencyMs: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  network: { uploadBytes?: number; downloadBytes?: number; totalBytes?: number };
  services: Array<{ name: string; state: "online" | "offline" | "unknown" }>;
  observedAt: string | null;
  lastSuccessAt: string | null;
  fetchedAt?: string | null;
  sourceTimeVerified?: boolean;
  error?: string;
}

export interface NativeBeszelObservation {
  sampledAtUnixMs: number | null;
  fetchedAtUnixMs?: number;
  name: string;
  host?: string | null;
  serverId: string;
  state: VpsState;
  uptimeSeconds: number | null;
  latencyMs: number | null;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskPercent: number | null;
  network: VpsObservation["network"];
  services: VpsObservation["services"];
}

export interface VpsLocation {
  ip:string;
  countryZh:string|null;countryEn:string|null;
  cityZh:string|null;cityEn:string|null;
  lookedUpAtUnixMs:number;
  source:"ipwho.is";
}
