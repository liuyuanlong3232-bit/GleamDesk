import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApiConnectionSettings } from "../types";
import { clearCredential, hasCredential, saveCredential, hasLegacyCredentials, importLegacyCredentials } from "../services/credentials";
import { readApiUsage, type ApiSource } from "../providers/api/apiUsageProvider";
import { formatMoney } from "../services/formatMoney";
import { openDailyLink } from "./DailyOpenSource";
import {invokeLive,requireRealCallsAllowed} from "../services/simulationSafety";

function Connection({ source, connections, onChange,simulationEnabled=false }: { source: ApiSource; connections: ApiConnectionSettings; onChange: (next: ApiConnectionSettings) => void;simulationEnabled?:boolean }) {
  const [secret, setSecret] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = source === "openai" ? "openaiEnabled" : source === "mimo" ? "mimoEnabled" : source === "deepseek" ? "deepseekEnabled" : "anthropicEnabled";
  const name = source === "openai" ? "OpenAI API" : source === "mimo" ? "MiMo · 2.6 Flash" : source === "deepseek" ? "DeepSeek" : "Anthropic API";
  useEffect(() => {
    let active = true;
    void hasCredential(source).then((value) => { if (active) setConfigured(value); })
      .catch(() => { if (active) setMessage("无法读取凭据状态"); });
    return () => { active = false; };
  }, [source, connections.credentialRevision]);
  const act = async (action: "save" | "clear" | "test" | "generate") => {
    setBusy(true); setMessage("");
    try {
      if(action==="generate"||action==="test")await requireRealCallsAllowed(simulationEnabled);
      if (action === "generate" && source === "mimo") {
        const result=await invokeLive<{items:unknown[]}>("generate_daily_recommendations",{consent:true},simulationEnabled);
        setMessage(`已生成 ${result.items.length} 个项目的中文介绍并缓存；今天不会重复调用。`);
      } else if (action === "test" && source === "mimo") {
        await invoke("mimo_connection_status");
        setMessage("连接成功，2.6 Flash 模型可用；未调用付费推理。自动余额请在下方连接官方账户。");
      } else if (action === "test") {
        const data = await readApiUsage(source);
        const accounts = data.accounts.map((account) => `${account.name} · ${source === "deepseek" ? `账户余额 ${formatMoney(account.balance, account.currency)} ${account.currency}` : `组织费用 ${formatMoney(account.monthCost, account.currency)} ${account.currency}；UTC 报告区间 ${account.periodStart??"未知"} 至 ${account.periodEnd??"未知"}`}`);
        onChange({...connections,[key]:true,credentialRevision:Date.now()});
        setMessage(`读取成功：${accounts.join("；")}`);
      } else {
        if (action === "save") await saveCredential(source, secret.trim()); else await clearCredential(source);
        setSecret(""); setConfigured(action === "save");
        onChange({ ...connections, [key]: action === "save", ...(source === "mimo" && action === "clear" ? {mimoDailyAuto:false} : {}), credentialRevision: Date.now() });
        setMessage(action === "save" ? "凭据已安全保存" : "凭据已删除");
      }
    } catch (error) {
      const candidate = error && typeof error === "object" ? error as { message?: string } : {};
      setMessage(typeof error === "string" ? error : candidate.message || "操作失败，请在 Windows 桌面应用中重试");
    } finally { setBusy(false); }
  };
  return <details className="api-connection connection-card">
    <summary><strong>{name}</strong><span className="connection-state">{configured === null ? "正在检查保存状态" : configured ? "凭据已保存" : "未配置"}</span></summary>
    <div className="connection-card-body">
    <p className="connection-purpose-note">{source === "anthropic" || source === "openai" ? "组织费用 · 需管理密钥，普通聊天密钥不适用。" : source === "mimo" ? "模型连接、付费推荐和账户余额。" : "账户余额 · 不发送聊天消息。"}</p>
    <label className="settings-toggle">{source === "mimo" ? "启用 MiMo 连接与本机用量读取" : "启用自动读取"}<input type="checkbox" checked={connections[key] === true} onChange={(event) => onChange({ ...connections, [key]: event.target.checked })} /></label>
    <label>{source === "anthropic" || source === "openai" ? "组织管理凭据" : "API 密钥"}<input type="password" autoComplete="new-password" value={secret} disabled={!isTauri() || busy} placeholder={configured ? "已保存 · 输入新凭据以替换" : "输入密钥，仅保存在本机"} onChange={(event) => setSecret(event.target.value)} /></label>
    <div className="settings-actions"><button disabled={!isTauri() || busy || !secret.trim()} onClick={() => void act("save")}>安全保存</button><button disabled={simulationEnabled || !isTauri() || busy || !configured} onClick={() => void act("test")}>读取验证</button>{configured && <button disabled={busy} onClick={() => void act("clear")}>删除凭据</button>}</div>
    {source === "mimo" && <section className="connection-purpose"><h4>每日推荐 · 付费功能</h4><button disabled={simulationEnabled || !isTauri() || busy || !configured || !connections.mimoEnabled} onClick={() => void act("generate")}>生成今日中文介绍（付费，每日最多 1 次）</button><label className="settings-toggle">允许每天自动生成中文推荐（付费）<input type="checkbox" disabled={simulationEnabled || !connections.mimoEnabled || !configured} checked={connections.mimoDailyAuto === true} onChange={(event) => onChange({...connections,mimoDailyAuto:event.target.checked})}/></label><details className="settings-help"><summary>付费调用说明</summary><p>按量计费 API Key（sk-）。仅发送最多 8 个公开项目名和简介；每天最多 1 次请求，关闭深度思考，估算月费用上限 ¥1。失败当天不重试；桌面关闭时不调用。密钥只保存在本机。</p></details><button className="text-button" onClick={() => void openDailyLink("https://platform.xiaomimimo.com/","MiMo 官方余额").catch(() => setMessage("无法打开 MiMo 控制台"))}>查看 MiMo 官方余额 ↗</button></section>}
    <details className="settings-help"><summary>帮助与数据范围</summary><p>{source === "openai" ? "使用组织管理密钥读取官方今日和本月费用（UTC）；余额接口未公开，余额保持未知。缺少组织权限时会提示，不会把普通模型密钥误当账单凭据。" : source === "mimo" ? "API Key 用于模型调用；余额通过下方的官方账户登录连接。今日和本月仅本机推荐调用的人民币估算，不代表整个账户消费。" : source === "deepseek" ? "读取官方账户余额；今日和本月费用未知。" : "读取 Claude Console 组织的费用报告；需要有 Admin API 权限的凭据，个人账户和普通工作区密钥不适用。费用按 UTC 统计，不含 Priority Tier，可能延迟。"}</p><p>凭据保存在 Windows 凭据管理器，不随应用配置导出。</p></details>
    {source === "mimo" && <MimoBalanceConnection connections={connections} onChange={onChange} simulationEnabled={simulationEnabled}/>}
    {message && <small role="status">{message}</small>}
    </div>
  </details>;
}

export function ApiConnectionsSettings({ connections, onChange,simulationEnabled=false }: { connections: ApiConnectionSettings; onChange: (next: ApiConnectionSettings) => void;simulationEnabled?:boolean }) {
  return <div className="settings-section api-settings">
    <LegacyCredentialImport simulationEnabled={simulationEnabled} onImported={() => onChange({...connections,mimoDailyAuto:false,credentialRevision:Date.now()})}/>
    {simulationEnabled&&<p role="status">模拟模式：真实生成和读取验证已暂停。</p>}
    {!isTauri()&&<small>账户连接需要 Windows 桌面程序。</small>}
    <Connection source="deepseek" connections={connections} onChange={onChange} simulationEnabled={simulationEnabled} />
    <Connection source="anthropic" connections={connections} onChange={onChange} simulationEnabled={simulationEnabled} />
    <Connection source="mimo" connections={connections} onChange={onChange} simulationEnabled={simulationEnabled} />
    <Connection source="openai" connections={connections} onChange={onChange} simulationEnabled={simulationEnabled} />
    <details className="settings-help"><summary>接入帮助</summary><p>这里管理余额与费用读取。聊天室的模型和聊天密钥，在 Agent Room 的成员设置中配置。</p><p>密钥保存在 Windows Credential Manager；应用配置和历史只保存读取结果。</p><p>尚未配置的服务保持停用；保存密钥或读取验证成功后启用。AI 客户端订阅在“AI 客户端状态”中查看。</p></details>
  </div>;
}

const legacyChoiceKey="gleamdesk.legacy-credentials.choice.v1";
export function LegacyCredentialImport({simulationEnabled=false,onImported}:{simulationEnabled?:boolean;onImported:()=>void}){
  const [available,setAvailable]=useState(false),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  const [choice,setChoice]=useState(()=>{try{return localStorage.getItem(legacyChoiceKey)??""}catch{return ""}});
  useEffect(()=>{let active=true;void hasLegacyCredentials().then(value=>{if(active)setAvailable(value)}).catch(()=>{if(active)setMessage("旧版账号检查失败，可稍后重试打开设置")});return()=>{active=false}},[]);
  const choose=(next:string)=>{try{localStorage.setItem(legacyChoiceKey,next);setChoice(next)}catch{setMessage("选择未能保存，请稍后重试")}};
  const importAccounts=async()=>{
    if(!consent||busy||simulationEnabled)return;
    setBusy(true);setMessage("");
    try{const count=await importLegacyCredentials(true);choose("imported");setConsent(false);setMessage(`已导入 ${count} 项；已有 GleamDesk 账号和旧版账号均保留。`)}
    catch(error){setMessage(typeof error==="string"?error:"导入未完成，旧版账号仍保留，可重试")}
    finally{onImported();setBusy(false)}
  };
  if(!available)return message?<small role="status">{message}</small>:null;
  return <section className="connection-purpose" aria-label="旧版账号导入">
    {choice?<><div className="settings-actions"><button className="text-button" disabled={busy} onClick={()=>{setChoice("");setMessage("")}}>导入旧版账号…</button></div>{message&&<p role="status">{message}</p>}</>:<>
      <h4>发现本机旧版账号</h4><p>是否将 AgentRoom 的账号复制到 GleamDesk？已有账号不覆盖，旧版账号不删除。</p>
      <details className="settings-help"><summary>导入范围</summary><p>请先退出旧 AgentRoom。导入 API、聊天、邮箱和 VPS 服务凭据；仅在本机复制，不测试连接、不启用自动付费推荐。设置、自选和历史记录继续保留。</p></details>
      <label className="settings-toggle">同意导入旧版账号<input type="checkbox" checked={consent} disabled={busy||simulationEnabled} onChange={event=>setConsent(event.target.checked)}/></label>
      <div className="settings-actions"><button disabled={!consent||busy||simulationEnabled} onClick={()=>void importAccounts()}>{busy?"正在导入…":"导入账号"}</button><button disabled={busy} onClick={()=>{setConsent(false);choose("skipped")}}>暂不导入</button></div>
      {message&&<small role="status">{message}</small>}
    </>}
  </section>;
}


function MimoBalanceConnection({connections,onChange,simulationEnabled=false}:{connections:ApiConnectionSettings;onChange:(next:ApiConnectionSettings)=>void;simulationEnabled?:boolean}){
  const [configured,setConfigured]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState("");
  useEffect(()=>{let active=true;void hasCredential("mimo-console").then(value=>{if(active)setConfigured(value);}).catch(()=>{if(active)setMessage("无法读取余额连接状态");});return()=>{active=false;};},[connections.credentialRevision]);
  const act=async(action:"open"|"connect"|"read"|"disconnect")=>{
    setBusy(true);setMessage("");
    try{
      if(action!=="disconnect")await requireRealCallsAllowed(simulationEnabled);
      if(action==="open"){await invoke("mimo_balance_open");setMessage("请在独立官方窗口登录，完成后返回这里点“登录完成，连接余额”。");}
      else if(action==="connect"){
        const value=await invoke<{balance:number;currency:string}>("mimo_balance_connect",{consent:true});
        setConfigured(true);onChange({...connections,mimoEnabled:true,credentialRevision:Date.now()});setMessage(`账户连接成功 · 余额 ${formatMoney(value.balance,value.currency)} ${value.currency}`);
      }else if(action==="read"){
        const value=await readApiUsage("mimo");const account=value.accounts[0];
        setMessage(account.balance!==undefined?`最新余额 ${formatMoney(account.balance,account.currency)} ${account.currency}`:"余额读取失败或登录过期，请重新连接官方账户。");
      }else{await clearCredential("mimo-console");setConfigured(false);onChange({...connections,credentialRevision:Date.now()});setMessage("已断开自动余额连接；API 密钥仍可用于推荐。官方窗口登录状态可由你自行退出。");}
    }catch(cause){setMessage(typeof cause==="string"?cause:"MiMo 余额连接失败，请检查登录状态");}finally{setBusy(false);}
  };
  return <section className="mimo-balance-connection connection-purpose"><h4>官方账户余额 · {configured?"已连接":"待连接"}</h4>
    <p>先登录官方账户。点击连接即同意读取本窗口的登录凭证并保存到本机。</p>
    <div className="settings-actions"><button disabled={simulationEnabled||!isTauri()||busy} onClick={()=>void act("open")}>打开 MiMo 官方登录</button><button disabled={simulationEnabled||!isTauri()||busy} onClick={()=>void act("connect")}>登录完成，连接余额</button>{configured&&<><button disabled={simulationEnabled||busy} onClick={()=>void act("read")}>刷新余额</button><button disabled={busy} onClick={()=>void act("disconnect")}>断开余额连接</button></>}</div>
    <details className="settings-help"><summary>余额连接帮助</summary><p>仅请求官方 HTTPS 余额地址，不读取其他浏览器账户、不发送到 VPS。验证成功后，凭证保存在 Windows 凭据管理器。显示时每分钟检查，窗口隐藏时停止。接口变动或登录过期时显示未知。</p></details>
    {message&&<small role="status">{message}</small>}
  </section>;
}
