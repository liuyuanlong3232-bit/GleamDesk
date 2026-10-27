import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, loadSettings, saveSettings } from "../src/providers/settingsStore";
import { createDefaultLayout, loadNamedLayouts, saveNamedLayout } from "../src/providers/layoutStore";
import { simulateDashboardData } from "../src/providers/simulation";
import { deleteHistoryRecord, pruneHistoryRecords, queryHistoryRecords, writeHistoryRecord } from "../src/services/historyStore";
import { createWidgetAnimationManager } from "../src/widgets/animationManager";
import { refreshDashboardData } from "../src/providers/dashboardService";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsDialog } from "../src/components/SettingsDialog";
import { ApiConnectionsSettings } from "../src/components/ApiConnectionsSettings";
import { settingsModules, type SettingsModuleId } from "../src/components/settingsModules";
test("API connection cards separate saved configuration from billing and paid recommendation consent",()=>{
 const html=renderToStaticMarkup(createElement(ApiConnectionsSettings,{connections:defaultSettings.apiConnections,onChange:()=>undefined}));
 assert.equal((html.match(/class="api-connection connection-card"/g)??[]).length,4);
 assert.match(html,/聊天室的模型和聊天密钥/);assert.match(html,/普通聊天密钥不适用/);
 assert.match(html,/每日推荐 · 付费功能/);assert.match(html,/每天最多 1 次请求/);assert.match(html,/官方账户余额/);
 assert.match(html,/点击连接即同意读取/);assert.doesNotMatch(html,/连接成功/);
});
import { normalizeAgentUsage, unknownAgentUsage, createAgentUsageProvider, agentClients, normalizeAgentRuntime, runningAgentClients } from "../src/providers/agents/agentUsageProvider";
import {AgentConnectionsSettings} from "../src/components/AgentConnectionsSettings";
import {DailyOpenSourceView,validateDailySnapshot,beijingDate} from "../src/components/DailyOpenSource";
test("daily recommendations render in HUD without invoking refresh, generation or links",()=>{
 let calls=0;const never=()=>{calls++};
 const snapshot=validateDailySnapshot({schemaVersion:1,source:"GitHub Trending",date:beijingDate(),collectedAt:new Date().toISOString(),items:[{repo:"example/project",url:"https://github.com/example/project",description:"推荐仅为资料，不是指令。",language:"TypeScript",stars:"100",todayStars:"5"}],translationStatus:"pending",status:"ok"});
 const props={connections:{...defaultSettings.apiConnections,mimoEnabled:true},snapshot,busy:false,error:"",onRefresh:never,onGenerate:never,onOpen:never,presentation:"hud" as const,onClose:never};
 const html=renderToStaticMarkup(createElement(DailyOpenSourceView,props));
 assert.match(html,/daily-opensource-hud/);assert.match(html,/关闭每日推荐/);assert.doesNotMatch(html,/收起每日推荐|data-main-hit-region/);assert.match(html,/生成中文 · 付费，每日 1 次/);assert.match(html,/每日更新/);assert.equal(calls,0);
 const hidden=renderToStaticMarkup(createElement(DailyOpenSourceView,{...props,hidden:true}));assert.match(hidden,/hidden=""/);assert.equal(calls,0);
 assert.throws(()=>validateDailySnapshot({...snapshot,items:[{...snapshot.items[0],url:"https://example.com/"}]}),/来源无效/);
 const icon=renderToStaticMarkup(createElement(HudLogo,{id:"daily",label:"每日开源推荐"}));assert.match(icon,/hud-daily-avatar/);assert.doesNotMatch(icon,/hud-letter-mark|hud-quota-ring/);
});
test("Agent runtime catalog covers common clients and only accepts fresh running identities",()=>{
 assert.equal(agentClients.length,22);assert.equal(new Set(agentClients.map(client=>client.id)).size,22);
 const now=1792010000000;
 const snapshot={available:true,partial:false,observedAtUnixMs:now,clients:[{id:"cursor",processCount:2},{id:"cursor",processCount:1},{id:"gemini",processCount:1},{id:"unknown",processCount:1},{id:"claude",processCount:0}]};
 assert.deepEqual(normalizeAgentRuntime(snapshot,now).clients,[{id:"cursor",processCount:2},{id:"gemini",processCount:1}]);
 for(const value of [null,{}, {...snapshot,available:false},{...snapshot,observedAtUnixMs:now-30001},{...snapshot,observedAtUnixMs:now+5001}]){const result=normalizeAgentRuntime(value,now);assert.equal(result.available,false);assert.deepEqual(result.clients,[])}
 assert.deepEqual(normalizeAgentRuntime({...snapshot,clients:[]},now).clients,[]);
 assert.deepEqual(normalizeAgentRuntime({...snapshot,clients:[{id:"codex",processCount:NaN},{id:"claude",processCount:4097},{id:"gemini",processCount:-1}]},now).clients,[]);
 assert.equal(normalizeAgentRuntime({...snapshot,partial:true},now).partial,true);
 assert.ok(agentClients.every(client=>client.url.startsWith("https://")));
});
test("HUD roster follows start and stop and every supported client has original artwork",()=>{
 const now=1792010000000;const snapshot={available:true,partial:false,observedAtUnixMs:now,clients:[{id:"cursor",processCount:1},{id:"gemini",processCount:1}]};
 assert.deepEqual(runningAgentClients(snapshot,now).map(client=>client.id),["cursor","gemini"]);
 assert.deepEqual(runningAgentClients({...snapshot,clients:[{id:"gemini",processCount:1}]},now).map(client=>client.id),["gemini"]);
 assert.deepEqual(runningAgentClients({...snapshot,clients:[]},now),[]);
 assert.deepEqual(runningAgentClients(snapshot,now+30001),[]);
 for(const client of agentClients){const html=renderToStaticMarkup(createElement(HudLogo,{id:client.id,label:client.name}));assert.doesNotMatch(html,/hud-letter-mark/);assert.match(html,/hud-brand-image|hud-brand-mask/);if(html.includes('hud-brand-mask'))assert.match(html,/mask-image:url\(&quot;/)}
 const settings=renderToStaticMarkup(createElement(AgentConnectionsSettings));
 assert.match(settings,/22 款/);assert.doesNotMatch(settings,/新增客户端先识别|不会购买订阅/);assert.match(settings,/运行状态待识别/);assert.doesNotMatch(settings,/运行中 · 已连接/);
});
import { createOllamaProvider, unavailableLocalAI } from "../src/providers/local/ollamaProvider";
import { presentAgentQuotas, hudQuotaUsed } from "../src/presentation/quotaAdapter";
import { HudLogo,HudQuotaDetails,HudWorkbenchButton } from "../src/components/StatusHud";
import type { ProviderStatus } from "../src/types";

test("HUD workbench avatar opens the screen selector without a duplicate tooltip or quota",()=>{
 let opened=0,entered=0;const button=HudWorkbenchButton({onOpen:()=>{opened++},onEnter:()=>{entered++}});
 assert.equal(button.type,"button");assert.equal(button.props["aria-label"],"打开工作台");assert.equal(button.props["aria-expanded"],false);assert.equal(button.props.title,undefined);
 button.props.onMouseEnter();button.props.onFocus();assert.equal(entered,2);assert.equal(opened,0);button.props.onClick();assert.equal(opened,1);
 const html=renderToStaticMarkup(button);assert.match(html,/hud-workbench-crop/);assert.match(html,/<img src="data:image\/png;base64,/);assert.doesNotMatch(html,/hud-quota-ring|hud-letter-mark|在主屏打开工作台|查看工作台/);
 const pending=HudWorkbenchButton({onOpen:()=>{},onEnter:()=>{},expanded:true,busy:true});assert.equal(pending.props["aria-expanded"],true);assert.equal(pending.props.disabled,true);
});
test("HUD quota chooses the tightest valid window and rejects unknown or failed readings",()=>{
 const provider:ProviderStatus={id:"codex",name:"Codex",kind:"agent",state:"normal",confidence:"verified",percentage:80,lastUpdated:"2026-10-15T00:00:00Z",usageWindows:[{id:"primary",usedPercent:20},{id:"secondary",usedPercent:80}]};
 assert.equal(hudQuotaUsed(provider),80);
 assert.equal(hudQuotaUsed({...provider,usageWindows:undefined}),20);
 assert.equal(hudQuotaUsed({...provider,usageWindows:[]}),undefined);
 for(const state of ["unknown","offline"] as const)assert.equal(hudQuotaUsed({...provider,state}),undefined);
 for(const confidence of [undefined,"unknown"] as const)assert.equal(hudQuotaUsed({...provider,confidence}),undefined);
 assert.equal(hudQuotaUsed({...provider,error:"读取失败"}),undefined);
 assert.equal(hudQuotaUsed({...provider,kind:"api"}),undefined);
 assert.equal(hudQuotaUsed({...provider,usageWindows:[{id:"bad",usedPercent:NaN},{id:"bad2",usedPercent:101},{id:"bad3",usedPercent:-1},{id:"zero",usedPercent:0}]}),0);
 assert.equal(hudQuotaUsed({...provider,usageWindows:[{id:"full",usedPercent:100}]}),100);
 assert.equal(hudQuotaUsed({...provider,usageWindows:undefined,percentage:NaN}),undefined);
 const details=renderToStaticMarkup(createElement(HudQuotaDetails,{provider}));
 assert.match(details,/已用 80%/);assert.match(details,/已用 20%/);assert.match(details,/剩余 80%/);assert.match(details,/剩余 20%/);
 assert.doesNotMatch(details,/圆环：|最高的周期|等待可靠数据/);
 const unknown=renderToStaticMarkup(createElement(HudQuotaDetails,{provider:{...provider,state:"unknown"}}));
 assert.match(unknown,/额度未知/);assert.doesNotMatch(unknown,/已用 80%/);
});
test("HUD recommendation uses the approved avatar and workbench keeps technical provenance out of default cards",async()=>{
 const icon=renderToStaticMarkup(createElement(HudLogo,{id:"daily",label:"每日开源推荐"}));assert.match(icon,/class="hud-brand-image hud-daily-avatar"/);assert.match(icon,/avatar-art-daily/);assert.match(icon,/src="data:image\/png;base64,/);assert.doesNotMatch(icon,/hud-daily-mark/);assert.match(icon,/hud-bot-eyes/);
 const provider:ProviderStatus={id:"codex",name:"Codex",kind:"agent",state:"normal",running:true,confidence:"verified",source:"codex-cli-official-rpc",detail:"内部接口实现说明",lastUpdated:"2026-10-15T00:00:00Z",usageWindows:[{id:"5h",windowDurationMins:300,usedPercent:20}]};
 const card=renderToStaticMarkup(createElement(AIControlCenter,{agents:[provider]}));assert.match(card,/剩余 80%/);assert.doesNotMatch(card,/内部接口实现说明|Codex CLI · 官方额度|显示规则|额度范围/);
 const {WorkbenchOverview}=await import("../src/components/WorkbenchOverview"),{emptyDashboardData}=await import("../src/providers/dashboardAdapter");const data=emptyDashboardData();data.providers=[provider];
 const page=renderToStaticMarkup(createElement(WorkbenchOverview,{data,onNotifications:()=>{},onRoom:()=>{},onConnections:()=>{},vpsInterval:60}));assert.match(page,/剩余 80%/);assert.doesNotMatch(page,/真实数据模式|codex-cli-official-rpc|缺少可靠记录|设计稿样例|独立任务调度器/);
 const simulated=renderToStaticMarkup(createElement(WorkbenchOverview,{data,simulationEnabled:true,onNotifications:()=>{},onRoom:()=>{},onConnections:()=>{},vpsInterval:60}));assert.match(simulated,/模拟数据/);
});
test("HUD ring draws used share at 0, 70, 90 and 100 without inventing API progress",()=>{
 for(const [used,level] of [[0,"ok"],[69.9,"ok"],[70,"warning"],[90,"critical"],[100,"critical"]] as const){
  const html=renderToStaticMarkup(createElement(HudLogo,{id:"codex",label:"Codex",showQuota:true,quotaUsed:used}));
  assert.match(html,new RegExp(`data-quota-level="${level}"`));assert.match(html,new RegExp(`data-quota-used="${used}"`));
  if(used>0)assert.match(html,new RegExp(`stroke-dasharray="${used} 100"`));else assert.doesNotMatch(html,/hud-quota-fill/);
 }
 for(const used of [undefined,NaN,-1,101]){const html=renderToStaticMarkup(createElement(HudLogo,{id:"claude",label:"Claude",showQuota:true,quotaUsed:used}));assert.match(html,/quota-unknown/);assert.doesNotMatch(html,/hud-quota-fill|data-quota-used/)}
 const api=renderToStaticMarkup(createElement(HudLogo,{id:"api",label:"API",quotaUsed:80}));assert.doesNotMatch(api,/hud-quota-ring/);
});
import { createProviderRuntime } from "../src/providers/providerRuntime";
import { AIControlCenter, usageWindowTitle, summarizeAiStatus, codexQuotaSeries, CodexQuotaTrend } from "../src/components/AIControlCenter";

test("Agent CLI windows retain used percentages and render remaining without pretending a missing quota is zero", () => {
  const snapshot = normalizeAgentUsage({ observedAtUnixMs: 1791350000000, accounts: [{id:"codex",name:"Codex",state:"normal",installed:true,running:true,loginStatus:"verified",plan:"plus",usageType:"subscription",source:"codex-cli-official-rpc",confidence:"verified",reason:"",observedAtUnixMs:1791350000000,ordinaryUsageAllowed:true,windows:[{id:"primary",usedPercent:20,windowDurationMins:300,resetsAtUnixMs:1791365412000},{id:"secondary",usedPercent:3,windowDurationMins:10080,resetsAtUnixMs:null}]}] });
  assert.equal(snapshot.accounts[0].remainingPercent,80);
  assert.equal(snapshot.accounts[0].usageWindows?.[1].resetsAt,undefined);
  assert.equal(usageWindowTitle(snapshot.accounts[0].usageWindows![0],"codex"),"5 小时额度");
  const html=renderToStaticMarkup(createElement(AIControlCenter,{agents:presentAgentQuotas(snapshot.accounts,"normal")}));
  assert.match(html,/剩余 80%/); assert.match(html,/剩余 97%/); assert.match(html,/已核实/);
  const unavailable=unknownAgentUsage("not-logged-in");
  assert.ok(unavailable.accounts.every(account=>account.remainingPercent===undefined&&account.confidence==="unknown"));
  const stale=presentAgentQuotas(snapshot.accounts,"stale","CLI失败")[0];
  assert.equal(stale.percentage,undefined); assert.equal(stale.usageWindows,undefined); assert.equal(stale.confidence,"unknown"); assert.equal(stale.loginStatus,"unknown"); assert.equal(stale.running,undefined); assert.equal(stale.resetTime,undefined);
});

test("Agent and Ollama providers stop hidden polling and preview data remains explicitly unknown", async () => {
  assert.equal(createAgentUsageProvider().backgroundRefreshIntervalMs,null);
  assert.equal(createOllamaProvider().backgroundRefreshIntervalMs,null);
  const result=await createOllamaProvider().load(new AbortController().signal);
  assert.equal(result.status,"unavailable"); assert.equal(result.data?.snapshot.modelCount,null);
  const html=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],localAI:unavailableLocalAI("服务不可达")}));
  assert.match(html,/data-agent-id="ollama" data-expanded="false"/); assert.doesNotMatch(html,/服务未连接|0 个模型|服务不可达/);
});

test("settings modal exposes all modules but renders only the selected page", () => {
  assert.equal(new Set(settingsModules.map((module) => module.id)).size, settingsModules.length);
  const pages = Object.fromEntries(settingsModules.map((module) => [module.id, `page-content-${module.id}`])) as Record<SettingsModuleId, string>;
  for (const selected of ["appearance", "applications", "beszel", "diagnostics"] as const) {
    const html = renderToStaticMarkup(createElement(SettingsDialog, { selected, pages, onSelect: () => undefined, onClose: () => undefined }));
    assert.match(html, /<dialog[^>]+aria-modal="true"/);
    assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
    for (const module of settingsModules) {
      assert.ok(html.includes(module.label));
      assert.equal(html.includes(`page-content-${module.id}`), module.id === selected);
    }
  }
});

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

test("Phase 1.8 settings load old v1 preferences with additive defaults", () => {
  localStorage.setItem("codex-desktop.settings.v1", JSON.stringify({ theme: "ocean", opacity: 74, animations: false }));
  const loaded = loadSettings();
  assert.equal(loaded.theme, "burgundy");
  assert.equal(loaded.accent, "#c2263f");
  assert.equal(loaded.opacity, 74);
  assert.equal(loaded.animations, false);
  assert.equal(loaded.startupMode, "desktop");
  assert.equal(loaded.wallpaperMode, "auto");
  assert.equal(loaded.simulationEnabled, false);
  saveSettings({ ...defaultSettings, desktopMode: true });
  assert.equal(loadSettings().desktopMode, true);
  assert.equal(loadSettings().glassBorderOpacity,18);
  saveSettings({...defaultSettings,theme:"burgundy",glassBorderOpacity:12,glassShadowStrength:25});
  assert.equal(loadSettings().theme,"burgundy"); assert.equal(loadSettings().glassShadowStrength,25);
});

test("startup defaults and legacy main mode keep the HUD preference without rewriting stored settings", () => {
  for(const mode of [undefined,"desktop","main","unknown"]){
    const stored=JSON.stringify({startupMode:mode,showMainOnStartup:false,showDashboardOnStartup:true,beszelUrl:"https://fixture.test"});
    localStorage.setItem("codex-desktop.settings.v1",stored);
    const loaded=loadSettings();
    assert.equal(loaded.startupMode,"desktop");
    assert.equal(loaded.beszelUrl,"https://fixture.test");
    assert.equal(localStorage.getItem("codex-desktop.settings.v1"),stored);
  }
  for(const mode of ["dashboard","custom"] as const){
    localStorage.setItem("codex-desktop.settings.v1",JSON.stringify({startupMode:mode,showMainOnStartup:false,showDashboardOnStartup:true}));
    const loaded=loadSettings();assert.equal(loaded.startupMode,mode);assert.equal(loaded.showMainOnStartup,false);assert.equal(loaded.showDashboardOnStartup,true);
  }
});

test("HUD background opacity defaults, persists and stays independent from card opacity", () => {
  localStorage.removeItem("codex-desktop.settings.v1");
  assert.equal(loadSettings().hudBackgroundOpacity,88);
  localStorage.setItem("codex-desktop.settings.v1",JSON.stringify({opacity:74}));
  assert.equal(loadSettings().hudBackgroundOpacity,88);
  saveSettings({...defaultSettings,opacity:74,hudBackgroundOpacity:62});
  assert.equal(loadSettings().hudBackgroundOpacity,62);assert.equal(loadSettings().opacity,74);
  saveSettings({...loadSettings(),hudBackgroundOpacity:defaultSettings.hudBackgroundOpacity});
  assert.equal(loadSettings().hudBackgroundOpacity,88);assert.equal(loadSettings().opacity,74);
});
test("HUD background opacity rejects invalid saved values and clamps its range", () => {
  for(const [value,expected] of [[null,88],["70",88],[-1,45],[1000,95],[45,45],[95,95]] as const){
    localStorage.setItem("codex-desktop.settings.v1",JSON.stringify({hudBackgroundOpacity:value}));
    assert.equal(loadSettings().hudBackgroundOpacity,expected);
  }
});
test("legacy themes migrate to burgundy without resetting data connections or preferences", () => {
  for (const theme of ["midnight","graphite","ocean","dark-glass","light-glass","burgundy"]) {
    localStorage.setItem("codex-desktop.settings.v1", JSON.stringify({ theme, accent:"#1234ef", opacity:77, animations:false, beszelUrl:"https://hub.example.test", beszelCredentialRevision:7 }));
    const loaded=loadSettings();
    assert.equal(loaded.theme,"burgundy");assert.equal(loaded.accent,"#c2263f");assert.equal(loaded.opacity,77);assert.equal(loaded.animations,false);assert.equal(loaded.beszelUrl,"https://hub.example.test");assert.equal(loaded.beszelCredentialRevision,7);
  }
});

test("simulation scenarios surface warning and offline states while normal mode simulates usage", async () => {
  const base = await refreshDashboardData(["agent-quotas", "api-balances", "vps-status", "system-health", "notifications"], undefined, false);
  const warning = simulateDashboardData(base, 1, "warning");
  assert.equal(warning.vps.state, "warning");
  assert.equal(warning.vps.name, "LA-VPS · 模拟");
  assert.equal(warning.health.state, "warning");
  assert.match(warning.notices[0].title, /应用崩溃/);
  assert.equal(warning.health.events?.[0].id.startsWith("simulation:"), true);
  assert.deepEqual(await queryHistoryRecords("system_events"), []);

  const failure = simulateDashboardData(base, 1, "error");
  assert.equal(failure.vps.state, "offline");
  assert.equal(failure.health.state, "offline");

  const consumption = simulateDashboardData(base, 4, "normal");
  assert.ok((consumption.providers.find((item) => item.id === "codex")?.percentage ?? 72) < 72);
  assert.ok((consumption.providers.find((item) => item.id === "deepseek")?.balance ?? 38.42) < 38.42);
});

test("history storage supports sorted queries, widget and system-event upserts, pruning, and deletes", async () => {
  const first = { id: "event-1", kind: "provider_history" as const, createdAt: "2026-01-01T00:00:00.000Z", payload: { event: "old" } };
  const second = { id: "event-2", kind: "provider_history" as const, createdAt: "2026-01-02T00:00:00.000Z", payload: { event: "new" } };
  assert.equal(await writeHistoryRecord(first), true);
  assert.equal(await writeHistoryRecord(second), true);
  await writeHistoryRecord({ id: "layout:primary", kind: "widget_state", createdAt: first.createdAt, payload: { version: 1 } });
  await writeHistoryRecord({ id: "layout:primary", kind: "widget_state", createdAt: second.createdAt, payload: { version: 2 } });
  await writeHistoryRecord({ id: "stale-event", kind: "system_events", createdAt: "2026-01-01T00:00:00.000Z", payload: { event: "old" } });
  await writeHistoryRecord({ id: "live-event", kind: "system_events", createdAt: "2026-01-02T00:00:00.000Z", payload: { event: "first" } });
  await writeHistoryRecord({ id: "live-event", kind: "system_events", createdAt: "2026-01-03T00:00:00.000Z", payload: { event: "updated" } });
  assert.deepEqual((await queryHistoryRecords("provider_history")).map((record) => record.id), ["event-2", "event-1"]);
  const layouts = await queryHistoryRecords("widget_state");
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0].payload, { version: 2 });
  const systemEvents = await queryHistoryRecords("system_events");
  assert.equal(systemEvents.length, 2);
  assert.equal((systemEvents.find((record) => record.id === "live-event")?.payload as { event: string }).event, "updated");
  assert.equal(await pruneHistoryRecords("system_events", "2026-01-02T12:00:00.000Z"), 1);
  assert.deepEqual((await queryHistoryRecords("system_events")).map((record) => record.id), ["live-event"]);
  assert.equal(await deleteHistoryRecord("event-1", "provider_history"), true);
  assert.deepEqual((await queryHistoryRecords("provider_history")).map((record) => record.id), ["event-2"]);
});

test("animation manager shares short motion tokens and honors the reduce setting", () => {
  const enabled = createWidgetAnimationManager(true);
  assert.equal(enabled.duration, 180);
  assert.match(enabled.classFor("refresh"), /widget-motion-refresh/);
  assert.match(enabled.classFor("error"), /widget-motion-error/);
  assert.equal(createWidgetAnimationManager(false).classFor("enter"), "");
});

test("named layouts are persisted independently for each monitor", () => {
  const primary = { id: "primary", width: 1920, height: 1080, scaleFactor: 1 };
  const secondary = { id: "secondary", width: 2560, height: 1440, scaleFactor: 1.25 };
  saveNamedLayout("Focus", createDefaultLayout(primary));
  saveNamedLayout("Focus", createDefaultLayout(secondary));
  assert.equal(loadNamedLayouts("primary").length, 1);
  assert.equal(loadNamedLayouts("secondary").length, 1);
  assert.equal(loadNamedLayouts("primary")[0].document.monitorId, "primary");
});

test("fresh Agent metadata with unknown quotas replaces cached verified login facts", async () => {
  const originalTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  try {
    Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
    for (const reason of ["read-failed","not-logged-in"] as const) {
      let clock=Date.now(), calls=0;
      Object.defineProperty(globalThis,"window",{configurable:true,value:{__TAURI_INTERNALS__:{invoke:async(command:string,args:unknown)=>{
        assert.equal(command,"read_agent_usage");assert.deepEqual(args,{consent:true});calls++;
        return {observedAtUnixMs:clock,accounts:[{id:"codex",name:"Codex",state:calls===1?"normal":"unknown",installed:true,running:calls===1,loginStatus:calls===1?"verified":reason==="not-logged-in"?"not-logged-in":"unknown",plan:calls===1?"plus":null,usageType:"subscription",source:"codex-cli",confidence:calls===1?"verified":"unknown",reason:calls===1?"":reason,observedAtUnixMs:clock,ordinaryUsageAllowed:null,windows:calls===1?[{id:"primary",usedPercent:20,windowDurationMins:300,resetsAtUnixMs:null}]:[]}]};
      }}}});
      const cache=new Map<string,string>();
      const runtime=createProviderRuntime({now:()=>clock,cache:{get:key=>cache.get(key),set:(key,value)=>{cache.set(key,value);}}});
      const provider=createAgentUsageProvider(true);
      const verified=await runtime.refresh(provider);
      assert.equal(verified.data?.accounts[0].confidence,"verified");
      clock+=300_001;
      const result=await runtime.refresh(provider);
      assert.equal(calls,2);
      assert.equal(result.status,reason==="read-failed"?"degraded":"normal");
      assert.equal(result.data?.accounts[0].usageWindows?.length,0);
      assert.equal(result.data?.accounts[0].confidence,"unknown");
      assert.equal(result.data?.accounts[0].plan,undefined);
      assert.equal(result.data?.accounts[0].loginStatus,reason==="not-logged-in"?"not-logged-in":"unknown");
    }
  } finally {
    if(originalTauri)Object.defineProperty(globalThis,"isTauri",originalTauri);else Reflect.deleteProperty(globalThis,"isTauri");
    if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else Reflect.deleteProperty(globalThis,"window");
  }
});

test("local Agent usage is off by default with no polling, IPC or history writes",async()=>{
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  let calls=0;
  try{
    Object.defineProperty(globalThis,"window",{configurable:true,value:{__TAURI_INTERNALS__:{invoke:async()=>{calls++;throw Error("must not read")}}}});
    for(const provider of [createAgentUsageProvider(),createAgentUsageProvider(false)]){
      assert.equal(provider.refreshIntervalMs,null);assert.equal(provider.backgroundRefreshIntervalMs,null);
      const result=await provider.load(new AbortController().signal);assert.equal(result.status,"unavailable");assert.equal(result.data?.accounts[0].availabilityReason,"permission-required");
      assert.notEqual(provider.cacheKey,createAgentUsageProvider(true).cacheKey);
    }
    assert.equal(calls,0);
  }finally{if(originalWindow)Object.defineProperty(globalThis,"window",originalWindow);else Reflect.deleteProperty(globalThis,"window");}
});

test("Ollama remote-only and truncated lists do not claim a local model is Ready", () => {
  const snapshot={serviceStatus:"online" as const,source:"http://127.0.0.1:11434",models:[{name:"qwen:cloud",remote:true}],runningModels:[],modelCount:1,truncated:false,observedAtUnixMs:Date.now(),error:null};
  const html=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],localAI:snapshot}));
  assert.match(html,/无本地模型/);assert.doesNotMatch(html,/Ready/);
  const truncated=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],localAI:{...snapshot,modelCount:129,truncated:true}}));
  assert.match(truncated,/本地模型状态未知/);assert.doesNotMatch(truncated,/Ready/);
});
test("AI Control Center keeps running clients aligned and shows an unknown hint without quota data", () => {
  const agents = [
    {id:"codex",name:"Codex",kind:"agent" as const,state:"normal" as const,running:true,confidence:"verified" as const,usageWindows:[{id:"primary",usedPercent:25}]},
    {id:"claude",name:"Claude Code",kind:"agent" as const,state:"unknown" as const,running:false,installed:true,loginStatus:"configured" as const},
    {id:"antigravity",name:"Antigravity",kind:"agent" as const,state:"unknown" as const,running:undefined,installed:true},
    {id:"doubao",name:"豆包",kind:"agent" as const,state:"unknown" as const,running:true},
  ];
  const html=renderToStaticMarkup(createElement(AIControlCenter,{agents,localAI:unavailableLocalAI("offline-detail")}));
  const rows=[...html.matchAll(/<section[^>]*data-agent-id="([^"]+)"[^>]*data-expanded="([^"]+)"[^>]*>(.*?)<\/section>/g)];
  assert.deepEqual(rows.map(row=>[row[1],row[2]]),[["codex","true"],["claude","false"],["antigravity","false"],["ollama","false"],["doubao","true"]]);
  for(const row of rows.filter(row=>row[2]==="false")) assert.doesNotMatch(row[3],/<small|<p|<details|confidence-tag|agent-quota-windows/);
  assert.match(html,/剩余 75%/);
  assert.match(rows.find(row=>row[1]==="doubao")![3],/客户端运行中/);
  const closed=renderToStaticMarkup(createElement(AIControlCenter,{agents:agents.map(agent=>({...agent,running:false}))}));
  assert.equal((closed.match(/data-expanded="false"/g)??[]).length,5);
  assert.doesNotMatch(closed,/剩余 75%/);
  const reopened=renderToStaticMarkup(createElement(AIControlCenter,{agents:agents.map(agent=>({...agent,running:true}))}));
  assert.equal((reopened.match(/data-expanded="true"/g)??[]).length,4);
  const claudeSection=[...reopened.matchAll(/<section[^>]*data-agent-id="claude"[^>]*>(.*?)<\/section>/g)][0]?.[1];
  assert.ok(claudeSection);
  assert.match(claudeSection,/额度暂不可用/);
  assert.doesNotMatch(claudeSection,/Session 额度|Weekly 额度/);
});

test("Ollama expands on API availability even with no loaded models and collapses when unavailable", () => {
  const online={serviceStatus:"online" as const,source:"http://127.0.0.1:11434",models:[],runningModels:[],modelCount:0,truncated:false,observedAtUnixMs:Date.now(),error:null};
  const html=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],localAI:online}));
  assert.match(html,/data-agent-id="ollama" data-expanded="true"/);assert.match(html,/在线 · 0 个模型/);assert.match(html,/无模型/);
  const offline=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],localAI:{...online,serviceStatus:"offline",error:"offline-private-detail"}}));
  assert.match(offline,/data-agent-id="ollama" data-expanded="false"/);assert.doesNotMatch(offline,/在线 ·|offline-private-detail|模型列表/);
});
import { codexQuotaHistoryRecord, codexQuotaRecords, recordCodexQuotaChange } from "../src/services/historyStore";

test("simulated AI cards do not display real quota history", () => {
  const markup=renderToStaticMarkup(createElement(AIControlCenter,{agents:[],simulationEnabled:true}));
  assert.match(markup,/模拟模式 · 不读取真实额度历史/);
  assert.doesNotMatch(markup,/暂无额度历史；取得真实额度后开始记录/);
});


test("AI overview counts only the five real sources, keeping cached and disconnected separate", () => {
  const now=Date.parse("2026-10-13T01:00:00Z");
  const agents=[
    {id:"codex",name:"Codex",kind:"agent" as const,state:"normal" as const,dataState:"Live" as const,confidence:"verified" as const,lastUpdated:new Date(now).toISOString()},
    {id:"claude",name:"Claude",kind:"agent" as const,state:"unknown" as const,loginStatus:"not-logged-in" as const,lastUpdated:""},
    {id:"antigravity",name:"Antigravity",kind:"agent" as const,state:"warning" as const,dataState:"Stale" as const,lastUpdated:""},
    {id:"doubao",name:"豆包",kind:"agent" as const,state:"unknown" as const,running:true,lastUpdated:""},
    {id:"gemini",name:"Gemini",kind:"agent" as const,state:"normal" as const,dataState:"Live" as const,confidence:"verified" as const,lastUpdated:""},
  ];
  const local={serviceStatus:"online" as const,source:"http://127.0.0.1:11434",models:[],runningModels:[],modelCount:0,truncated:false,observedAtUnixMs:now,error:null};
  assert.deepEqual(summarizeAiStatus(agents,local,now),{在线:2,缓存:1,未知:1,未连接:1});
  assert.deepEqual(summarizeAiStatus([],null,now),{在线:0,缓存:0,未知:5,未连接:0});
  assert.deepEqual(summarizeAiStatus(agents,{...local,observedAtUnixMs:now-61000},now),{在线:1,缓存:2,未知:1,未连接:1});
  assert.equal(summarizeAiStatus(agents,{...local,serviceStatus:"offline"},now).未连接,2);
  assert.equal(summarizeAiStatus([{...agents[0],confidence:"estimated"}],null,now).在线,0);
  assert.equal(summarizeAiStatus([{...agents[3],membership:{available:true,cached:true,benefits:[]}}],null,now).缓存,1);
  assert.equal(summarizeAiStatus([], {...local,observedAtUnixMs:now+1},now).未知,5);
});

function quotaAccount(percent:number,stamp="2026-10-13T01:00:00Z") {
  return {id:"codex",name:"Codex",state:"normal" as const,confidence:"verified" as const,source:"codex-cli-official-rpc",observedAt:stamp,
    usageWindows:[{id:"primary",usedPercent:percent,windowDurationMins:300,resetsAt:"2026-10-13T06:00:00Z"},{id:"secondary",usedPercent:14,windowDurationMins:10080,resetsAt:"2026-10-20T01:00:00Z"}]};
}
test("Codex history persists observed percentages only and skips duplicates, unknown, stale and simulated readings", () => {
  const now=Date.parse("2026-10-13T01:05:00Z");
  const first=codexQuotaHistoryRecord(quotaAccount(0),undefined,now)!;
  assert.ok(first); assert.equal(first.payload.windows[0].usedPercent,0);
  assert.equal(codexQuotaHistoryRecord(quotaAccount(0,"2026-10-13T01:05:00Z"),first,now),null);
  const second=codexQuotaHistoryRecord(quotaAccount(10,"2026-10-13T01:05:00Z"),first,now)!;
  assert.equal(second.payload.windows[0].usedPercent,10);
  assert.equal(codexQuotaHistoryRecord(quotaAccount(5),second,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),confidence:"estimated"},undefined,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),confidence:"unknown"},undefined,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),source:"none"},undefined,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),availabilityReason:"read-failed"},undefined,now),null);
  assert.equal(codexQuotaHistoryRecord(quotaAccount(5,"2026-10-13T00:59:59Z"),undefined,now),null);
  assert.equal(codexQuotaHistoryRecord(quotaAccount(5,"2026-10-13T01:05:01Z"),undefined,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),usageWindows:[]},undefined,now),null);
  assert.equal(codexQuotaHistoryRecord({...quotaAccount(5),usageWindows:[{id:"primary",usedPercent:101}]},undefined,now),null);
  assert.doesNotMatch(JSON.stringify(second),/token|cost|email|balance|plan/);
  assert.deepEqual(codexQuotaRecords([first,{...first,payload:{type:"api-usage"}},{...first,payload:{...first.payload,windows:[{id:"bad",usedPercent:NaN}]}}]),[first]);
});

test("Codex history uses the existing repository, recording only changed official snapshots", async () => {
  const records:import("../src/types").HistoryRecord[]=[];
  const store:import("../src/services/historyRepository").HistoryRepository={
    async insert(record){records.push(record);},async query(){return records;},
    async queryRange(){return {records:[],totalCount:0,truncated:false};},async count(){return records.length;},async delete(){},async prune(){return 0;},
  };
  const now=Date.parse("2026-10-13T01:10:00Z");
  await Promise.all([recordCodexQuotaChange([quotaAccount(10,"2026-10-13T01:05:00Z")],store,now),recordCodexQuotaChange([quotaAccount(10,"2026-10-13T01:05:00Z")],store,now)]);
  await recordCodexQuotaChange([quotaAccount(10,"2026-10-13T01:10:00Z")],store,now);
  await recordCodexQuotaChange([quotaAccount(12,"2026-10-13T01:10:00Z")],store,now);
  assert.equal(records.length,2);
  assert.equal(records[0].kind,"provider_history");
  const broken={...store,async query(){throw new Error("storage unavailable");}};
  await assert.rejects(()=>recordCodexQuotaChange([quotaAccount(15,"2026-10-13T01:10:00Z")],broken,now));
  assert.equal(records.length,2);
});

test("Quota trend separates resets and missing windows, fits percentages inside a fixed chart", () => {
  const now=Date.parse("2026-10-13T01:15:00Z");
  const first=codexQuotaHistoryRecord(quotaAccount(10,"2026-10-13T01:10:00Z"),undefined,now)!;
  const second=codexQuotaHistoryRecord(quotaAccount(40,"2026-10-13T01:15:00Z"),first,now)!;
  const third={...second,id:"reset",createdAt:"2026-10-13T06:00:00Z",payload:{...second.payload,windows:second.payload.windows.map(row=>({...row,usedPercent:row.id==="primary"?0:row.usedPercent,resetsAt:row.id==="primary"?"2026-10-13T11:00:00Z":row.resetsAt}))}};
  const series=codexQuotaSeries([first,second,third]);
  assert.equal(series[0].segments.length,2);
  assert.equal(series[0].title,"5 小时额度");
  assert.equal(series[1].title,"周额度");
  const missing={...second,payload:{...second.payload,windows:second.payload.windows.filter(row=>row.id!=="primary")}};
  assert.equal(codexQuotaSeries([first,missing,third])[0].segments.length,2);
  const html=renderToStaticMarkup(createElement(CodexQuotaTrend,{records:[first,second,third]}));
  assert.match(html,/额度使用趋势/);assert.match(html,/账户共享额度/);assert.match(html,/5 小时额度/);assert.match(html,/周额度/);
  assert.doesNotMatch(html,/NaN|Infinity/);
  for(const match of html.matchAll(/points="([^"]+)"/g))for(const point of match[1].split(" ")){const [x,y]=point.split(",").map(Number);assert.ok(x>=28&&x<=308&&y>=16&&y<=116);}
  const empty=renderToStaticMarkup(createElement(CodexQuotaTrend,{records:[]}));
  assert.match(empty,/暂无额度历史/);assert.doesNotMatch(empty,/<svg/);
  const one=renderToStaticMarkup(createElement(CodexQuotaTrend,{records:[first]}));
  assert.match(one,/历史不足/);assert.doesNotMatch(one,/NaN|Infinity/);
  const failed=renderToStaticMarkup(createElement(CodexQuotaTrend,{records:[first],unavailable:true}));
  assert.match(failed,/历史读取失败/);assert.doesNotMatch(failed,/<svg/);
});
