export type ProviderKind = "agent" | "api" | "server" | "system" | "notice" | "resource" | "dock" | "demo";
export type ProviderState = "online" | "warning" | "offline" | "normal" | "unknown";
export type ProviderResultStatus = "normal" | "degraded" | "stale" | "unavailable" | "error";

export interface ProviderDiagnostic {
  providerId: string;
  name: string;
  status: ProviderResultStatus;
  lastUpdated: string | null;
  lastSuccessAt: string | null;
  error?: string;
}

// Presentation only: freshness never proves that upstream data is correct.
export type DataState = "Live" | "Cached" | "Stale" | "Unknown";
export function dataStateLabel(state:DataState):string {
  return {Live:"实时 · Live",Cached:"缓存 · Cached",Stale:"数据过期 · Stale",Unknown:"未知 · Unknown"}[state];
}
export function observedDataState(value:string|number|null|undefined,maximumAgeMs:number,now=Date.now(),cached=true):DataState {
  const at=typeof value==="number"?value:typeof value==="string"?Date.parse(value):NaN;
  if(!Number.isFinite(at)||at<=0||at>now)return "Unknown";
  return now-at>maximumAgeMs?"Stale":cached?"Cached":"Live";
}
export function formatDataUpdatedAt(value:string|number|null|undefined):string {
  if(typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value)))return "来源日期 "+value;
  const at=typeof value==="number"?value:typeof value==="string"?Date.parse(value):NaN;
  if(!Number.isFinite(at)||at<=0)return "更新时间未知";
  if(typeof value==="string"&&!/(Z|[+-]\d{2}:?\d{2})$/i.test(value))return "来源时间 "+value+"（时区未确认）";
  return "更新 "+new Intl.DateTimeFormat("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"}).format(at);
}
