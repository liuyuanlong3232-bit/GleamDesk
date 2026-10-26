import { useEffect, useState } from "react";
import type { ProviderStatus } from "../types";
import {dataStateLabel,formatDataUpdatedAt,observedDataState} from "../domain/providers/contracts";
import type { LocalAiSnapshot } from "../domain/local/contracts";
import { readCodexQuotaHistory, type CodexQuotaRecord } from "../services/historyStore";

export function usageWindowTitle(window: { id: string; windowDurationMins?: number;title?:string }, agentId: string): string {
  if (window.title) return window.title;
  if (window.windowDurationMins === 300) return "5 小时额度";
  if (window.windowDurationMins === 10080) return "周额度";
  if (window.windowDurationMins) return `${window.windowDurationMins} 分钟额度`;
  return agentId === "claude" ? window.id === "primary" ? "Session 额度" : "Weekly 额度" : "额度窗口";
}
export function membershipBenefitDetail(detail:string,observedAt?:number):string {
  const relative=detail.match(/(?:(\d+)\s*小时\s*)?(?:(\d+)\s*分钟\s*)?后重置/);
  if(!relative||(!relative[1]&&!relative[2]))return detail;
  if(!Number.isFinite(observedAt))return detail.replace(relative[0],"读取时的相对重置时间");
  const reset=new Date(observedAt!+(Number(relative[1]||0)*60+Number(relative[2]||0))*60000);
  return detail.replace(relative[0],`重置 ${reset.toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}（约）`);
}
const agentIds = ["codex", "claude", "antigravity", "ollama", "doubao"] as const;
const names = { codex: "Codex", claude: "Claude Code", antigravity: "Antigravity", ollama: "Ollama", doubao: "豆包" };
const glyphs = { codex: "✳", claude: "✺", antigravity: "▲", ollama: "◌", doubao: "豆" };
const sourceNames: Record<string, string> = { "codex-cli-official-rpc": "Codex CLI · 官方额度", "codex-cli": "Codex CLI", "claude-cli-auth-status": "Claude CLI · 登录状态", "claude-oauth-usage":"Claude 账户使用量", "claude-engine-get-usage":"Claude Code · 客户端额度", "antigravity-local-quota":"Antigravity 本机额度", "doubao-member-page":"豆包官方会员页", "windows-client-metadata": "本机安装 / 进程", none: "没有可靠来源" };
const confidenceNames = { verified: "已核实", local: "本地", estimated: "估算", unknown: "额度未知" };

export function AIControlCenter({ agents, localAI, gpuName, simulationEnabled=false }: { agents: ProviderStatus[]; localAI?: LocalAiSnapshot | null; gpuName?: string|null; simulationEnabled?:boolean }) {
  const [details, setDetails] = useState(false);
  const [history,setHistory]=useState<CodexQuotaRecord[]>([]);
  const [historyUnavailable,setHistoryUnavailable]=useState(false);
  const codexUpdatedAt=agents.find(agent=>agent.id==="codex")?.lastUpdated;
  useEffect(()=>{
    if(simulationEnabled){setHistory([]);setHistoryUnavailable(false);return;}
    let active=true;
    void readCodexQuotaHistory().then(records=>{if(active){setHistory(records);setHistoryUnavailable(false);}}).catch(()=>{if(active)setHistoryUnavailable(true);});
    return()=>{active=false;};
  },[codexUpdatedAt,simulationEnabled]);
  const overview=summarizeAiStatus(agents,localAI);
  return <article className="widget-card ai-control-center">
    <div className="card-heading"><span className="heading-glyph">◉</span><strong>AI 客户端</strong><div className="heading-actions"><button className="card-link" onClick={()=>window.dispatchEvent(new Event("codex-desktop.open-agent-connections"))}>连接</button><button className="card-link" aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? "收起来源" : "来源详情"} ›</button></div></div>
    <div className="ai-status-overview" aria-label="AI 状态总览" title="在线表示真实数据连接可用；缓存包含已过期数据，不代表模型正在运行。">{Object.entries(overview).map(([label,count])=><span key={label}>{label}<b>{count}</b></span>)}</div>
    <div className="ai-ecosystem-grid">
      {agentIds.map(id => {
        const agent = agents.find(item => item.id === id);
        const expanded = id === "ollama" ? localAI?.serviceStatus === "online" : agent?.running === true || (id==="doubao"&&agent?.membership?.available===true);
        const confidence = agent?.confidence ?? "unknown";
        const windows = agent?.usageWindows ?? [];
        const vramKnown=localAI?.runningModels.every(model=>typeof model.sizeVramBytes==="number");
        const vram=localAI?.runningModels.reduce((sum,model)=>sum+(model.sizeVramBytes??0),0);
        return <section key={id} aria-label={names[id]} data-agent-id={id} data-expanded={expanded} className={`ai-agent-tile agent-${id} ${expanded ? "is-expanded" : "is-collapsed"}`}>
          <header><span className={`provider-symbol ${id}`}>{glyphs[id]}</span><strong>{agent?.name ?? names[id]}</strong>
            {expanded && (id === "ollama"
              ? <span className="confidence-tag confidence-local">本地 API</span>
              : id==="doubao"?<span className="confidence-tag confidence-local">{agent?.membership?.available?"会员权益":"待连接"}</span>:<span className={`confidence-tag confidence-${confidence}`}>{confidenceNames[confidence]}</span>)}
          </header>
          {expanded && <small className="data-observation">{dataStateLabel(id==="ollama"?localAI?.serviceStatus==="online"?observedDataState(localAI.observedAtUnixMs,60000,Date.now(),false):"Unknown":agent?.dataState??"Unknown")} · {formatDataUpdatedAt(id==="ollama"?localAI?.observedAtUnixMs:agent?.lastUpdated)}</small>}
          {expanded && (id === "ollama" ? <>
            <p>在线 · {localAI?.modelCount ?? "未知数量"} 个模型</p><small>{localAI?.runningModels.length ?? "未知"} 个运行模型 · 显存 {vramKnown&&vram!==undefined?`${(vram/1024**3).toFixed(2)} GiB`:"未知"}</small>
            <small>本工作台调用 {localAI?.usage?.requests??"未知"} 次 · 已记录输入 {localAI?.usage?.inputTokens??"未知"} / 输出 {localAI?.usage?.outputTokens??"未知"} token</small>
            {localAI?.usage?.unmeasuredRequests?<small>{localAI.usage.unmeasuredRequests} 次用量不完整</small>:null}
            <small>本机 GPU：{gpuName || "未知"} · {localAI?.modelCount === 0 ? "无模型" : localAI?.models.some(model => !model.remote) ? "Ready" : localAI?.truncated ? "本地模型状态未知" : "无本地模型"}</small>
            <details className="local-model-list"><summary>模型列表</summary>{localAI?.models.length ? localAI.models.map(model => <p key={model.name}><b>{model.name}</b><small>{[model.parameterSize,model.quantization,model.remote ? "远程模型" : "本地模型"].filter(Boolean).join(" · ")}</small></p>) : <p>尚无已安装模型</p>}{localAI?.truncated && <small>列表已截断，最多显示128项</small>}</details>
          </> : <>
            {(id === "codex" || id === "claude" || id === "antigravity") ? <>
              <small>{agent?.plan ? `${agent.plan} · ` : ""}{agent?.loginStatus === "not-logged-in" ? "未登录" : agent?.loginStatus === "verified" ? "已连接" : agent?.loginStatus === "configured" ? "已保存登录" : "登录状态未知"}</small>
              {!windows.length&&<p className="provider-hint">{id==="claude"?agent?.loginStatus==="not-logged-in"?"未登录":agent?.usageType==="api"?"API 计费":"额度暂不可用":"额度暂不可用"}</p>}
              <div className="agent-quota-windows">{windows.map(window => <div key={window.id}>
                <span>{usageWindowTitle(window, id)}</span><b>{window.usedPercent === undefined ? "未知" : `剩余 ${Number((100-window.usedPercent).toFixed(1))}%`}</b>
                <small>重置 {"resetsAt" in window && window.resetsAt ? new Date(window.resetsAt).toLocaleString("zh-CN", {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "未知"}</small>
              </div>)}</div>
            </> : id==="doubao"?<><p>{agent?.membership?.available?agent.membership.planName||"会员档位未提供":"豆包客户端运行中 · 会员待连接"}</p><small>{agent?.membership?.expiryText||"有效期未知"}</small>{agent?.membership?.benefits?.map((item,index)=><small key={index}>{membershipBenefitDetail(item.detail,agent?.membership?.observedAtUnixMs)}</small>)}<small>{agent?.membership?.available?`官方会员页${agent.membership.cached?" · 缓存快照":" · 页面读取"}${agent.membership.observedAtUnixMs?` · ${new Date(agent.membership.observedAtUnixMs).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}`:""}`:"在连接设置打开官方会员权益并读取"}</small></>:<><p><i className="live-dot" />客户端运行中</p><small>登录未知 · 额度未知</small></>}
            {agent?.ordinaryUsageAllowed === false && <small className="provider-hint">服务端当前不允许普通用量</small>}

          </>)}
        </section>;
      })}
    </div>
    {simulationEnabled?<section className="codex-quota-trend" aria-label="Codex 额度使用趋势"><p>模拟模式 · 不读取真实额度历史</p></section>:<CodexQuotaTrend records={history} unavailable={historyUnavailable}/>}
    {details && <div className="widget-source-details">
      {agents.filter(agent => ["codex","claude","antigravity","doubao"].includes(agent.id)).map(agent => <p key={agent.id}><strong>{agent.name}</strong><span>{sourceNames[agent.source??"none"]??"未知"}{agent.detail?` · ${agent.detail}`:""}{agent.lastUpdated ? ` · 读取于 ${new Date(agent.lastUpdated).toLocaleString("zh-CN")}` : ""}{agent.id === "antigravity" ? ` · CLI ${agent.cliDetected ? "已检测" : "未检测"} · 配置 ${agent.configurationDetected ? "存在" : "未检测"} · 缓存 ${agent.cacheDetected ? "存在" : "未检测"} · 最近使用未知` : ""}</span></p>)}
      <p><strong>Ollama</strong><span>{localAI?.serviceStatus === "online" ? "本机 API 已连接" : localAI?.error || "本机服务状态未知"}</span></p>


    </div>}
  </article>;
}
export function summarizeAiStatus(agents:ProviderStatus[],localAI?:LocalAiSnapshot|null,now=Date.now()) {
  const counts={在线:0,缓存:0,未知:0,未连接:0};
  for(const id of agentIds) {
    let status:keyof typeof counts="未知";
    if(id==="ollama") {
      if(localAI?.serviceStatus==="offline")status="未连接";
      else if(localAI?.serviceStatus==="online") {
        const state=observedDataState(localAI.observedAtUnixMs,60_000,now,false);
        status=state==="Live"?"在线":state==="Stale"?"缓存":"未知";
      }
    } else {
      const agent=agents.find(item=>item.id===id);
      if(agent && agent.confidence!=="estimated") {
        if(agent.dataState==="Cached" || agent.dataState==="Stale" || agent.membership?.cached)status="缓存";
        else if(agent.dataState==="Live" && (agent.confidence==="verified" || agent.membership?.available))status="在线";
        else if(agent.state==="offline" || agent.installed===false || agent.loginStatus==="not-logged-in" || agent.running===false)status="未连接";
      }
    }
    counts[status]++;
  }
  return counts;
}

export function codexQuotaSeries(records:CodexQuotaRecord[]) {
  const ids=[...new Set(records.flatMap(record=>record.payload.windows.map(window=>window.id)))];
  return ids.map(id=>{
    const latest=records.flatMap(record=>record.payload.windows.filter(window=>window.id===id)).at(-1)!;
    const segments:Array<Array<{at:number;usedPercent:number}>>=[];
    let previousReset:string|undefined,previousDuration:number|undefined,previousPercent:number|undefined;
    let gap=true;
    for(const record of records) {
      const window=record.payload.windows.find(row=>row.id===id);
      if(!window){gap=true;continue;}
      // Never draw across a reset or a window change, even if reset metadata is missing.
      if(gap || window.resetsAt!==previousReset || window.windowDurationMins!==previousDuration
        || (previousPercent!==undefined && window.usedPercent<previousPercent))segments.push([]);
      segments.at(-1)!.push({at:Date.parse(record.createdAt),usedPercent:window.usedPercent});
      previousReset=window.resetsAt;previousDuration=window.windowDurationMins;previousPercent=window.usedPercent;gap=false;
    }
    return {id,title:usageWindowTitle(latest,"codex"),segments};
  });
}

export function CodexQuotaTrend({records,unavailable=false}:{records:CodexQuotaRecord[];unavailable?:boolean}) {
  const series=codexQuotaSeries(records);
  const first=records[0],last=records.at(-1);
  const start=first?Date.parse(first.createdAt):0,end=last?Date.parse(last.createdAt):0;
  const x=(at:number)=>end===start?160:28+(at-start)/(end-start)*280;
  const y=(percent:number)=>116-percent;
  return <section className="codex-quota-trend" aria-label="Codex 额度使用趋势">
    <header><strong>额度使用趋势</strong><small>Codex · 已用比例</small></header>
    {unavailable?<p role="status">额度历史读取失败，暂不绘制曲线。</p>:!records.length?<p>暂无额度历史；取得真实额度后开始记录。</p>:<>
      <svg viewBox="0 0 320 144" role="img" aria-label="Codex 已用额度百分比历史曲线，范围 0 至 100%" preserveAspectRatio="xMidYMid meet">
        {[0,50,100].map(percent=><g key={percent}><line x1="28" x2="308" y1={y(percent)} y2={y(percent)} className="quota-trend-grid"/><text x="2" y={y(percent)+4}>{percent}%</text></g>)}
        {series.map((line,index)=><g key={line.id} className={index%2?"quota-trend-week":"quota-trend-session"}>{line.segments.map((segment,part)=><g key={part}><polyline points={segment.map(point=>x(point.at).toFixed(2)+","+y(point.usedPercent).toFixed(2)).join(" ")} vectorEffect="non-scaling-stroke"/>{segment.map(point=><circle key={point.at} cx={x(point.at)} cy={y(point.usedPercent)} r="2"><title>{new Date(point.at).toLocaleString("zh-CN")} · 已用 {point.usedPercent}%</title></circle>)}</g>)}</g>)}
      </svg>
      <div className="quota-trend-time"><span>{new Date(start).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span><span>{new Date(end).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</span></div>
      <div className="quota-trend-legend">{series.map((line,index)=><span key={line.id} className={index%2?"quota-trend-week":"quota-trend-session"}><i/>{line.title}</span>)}</div>
      <small>{records.length<2?"历史不足，等待下一次额度变化。":"仅记录额度变化；重置或比例下降处断线。"} · {formatDataUpdatedAt(last?.createdAt)}（历史记录）</small>
    </>}
    <small>账户共享额度；不推算 token 消耗和费用。</small>
  </section>;
}
