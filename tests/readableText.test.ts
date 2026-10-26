import assert from "node:assert/strict";
import {test} from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {metricState, PcOverview, PcGpu, PcTrends} from "../src/widgets/ResourcePanels";
import {emptyDashboardData} from "../src/providers/dashboardAdapter";
import {DailyOpenSourceView, beijingDate} from "../src/components/DailyOpenSource";
import {defaultSettings} from "../src/providers/settingsStore";

test("resource states use distinct Chinese labels without guessing an unknown state",()=>{
  for(const [state,label] of Object.entries({available:"可用",sampling:"采样中",unsupported:"不支持",unavailable:"暂不可用"})){
    assert.equal(metricState(state),label);
  }
  for(const state of [undefined,"","future-state"])assert.equal(metricState(state),"未知");
});

test("resource rendering keeps missing values empty and preserves raw readings and statuses",()=>{
  const data=emptyDashboardData();
  data.hardware={sampledAtUnixMs:Date.now(),cpu:{usagePercent:42,usageStatus:"available",temperatureC:null,temperatureStatus:"unsupported"},memory:{usedBytes:null,totalBytes:null,usagePercent:null,status:"unavailable"},disks:{volumes:[],status:"unavailable"},network:{uploadBytesPerSecond:null,downloadBytesPerSecond:null,status:"sampling"},gpu:{name:null,usagePercent:null,memoryUsedBytes:null,memoryTotalBytes:null,temperatureC:null,status:"unsupported"}};
  const before=JSON.stringify(data);
  const html=renderToStaticMarkup(createElement(PcOverview,{data}))+renderToStaticMarkup(createElement(PcGpu,{data}));
  for(const text of ["42%","—","可用","暂不可用","采样中","不支持"])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/\b(Live|Unavailable|Unknown)\b/);
  assert.equal(JSON.stringify(data),before);
});

test("resource simulation remains visibly separate from real history",()=>{
  const html=renderToStaticMarkup(createElement(PcTrends,{data:emptyDashboardData(),simulationEnabled:true}));
  assert.match(html,/模拟模式 · 真实历史暂停/);
  assert.doesNotMatch(html,/<svg|Simulation/);
});

test("recommendation typography retains dates, source originals and paid generation controls",()=>{
  let calls=0;const never=()=>{calls++};
  const snapshot={schemaVersion:1 as const,source:"GitHub Trending" as const,date:beijingDate(),collectedAt:new Date().toISOString(),items:[{repo:"example/long-project-name",url:"https://github.com/example/long-project-name",description:"Source text",introZh:"中文介绍",language:"TypeScript",stars:"100",todayStars:"5"}],translationStatus:"pending",status:"ok"};
  for(const presentation of ["card","hud"] as const){
    const html=renderToStaticMarkup(createElement(DailyOpenSourceView,{connections:defaultSettings.apiConnections,snapshot,presentation,busy:false,error:"",onRefresh:never,onGenerate:never,onOpen:never}));
    for(const text of [snapshot.date,"中文介绍","Source text","查看原文","付费，每日 1 次"])assert.ok(html.includes(text),text);
  }
  assert.equal(calls,0);
});
test("API settings start collapsed and keep billing permissions, consent and status messages",async()=>{
 const React=await import("react"),{renderToStaticMarkup}=await import("react-dom/server"),{ApiConnectionsSettings}=await import("../src/components/ApiConnectionsSettings");
 const markup=renderToStaticMarkup(React.createElement(ApiConnectionsSettings,{connections:{deepseekEnabled:false,anthropicEnabled:false,openaiEnabled:false,mimoEnabled:false,mimoDailyAuto:false,credentialRevision:0},onChange:()=>{}}));
 assert.equal((markup.match(/class="api-connection connection-card"/g)||[]).length,4);
 assert.doesNotMatch(markup,/<details class="api-connection connection-card" open/);
 for(const text of ["帮助与数据范围","组织费用","普通聊天密钥不适用","付费","允许每天自动生成","读取验证","Windows 凭据管理器"])assert.ok(markup.includes(text),text);
 assert.match(markup,/settings-help/);
});

test("startup settings expose real controls and keep inactive Windows preferences out of the form",async()=>{
 const {readFileSync}=await import("node:fs");const source=readFileSync("src/App.tsx","utf8");
 const section=source.split('desktop: (<div className="settings-section">')[1].split('simulation:')[0];
 assert.match(section,/Dock 和顶部 HUD（默认）/);assert.doesNotMatch(section,/双屏时打开控制台/);
 assert.match(section,/高级与帮助/);assert.match(section,/Ctrl \+ Shift \+ Space/);
 assert.doesNotMatch(section,/checked=\{settings.autoStart\}|value=\{settings.desktopSurfaceMode\}/);
 assert.match(section,/暂未支持/);
});
