import type { AgentQuotaAccount } from "../domain/agent/contracts";
import type { ApiUsageAccount, ApiUnavailableReason,ApiAmountScope } from "../domain/api/contracts";
import type { ProviderResultStatus, ProviderState } from "../domain/providers/contracts";
import type { ProviderStatus } from "../types";
import {observedDataState} from "../domain/providers/contracts";
import {formatMoney} from "../services/formatMoney";

/** HUD uses the tightest reliable quota window; other views keep their own semantics. */
export function hudQuotaUsed(provider?: ProviderStatus): number | undefined {
  if (!provider || provider.kind !== "agent" || provider.state === "unknown" || provider.state === "offline"
    || !provider.confidence || provider.confidence === "unknown" || provider.error) return undefined;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
  if (provider.usageWindows !== undefined) {
    const used = provider.usageWindows.map(window => window.usedPercent).filter(valid);
    return used.length ? Math.max(...used) : undefined;
  }
  return valid(provider.percentage) ? 100 - provider.percentage : undefined;
}

function presentedState(state: ProviderState, status: ProviderResultStatus): ProviderState {
  if (status === "unavailable") return "unknown";
  if (status === "error") return "offline";
  if (status === "stale" || status === "degraded") return state === "unknown" ? "unknown" : "warning";
  return state;
}

function remaining(account: AgentQuotaAccount): string | undefined {
  if (account.availabilityReason === "no-source") return "尚无可靠额度数据源";
  if (Number.isFinite(account.remainingSeconds) && account.remainingSeconds! >= 0) {
    const minutes = Math.floor(account.remainingSeconds! / 60);
    return `剩余 ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  if (!Number.isFinite(account.remainingPercent) || account.remainingPercent! < 0 || account.remainingPercent! > 100) return undefined;
  const prefix = { daily: "今日剩余", weekly: "本周剩余", "fast-requests": "快速请求剩余", cycle: "本周期剩余" };
  return `${account.quotaPeriod ? prefix[account.quotaPeriod] : "剩余"} ${account.remainingPercent}%`;
}

function reset(account: AgentQuotaAccount): string | undefined {
  if (account.resetAt && Number.isFinite(Date.parse(account.resetAt))) return new Date(account.resetAt).toLocaleString("zh-CN");
  if (account.resetPolicy === "daily") return "每日重置";
  if (account.resetPolicy === "subscription") return "按套餐重置";
  if (account.resetPolicy === "weekly") {
    const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return Number.isInteger(account.resetWeekday) && account.resetWeekday! >= 0 && account.resetWeekday! <= 6
      ? `${days[account.resetWeekday!]}重置` : "每周重置";
  }
  return undefined;
}

export function presentAgentQuotas(accounts: AgentQuotaAccount[], status: ProviderResultStatus, error?: string, mode?: "live" | "demo"): ProviderStatus[] {
  const unreliable = status === "stale" || status === "error" || status === "unavailable";
  return accounts.map(account => ({
    id: account.id, name: account.name, kind: "agent", state: presentedState(account.state, status),
    dataState: mode === "demo" ? "Unknown" : status === "stale" ? "Stale" : status === "error" || status === "unavailable" ? "Unknown" : observedDataState(account.observedAt,300_000,Date.now(),false),
    percentage: unreliable ? undefined : account.remainingPercent,
    remaining: unreliable ? status === "stale" ? "额度已过期，等待重新读取" : "额度未知" : remaining(account), resetTime: unreliable ? undefined : reset(account),
    lastUpdated: account.observedAt,
    installed: account.installed, running: unreliable ? undefined : account.running, loginStatus: unreliable ? "unknown" : account.loginStatus,
    plan: account.plan, membership: unreliable?undefined:account.membership, usageType: account.usageType, source: account.source,
    confidence: mode === "demo" ? "estimated" : unreliable ? "unknown" : account.confidence ?? "unknown",
    usageWindows: unreliable ? undefined : account.usageWindows ?? (mode === "demo" && account.remainingPercent !== undefined ? [{ id: "primary", usedPercent: 100-account.remainingPercent }] : undefined),
    ordinaryUsageAllowed: account.ordinaryUsageAllowed,
    cliDetected:account.cliDetected,configurationDetected:account.configurationDetected,cacheDetected:account.cacheDetected,
    detail: status === "stale" ? `数据已过期 · ${error || "读取失败"}`
      : error || (mode === "demo" ? "开发模拟数据" : agentReason(account)),
  }));
}

function agentReason(account: AgentQuotaAccount): string | undefined {
  const reasons = {
    "no-source": "没有可靠额度来源；客户端检测不代表登录或额度", "not-logged-in": "本地 CLI 未登录，额度未知",
    "unsupported-account": "当前 CLI 账户类型不提供 ChatGPT 订阅额度", "quota-unavailable": "CLI 未返回可核实的额度窗口",
    "no-quota-source": "CLI 登录状态可读取，尚未取得订阅额度；可以在 AI 连接中检查登录",
    "read-failed": "CLI 状态读取失败，未保留为真实额度", "unsupported-runtime": "浏览器预览不能读取本地 CLI 或客户端状态",
  };
  return account.availabilityReason ? reasons[account.availabilityReason] : account.ordinaryUsageAllowed === false ? "服务端当前不允许普通用量，百分比不表示已恢复权限" : "本地 Codex CLI 官方额度接口";
}

const reasons: Record<ApiUnavailableReason, string> = {
  "not-enabled": "尚未启用；请在设置中配置凭据", "unsupported-runtime": "真实费用读取需要 Windows 桌面应用",
  unconfigured: "尚未配置或无法读取服务凭据", "no-source": "尚未接入可靠费用数据源",
  deferred: "按当前选择暂缓接入", "read-failed": "费用读取失败",
  "mimo-console-balance": "MiMo 官方控制台账户余额；账户费用未接入。",
  "balance-read-failed": "MiMo 余额读取失败或登录过期，请在设置中重新连接账户。",
  "balance-unavailable": "尚未连接 MiMo 官方账户余额。",
  "local-recommendation-estimate":"仅本机每日推荐调用的估算，不含 Room、其他程序或设备；不是官方账单。",
};
function apiDescription(account: ApiUsageAccount, mode?: "live" | "demo"): string | undefined {
  if (account.availabilityReason) return reasons[account.availabilityReason];
  if (mode === "demo") return "开发模拟数据";
  if (account.sourceUrl === "https://api.deepseek.com/user/balance") return "官方账户余额；此接口未提供今日或本月费用";
  if (account.sourceUrl === "https://api.openai.com/v1/organization/costs") return "OpenAI 组织费用报告 · UTC · 账户余额未知；账单可能延迟";
  if (account.sourceUrl === "https://api.anthropic.com/v1/organizations/cost_report") return "组织费用报告 · UTC 日/月 · 数据可能延迟，报告不含 Priority Tier 费用；余额未知";
  return undefined;
}

export function presentApiUsage(accounts: ApiUsageAccount[], status: ProviderResultStatus, error?: string, mode?: "live" | "demo"): ProviderStatus[] {
  return accounts.map(account => {
    const description = apiDescription(account, mode);
    return {
      id: account.id, name: account.name, kind: "api", state: presentedState(account.state, status),
      dataState: mode === "demo" ? "Unknown" : status === "stale" ? "Stale" : status === "error" || status === "unavailable" ? "Unknown" : observedDataState(account.observedAt,300_000,Date.now(),false),
      balance: Number.isFinite(account.balance) ? account.balance : undefined, todayCost: Number.isFinite(account.todayCost) ? account.todayCost : undefined, monthlyCost: Number.isFinite(account.monthCost) ? account.monthCost : undefined, currency: account.currency,
      apiAmountScope:apiAmountScope(account,mode),apiReadStatus:status,apiAvailabilityReason:account.availabilityReason,
      apiPeriodTimeZone:account.periodTimeZone??(account.sourceUrl?.includes("/organization")?"UTC":account.amountScope==="local-estimate"?"Asia/Shanghai":undefined),
      detail: status === "stale" ? `数据已过期 · ${error || "读取失败"}${description ? ` · ${description}` : ""}` : error || description,
      sourceUrl: account.sourceUrl, periodStart: account.periodStart, periodEnd: account.periodEnd,todayPeriodStart:account.todayPeriodStart,todayPeriodEnd:account.todayPeriodEnd,lastUpdated: account.observedAt,
    };
  });
}

function apiAmountScope(account:ApiUsageAccount,mode?:"live"|"demo"):ApiAmountScope{
  if(mode==="demo")return "demo";
  if(account.sourceUrl==="local:mimo-recommendation-ledger"&&account.amountScope==="local-estimate")return "local-estimate";
  if(account.sourceUrl==="https://api.deepseek.com/user/balance"||account.sourceUrl==="https://platform.xiaomimimo.com/"&&account.amountScope==="balance")return "balance";
  if(["https://api.openai.com/v1/organization/costs","https://api.anthropic.com/v1/organizations/cost_report"].includes(account.sourceUrl??""))return "organization";
  return "unknown";
}
const moneyAgeLimit=5*60_000;
function moneyTime(value:string|undefined):number{
  if(!value||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  return Date.parse(value);
}
const finiteMoney=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
export function apiMoneyView(api:ProviderStatus,now=Date.now()){
  const scope=api.apiAmountScope??"unknown",demo=scope==="demo",observed=moneyTime(api.lastUpdated);
  const knownTime=Number.isFinite(observed)&&observed<=now+1000;
  const expired=knownTime&&now-observed>moneyAgeLimit||api.apiReadStatus==="stale";
  const unavailable=["stale","error","unavailable"].includes(api.apiReadStatus??"unavailable")||api.state==="offline"||api.state==="unknown";
  const supportedCurrency=demo||scope==="organization"&&api.currency==="USD"||scope==="local-estimate"&&api.currency==="CNY"||scope==="balance"&&["CNY","USD"].includes(api.currency??"");
  const currencyKnown=/^[A-Z]{3}$/.test(api.currency??"")&&supportedCurrency;
  const fresh=demo||knownTime&&!expired&&!unavailable&&currencyKnown;
  const money=(value:unknown)=>finiteMoney(value)&&currencyKnown?`${formatMoney(value,api.currency)} ${api.currency}`:"未知";
  const zone=api.apiPeriodTimeZone;
  const validPeriod=(start:string|undefined,end:string|undefined,monthly:boolean)=>{
    if(!zone)return false;
    const shift=zone==="Asia/Shanghai"?8*3600000:0,day=new Date(now+shift).toISOString().slice(0,10),suffix=shift?"+08:00":"Z";
    const expected=Date.parse(`${monthly?day.slice(0,7)+"-01":day}T00:00:00${suffix}`),tomorrow=Date.parse(`${day}T00:00:00${suffix}`)+86400000;
    const a=moneyTime(start),b=moneyTime(end);
    return a===expected&&Number.isFinite(b)&&b>=a&&b>=observed-1000&&b<=tomorrow;
  };
  const dayValid=demo||validPeriod(api.todayPeriodStart,api.todayPeriodEnd,false),monthValid=demo||validPeriod(api.periodStart,api.periodEnd,true);
  const balanceScope=scope==="balance"||demo&&finiteMoney(api.balance);
  const label=scope==="balance"?"账户余额":scope==="organization"?"组织费用 · 本月":scope==="local-estimate"?"本机推荐估算 · 本月":demo?"开发模拟金额":"金额口径未确认";
  const primary=fresh&&(balanceScope||monthValid)?money(balanceScope?api.balance:api.monthlyCost):"未知";
  const today=fresh&&dayValid?money(api.todayCost):"未知";
  const hasCurrentAmount=primary!=="未知"||!balanceScope&&today!=="未知";
  const note=demo?"开发模拟":expired?"数据已过期":!knownTime?"读取时间未确认":unavailable?"暂不可用":scope==="unknown"?"金额口径未确认":!currencyKnown?"币种未确认":!balanceScope&&(!monthValid||!dayValid)?"统计区间未确认":api.state==="warning"||api.apiReadStatus==="degraded"?"部分数据不可用":"";
  const stamp=knownTime?new Date(observed).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"未知";
  const range=(start:string|undefined,end:string|undefined)=>Number.isFinite(moneyTime(start))&&Number.isFinite(moneyTime(end))?`${start} 至 ${end}`:"未提供";
  const period=balanceScope?"余额快照":`${zone==="UTC"?"UTC":zone==="Asia/Shanghai"?"北京时间":"时区未确认"} · 月区间 ${range(api.periodStart,api.periodEnd)}；日区间 ${range(api.todayPeriodStart,api.todayPeriodEnd)}`;
  const previous=balanceScope?`账户余额 ${money(api.balance)}`:`原月区间 ${money(api.monthlyCost)} · 原日区间 ${money(api.todayCost)}`;
  return {scope,label,primary,today,note,stamp,period,previous,hasCurrentAmount,showPrevious:!demo&&!hasCurrentAmount&&[api.balance,api.monthlyCost,api.todayCost].some(finiteMoney),balanceScope};
}
export function apiHudSummary(providers:ProviderStatus[],now=Date.now()){
  const rows=providers.filter(item=>item.kind==="api");
  const readable=rows.filter(item=>apiMoneyView(item,now).hasCurrentAmount);
  const identity=(item:ProviderStatus)=>["deepseek","mimo","anthropic","openai"].find(id=>item.id===id||item.id.startsWith(id+"-")||item.id==="api-"+id)??item.id;
  const count=new Set(readable.map(identity)).size;
  const warning=rows.some(item=>["stale","error","degraded"].includes(item.apiReadStatus??"")||item.state==="warning"||item.state==="offline"||apiMoneyView(item,now).showPrevious);
  return {label:"API 账户",value:count?`${count} 个已读取`:"未知",meta:"余额与费用分列",state:warning?"warning":count?"normal":"unknown"};
}
