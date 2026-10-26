import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {readFileSync} from "node:fs";
import {presentApiUsage,apiMoneyView,apiHudSummary} from "../src/presentation/quotaAdapter";
import {normalizeApiSnapshot} from "../src/providers/api/apiUsageProvider";
import {emptyDashboardData} from "../src/providers/dashboardAdapter";
import {WidgetCard} from "../src/widgets/WidgetCard";
import {ApiMoneyDetails} from "../src/components/ApiMoneyDetails";
import {WorkbenchOverview} from "../src/components/WorkbenchOverview";
import {mergeDashboardData} from "../src/providers/dashboardAdapter";
const at=new Date().toISOString();
const balance={id:"deepseek",name:"DeepSeek",state:"normal" as const,currency:"USD",balance:5,sourceUrl:"https://api.deepseek.com/user/balance",observedAt:at};
const markup=(rows:ReturnType<typeof presentApiUsage>)=>{const data=emptyDashboardData();data.providers=rows;return renderToStaticMarkup(createElement(WidgetCard,{id:"api",data}))};
const homeMarkup=(rows:ReturnType<typeof presentApiUsage>)=>{const data=emptyDashboardData();data.providers=rows;return renderToStaticMarkup(createElement(WorkbenchOverview,{data,vpsInterval:30,onNotifications:()=>{},onRoom:()=>{},onConnections:()=>{}}))};
test("首页信息流也明确余额与币种，不虚列余额账户的日月费用",()=>{
 const html=homeMarkup(presentApiUsage([balance],"normal"));assert.match(html,/>账户余额</);assert.match(html,/5\.00 USD/);assert.doesNotMatch(html,/今日 未知/);
});
test("首页信息流不把过期余额当当前金额，旧值只能出现在历史详情",()=>{
 const html=homeMarkup(presentApiUsage([balance],"stale","读取失败"));assert.doesNotMatch(html,/<strong[^>]*>[^<]*5\.00/);assert.match(html,/上次记录（非当前）/);assert.match(html,/数据已过期/);
});
test("余额主数字旁有口径和币种，不给DeepSeek编出今日费用",()=>{
 const html=markup(presentApiUsage([balance],"normal"));assert.match(html,/>账户余额</);assert.match(html,/USD/);assert.doesNotMatch(html,/今日 未知/);
});
test("过期金额不作为当前大数字，旧值只保留在明确标记的历史详情",()=>{
 const html=markup(presentApiUsage([balance],"stale","读取失败"));assert.doesNotMatch(html,/<strong>[^<]*5\.00/);assert.match(html,/过期|未更新/);assert.match(html,/上次记录/);
});
test("MiMo推荐估算保留独立口径和日月统计区间",()=>{
 const source={id:"mimo-estimate",name:"MiMo",amountScope:"local-estimate" as const,state:"normal" as const,currency:"CNY",balance:null,todayCost:0,monthCost:1,observedAt:at,sourceUrl:"local:mimo-recommendation-ledger",periodStart:"2026-10-01T00:00:00+08:00",periodEnd:at,todayPeriodStart:"2026-10-19T00:00:00+08:00",todayPeriodEnd:at};
 const value=normalizeApiSnapshot({observedAt:at,accounts:[source]}).accounts[0];const row=presentApiUsage([value],"normal")[0];
 assert.equal(row.apiAmountScope,"local-estimate");assert.equal(row.todayPeriodStart,source.todayPeriodStart);assert.equal(row.todayPeriodEnd,at);
});
test("无效金额保持未知，不把字符串NaN或无穷当作钱",()=>{
 const result=normalizeApiSnapshot({observedAt:at,accounts:[{...balance,balance:NaN,todayCost:Infinity,monthCost:"5" as any,periodStart:null,periodEnd:null}]}).accounts[0];
 assert.equal(result.balance,undefined);assert.equal(result.todayCost,undefined);assert.equal(result.monthCost,undefined);
});
test("主屏不再自动选一家金额充当API总额",()=>{const code=readFileSync("src/App.tsx","utf8");assert.doesNotMatch(code,/const apiStatus = apiProviders\.find/);assert.match(code,/API 账户/)});

const now=Date.parse("2026-10-19T04:30:00Z");
const liveBalance=(patch:Partial<typeof balance>={})=>presentApiUsage([{...balance,observedAt:new Date(now).toISOString(),...patch}],"normal")[0];
const organization=(patch:Record<string,unknown>={})=>presentApiUsage([{id:"openai",name:"OpenAI API",state:"normal",currency:"USD",monthCost:1.5,todayCost:0.1,observedAt:new Date(now).toISOString(),sourceUrl:"https://api.openai.com/v1/organization/costs",periodStart:"2026-10-01T00:00:00Z",periodEnd:"2026-10-20T00:00:00Z",todayPeriodStart:"2026-10-19T00:00:00Z",todayPeriodEnd:"2026-10-20T00:00:00Z",...patch} as any],"normal")[0];
test("时间经过会自动遮住旧金额，真实0值在有效期内仍显示",()=>{
 const row=liveBalance({balance:0});assert.match(apiMoneyView(row,now).primary,/0\.00 USD/);
 assert.equal(apiMoneyView(row,now+300001).primary,"未知");assert.match(apiMoneyView(row,now+300001).note,/过期/);
 const missing={...row,balance:undefined};assert.equal(apiMoneyView(missing,now).primary,"未知");
});
test("不同币种和不同口径不相加，MiMo余额和估算不重复算账户",()=>{
 const rows=[{...liveBalance(),id:"deepseek-usd"},{...liveBalance({currency:"CNY",balance:20}),id:"deepseek-cny"},{...liveBalance(),id:"mimo"},{...organization(),id:"mimo-estimate",apiAmountScope:"local-estimate" as const,currency:"CNY",apiPeriodTimeZone:"Asia/Shanghai" as const,periodStart:"2026-10-01T00:00:00+08:00",periodEnd:new Date(now).toISOString(),todayPeriodStart:"2026-10-19T00:00:00+08:00",todayPeriodEnd:new Date(now).toISOString()}];
 assert.equal(apiHudSummary(rows,now).value,"2 个已读取");assert.match(apiMoneyView(rows[0],now).primary,/USD/);assert.match(apiMoneyView(rows[1],now).primary,/CNY/);
});
test("组织费用有UTC日月区间，余额不会拿费用填",()=>{
 const row=organization();const view=apiMoneyView(row,now);assert.equal(view.label,"组织费用 · 本月");assert.match(view.primary,/1\.50 USD/);assert.match(view.today,/0\.10 USD/);assert.match(view.period,/UTC/);
 const html=renderToStaticMarkup(createElement(ApiMoneyDetails,{api:row,now}));assert.doesNotMatch(html,/>账户余额</);assert.match(html,/2026-10-01/);assert.match(html,/读取于/);
});
test("跨UTC日月后旧报告不能叫做新一天或新月份的费用",()=>{
 const row=organization({observedAt:"2026-10-31T23:59:00Z",periodEnd:"2026-11-01T00:00:00Z",todayPeriodStart:"2026-10-31T00:00:00Z",todayPeriodEnd:"2026-11-01T00:00:00Z"});
 const view=apiMoneyView(row,Date.parse("2026-11-01T00:01:00Z"));assert.equal(view.primary,"未知");assert.equal(view.today,"未知");assert.equal(view.showPrevious,true);
 const yesterday=organization({observedAt:"2026-10-19T23:59:00Z",periodEnd:"2026-10-20T00:00:00Z"});assert.equal(apiMoneyView(yesterday,Date.parse("2026-10-20T00:01:00Z")).today,"未知");
});
test("北京时间的本机估算不借UTC日期，空区间和未来时间保持未知",()=>{
 const t=Date.parse("2026-10-18T16:30:00Z");
 const row={...organization(),apiAmountScope:"local-estimate" as const,currency:"CNY",apiPeriodTimeZone:"Asia/Shanghai" as const,lastUpdated:new Date(t).toISOString(),periodStart:"2026-10-01T00:00:00+08:00",periodEnd:new Date(t).toISOString(),todayPeriodStart:"2026-10-19T00:00:00+08:00",todayPeriodEnd:new Date(t).toISOString(),todayCost:0};
 assert.match(apiMoneyView(row,t).today,/0\.00 CNY/);assert.match(apiMoneyView(row,t).period,/北京时间/);
 assert.equal(apiMoneyView({...row,lastUpdated:new Date(t+60000).toISOString()},t).primary,"未知");
 assert.equal(apiMoneyView({...row,periodStart:undefined,todayPeriodStart:undefined},t).primary,"未知");
 assert.equal(apiMoneyView({...row,apiPeriodTimeZone:undefined},t).today,"未知");
});
test("MiMo断开、失败和恢复时替换整组行，旧估算不会残留",()=>{
 const initial=emptyDashboardData();initial.providers=[{...liveBalance(),id:"mimo"},{...organization(),id:"mimo-estimate"}];
 const update=emptyDashboardData();update.providerDiagnostics=[{providerId:"api-mimo",name:"MiMo",status:"unavailable",lastUpdated:null,lastSuccessAt:null}];update.providers=[{id:"mimo",name:"MiMo",kind:"api",state:"unknown",lastUpdated:""}];
 assert.deepEqual(mergeDashboardData(initial,update).providers.map(row=>row.id),["mimo"]);
 assert.equal(initial.providers.length,2);
});
test("未知币种和无时区时间不包装成当前金额，警告也不会显示正常汇总",()=>{
 assert.equal(apiMoneyView({...liveBalance(),currency:undefined},now).primary,"未知");
 assert.equal(apiMoneyView({...liveBalance(),lastUpdated:"2026-10-19 04:30:00"},now).primary,"未知");
 assert.equal(apiHudSummary([{...liveBalance(),state:"warning"}],now).state,"warning");
 const code=readFileSync("src/components/ApiMoneyDetails.tsx","utf8");assert.doesNotMatch(code,/invoke\(|readApiUsage|refreshDashboardData/);
});
