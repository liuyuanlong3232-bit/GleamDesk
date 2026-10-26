import test from "node:test";
import assert from "node:assert/strict";
import {observationFromNative} from "../src/providers/server/beszelProvider";
import {presentVps,formatVpsLocation} from "../src/presentation/vpsAdapter";
import {emptyDashboardData} from "../src/providers/dashboardAdapter";
import {WidgetCard} from "../src/widgets/WidgetCard";
import {renderToStaticMarkup} from "react-dom/server";
import {createElement} from "react";
import {readFileSync} from "node:fs";

test("被监控服务器地址贯穿数据层，不能用Hub地址代替",()=>{
 const value=observationFromNative({host:"1.1.1.1",name:"Japan VPS",serverId:"one",state:"online",sampledAtUnixMs:Date.now(),fetchedAtUnixMs:Date.now(),uptimeSeconds:1,latencyMs:1,cpuPercent:1,memoryPercent:1,diskPercent:1,network:{},services:[]});
 assert.equal(value.host,"1.1.1.1");assert.equal(presentVps(value,"normal").host,"1.1.1.1");
});

test("中英文国家和城市按来源显示，缺项不猜、不填别处地名",()=>{
 const value={ip:"1.1.1.1",countryZh:"日本",countryEn:"Japan",cityZh:"东京",cityEn:"Tokyo",lookedUpAtUnixMs:Date.now(),source:"ipwho.is" as const};
 assert.deepEqual(formatVpsLocation(value),{country:"日本 / Japan",city:"东京 / Tokyo"});
 assert.deepEqual(formatVpsLocation({...value,countryZh:null,cityZh:null,cityEn:null}),{country:"未知 / Japan",city:"未知 / Unknown"});
 assert.equal(formatVpsLocation({...value,cityZh:"Tokyo"}).city,"未知 / Tokyo");
});

test("模拟模式的VPS面板明确暂停所在地查询",()=>{
 const data=emptyDashboardData();data.vps.host="1.1.1.1";
 const markup=renderToStaticMarkup(createElement(WidgetCard,{id:"vps",data,vpsConsole:true,simulationEnabled:true}));
 assert.match(markup,/模拟模式 · 查询暂停/);
 const backend=readFileSync("src-tauri/src/beszel.rs","utf8");const command=backend.slice(backend.indexOf("pub async fn read_vps_location("));
 assert.match(command.slice(0,command.indexOf("spawn_blocking")),/simulation::require_live/);
 assert.match(readFileSync("src/widgets/WidgetCard.tsx","utf8"),/invokeLive<VpsLocation>\("read_vps_location"/);
});
test("VPS控制台有所在地未知状态，不能按机器名称猜国家",()=>{
 const data=emptyDashboardData();data.vps.name="Japan VPS";data.vps.host="1.1.1.1";
 const markup=renderToStaticMarkup(createElement(WidgetCard,{id:"vps",data,vpsConsole:true}));
 assert.match(markup,/IP 所在地/);assert.match(markup,/1\.1\.1\.1/);assert.doesNotMatch(markup,/日本|Japan \/|东京/);
});
