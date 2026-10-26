import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mockIPC,clearMocks} from '@tauri-apps/api/mocks';
import {parsePublicNoaa,noaaState} from '../src/domain/agriculture/publicNoaa';
import {parsePublicInspections,inspectionsState} from '../src/domain/agriculture/publicInspections';
import {parseNassAnnual,parseCropProgress,nassReportState} from '../src/domain/agriculture/publicNass';
import {parsePublicMonthly,parsePublicIbge,monthlySeries,ibgeProducts,referenceState} from '../src/domain/agriculture/publicReferenceData';
import {PublicNoaaObservations} from '../src/components/PublicNoaaObservations';
import {PublicExportInspections} from '../src/components/PublicExportInspections';
import {PublicNassAnnual,PublicCropProgress,PublicMonthlyPrices,PublicIbgeProduction} from '../src/components/PublicAgricultureReference';
import {createPublicNoaaProvider,createPublicInspectionsProvider,createPublicNassAnnualProvider,createPublicCropProgressProvider,createPublicMonthlyProvider,createPublicIbgeProvider,monthlyFailureMessage} from '../src/providers/publicDataProviders';
import {providersFor} from '../src/providers/registry';
import {refreshDashboardData} from '../src/providers/dashboardService';
import {syncSimulationMode} from '../src/services/simulationSafety';
import {emptySnapshotConnection} from '../src/domain/agriculture/contracts';
const at='2026-10-23T03:00:00Z',now=Date.parse(at);
const receipt=(key:string,body:string,extra={})=>({key,body,collectedAt:at,...extra});
const noaaRow=(patch:Record<string,unknown>={})=>({STATION:'USC00118740',DATE:'2026-10-21',PRCP:'0.0',PRCP_ATTRIBUTES:',,S',TMAX:'12.5',TMAX_ATTRIBUTES:',,S',TMIN:'-2.5',TMIN_ATTRIBUTES:',,S',...patch});
const noaa=(rows=[noaaRow()],patch={})=>receipt('noaa-observed',JSON.stringify(rows),{windowStart:'2026-09-23',windowEnd:'2026-10-22',units:'metric',...patch});
// All values below are small synthetic fixtures, never downloaded report rows.
const annualBody=`National Agricultural Statistics Service
Crop Production 2025 Summary
January 2026

Crop Area Planted and Harvested, Yield, and Production in Metric Units - United States:
2024 and 2025 (continued)
Crop : Yield per hectare : Production
: 2024 : 2025 : 2024 : 2025
: metric tons
Corn for grain .......: 2.50 3.25 1,000 2,000
Wheat, all 2/ ........: 2.00 2.50 100 200
Soybeans for beans ...: 1.50 2.00 10 20
`;
const annual=(body=annualBody)=>receipt('nass-annual',body,{sourceUrl:'https://esmis.nal.usda.gov/sites/default/release-files/example/cropan26.txt'});
const progressBody=`Crop Progress
Released October 19, 2026, by the National Agricultural Statistics Service
Corn Harvested - Selected States
[These 2 States harvested 90% of the 2025 corn acreage]
: Week ending :
State : October 18, : October 11, : October 18, : 2021-2025
: 2025 : 2026 : 2026 : Average
: percent
2 States ......: (NA) 0 12 20
Corn Condition - Selected States: Week Ending October 18, 2026
[These 2 States planted 90% of the 2025 corn acreage]
State : Very poor : Poor : Fair : Good : Excellent
: percent
2 States ......: 0 10 20 30 40
Previous week ..: 0 10 30 30 30
Previous year ..: (NA) (NA) (NA) (NA) (NA)
- Represents zero.
`;
const progress=(body=progressBody)=>receipt('crop-progress',body,{sourceUrl:'https://esmis.nal.usda.gov/sites/default/release-files/example/prog4226.txt'});
const monthly=(lines=['2026-08-01,1,2,3,4','2026-09-01,5,6,7,0'])=>receipt('monthly-commodities',['observation_date,'+monthlySeries.map(s=>s.id).join(','),...lines].join('\n'));
const ibgeRow=(id:string,value='100',patch={})=>({NC:'1',D1C:'1',D2C:'35',D2N:'Produção',MC:'1017',MN:'Toneladas',D3C:'202609',D4C:id,V:value,...patch});
const ibge=(rows=ibgeProducts.map(p=>ibgeRow(p.id)))=>receipt('ibge-crops',JSON.stringify([{V:'Valor'},...rows]));
const inspectionBody=`WA_GR101
Washington, DC    Mon   Oct 19, 2026   USDA Market News

GRAINS INSPECTED AND/OR WEIGHED FOR EXPORT
REPORTED IN WEEK ENDING OCT 15, 2026
-- METRIC TONS --
------------------------------------------------
CURRENT     PREVIOUS
----------- WEEK ENDING ----------  MARKET YEAR  MARKET YEAR
GRAIN      10/15/2026  10/08/2026  10/16/2025    TO DATE     TO DATE
CORN 1 2 3 4 5
SOYBEANS 2 3 4 5 6
WHEAT 0 1 2 3 4
Total 9 10 11 12 13
CROP MARKETING YEARS BEGIN JUNE 1 FOR WHEAT
SOYBEANS INSPECTED BY PORT
Total 999 999 999 999 999
`;
const inspections=(body=inspectionBody)=>receipt('usda-inspections',body);

test('NOAA 保留公制小数、负温、真实零与站点独立缺值',()=>{const s=parsePublicNoaa(noaa());assert.equal(s.stations[0].tmaxMean,12.5);assert.equal(s.stations[0].tminMean,-2.5);assert.equal(s.stations[0].precipTotal,0);assert.equal(s.stations[0].precipDays,1);assert.equal(s.stations[1].precipTotal,null);assert.equal(s.stations[1].latestDate,null);});
test('NOAA 微量降水保留来源零及标记',()=>{const s=parsePublicNoaa(noaa([noaaRow({PRCP_ATTRIBUTES:'T,,S'})]));assert.equal(s.stations[0].traceDays,1);assert.equal(s.stations[0].precipTotal,0);});
test('NOAA 剔除质控、推定零、无观测及滞后值',()=>{for(const attributes of [',X,S','P,,S','I,,S','L,,S',',,',null,'']){const s=parsePublicNoaa(noaa([noaaRow({PRCP_ATTRIBUTES:attributes})]));assert.equal(s.stations[0].precipTotal,null);assert.equal(s.stations[0].precipDays,0);}});
test('NOAA 缺值不补零，有效日是平均的分母',()=>{const s=parsePublicNoaa(noaa([noaaRow({TMAX:'10'}),noaaRow({DATE:'2026-10-22',TMAX:'',PRCP:'2'})]));assert.equal(s.stations[0].tmaxDays,1);assert.equal(s.stations[0].tmaxMean,10);assert.equal(s.stations[0].precipTotal,2);});
test('NOAA 高低温冲突不参与平均',()=>{const s=parsePublicNoaa(noaa([noaaRow({TMIN:'20',TMAX:'10'})]));assert.equal(s.stations[0].tmaxMean,null);assert.equal(s.stations[0].tminMean,null);assert.equal(s.stations[0].precipDays,1);});
test('NOAA 缺失代码、负降水和无属性数字不能使用',()=>{for(const value of ['-9999','-999.9','-1','','true']){assert.equal(parsePublicNoaa(noaa([noaaRow({PRCP:value})])).stations[0].precipTotal,null);}});
test('NOAA 请求范围、单位、站点、重复和越界拒绝',()=>{for(const raw of [noaa(undefined,{units:'standard'}),noaa(undefined,{windowStart:'2026-09-22'}),noaa(undefined,{windowEnd:'2026-10-23'}),noaa([noaaRow({STATION:'other'})]),noaa([noaaRow(),noaaRow()]),noaa([noaaRow({DATE:'2026-09-01'})]),noaa([])])assert.throws(()=>parsePublicNoaa(raw));});
test('NOAA 完整性与跨日状态不当作采集成功',()=>{const s=parsePublicNoaa(noaa());assert.equal(noaaState(s,s.stations[0],false,now),'记录不完整');assert.equal(noaaState(s,s.stations[1],false,now),'暂不可用');assert.equal(noaaState(s,s.stations[0],true,now),'数据未更新');assert.equal(noaaState(s,s.stations[0],false,now+86400000),'数据未更新');});
test('NASS 年报用公制全国表，不读英制或正文近似值',()=>{const s=parseNassAnnual(annual());assert.equal(s.year,'2025');assert.equal(s.reportMonth,'2026-01');assert.deepEqual(s.items.map(r=>r.production),[2000,20,200]);assert.equal(s.items[0].previousProduction,1000);assert.equal(s.items[0].yield,3.25);});
test('NASS 年报缺值保留空，不借另一作物',()=>{const s=parseNassAnnual(annual(annualBody.replace('1,000 2,000','1,000 (NA)')));assert.equal(s.items[0].production,null);assert.equal(s.items[1].production,20);});
test('NASS 年报年份、公吨单位、重复行和重复表拒绝',()=>{for(const body of [annualBody.replace('metric tons','bushels'),annualBody.replace('United States:\n2024 and 2025','United States:\n2024 and 2026'),annualBody+'\nCorn for grain .......: 1 2 3 4',annualBody+'\n'+annualBody.slice(annualBody.indexOf('Crop Area Planted'))])assert.throws(()=>parseNassAnnual(annual(body)));});
test('NASS 年报地址和发布时间不匹配拒绝',()=>{for(const sourceUrl of ['https://evil.test/cropan26.txt','https://esmis.nal.usda.gov/sites/default/release-files/example/cropan27.txt','https://esmis.nal.usda.gov/sites/default/release-files/example/../cropan26.txt'])assert.throws(()=>parseNassAnnual({...annual(),sourceUrl}));});
test('NASS 周报按列头本期日期读取，保留选州范围',()=>{const s=parseCropProgress(progress());assert.equal(s.publishedDate,'2026-10-19');assert.equal(s.items[0].date,'2026-10-18');assert.equal(s.items[0].scope,'2州汇总');assert.equal(s.items[0].current,12);assert.equal(s.items[0].previous,0);assert.equal(s.items[0].yearAgo,null);assert.equal(s.items[0].average,20);assert.equal(s.items[0].averagePeriod,'2021-2025');});
test('NASS 优良率来自明确的 Good 与 Excellent，缺年不补',()=>{const s=parseCropProgress(progress());assert.equal(s.items[1].current,70);assert.equal(s.items[1].previous,60);assert.equal(s.items[1].yearAgo,null);assert.equal(s.items[1].average,null);});
test('NASS 横线仅在本报告明确表示零时为零',()=>{const body=progressBody.replace('(NA) 0 12 20','(NA) 0 - 20');assert.equal(parseCropProgress(progress(body)).items[0].current,0);assert.equal(parseCropProgress(progress(body.replace('- Represents zero.',''))).items[0].current,null);});
test('NASS 质控不合计100或超百分比时留空',()=>{const body=progressBody.replace('0 10 20 30 40','0 10 20 30 41');assert.equal(parseCropProgress(progress(body)).items[1].current,null);assert.equal(parseCropProgress(progress(progressBody.replace('(NA) 0 12 20','(NA) 0 101 20'))).items[0].current,null);});
test('NASS 变动比较期、范围或单位不能错列继续',()=>{for(const body of [progressBody.replace('October 11,','October 10,'),progressBody.replace('2021-2025','2020-2025'),progressBody.replace('[These 2 States','[These 3 States'),progressBody.replaceAll('percent','bushels')])assert.throws(()=>parseCropProgress(progress(body)));});
test('NASS 周报不接受错误发布年或重复指标',()=>{assert.throws(()=>parseCropProgress({...progress(),sourceUrl:progress().sourceUrl.replace('4226','4225')}));assert.throws(()=>parseCropProgress(progress(progressBody+'\n'+progressBody.slice(progressBody.indexOf('Corn Harvested')))));});
test('NASS 周/年报时效与缓存失败分开',()=>{assert.equal(nassReportState(at,'2026-10-19',true,false,now),'周报 · 发布时效未确认');assert.equal(nassReportState(at,'2025-01-01',true,false,now),'历史周报');assert.equal(nassReportState(at,'2026-01',false,false,now),'年度报告值 · 发布时效未确认');assert.equal(nassReportState(at,'2026-01',false,true,now),'数据未更新');});
test('月度价格按品种保留月份与美元/美分单位',()=>{const s=parsePublicMonthly(monthly());assert.deepEqual(s.items.map(r=>r.value),[5,6,7,0]);assert.equal(s.items[0].unit,'美元/公吨');assert.equal(s.items[2].unit,'美分/磅');assert.equal(s.items[0].date,'2026-09-01');});
test('月度价格本期缺值不改旧月份，不补零',()=>{const s=parsePublicMonthly(monthly(['2026-08-01,1,2,3,4','2026-09-01,5,,7,8']));assert.equal(s.items[1].date,'2026-08-01');assert.equal(s.items[1].value,2);assert.match(s.items[1].warning!,/本期缺值/);});
test('CSV HTML错误页、错列、日期、重复及坏数值拒绝',()=>{for(const raw of [receipt('monthly-commodities','<!doctype html>'),monthly(['2026-09-01,1,2,3']),monthly(['2026-09-02,1,2,3,4']),monthly(['2026-09-01,1,2,3,4','2026-09-01,2,3,4,5']),monthly(['2026-09-01,true,2,3,4']),monthly(['2026-09-01,,,,'])])assert.throws(()=>parsePublicMonthly(raw));});
test('月价不把读取成功等同当前月价格',()=>{assert.equal(referenceState(at,'2026-09-01',false,now),'月度 · 发布时效未确认');assert.equal(referenceState(at,'2025-01-01',false,now),'历史月份');assert.equal(referenceState(at,'2026-09-01',true,now),'数据未更新');});
test('FRED 区分发送、接收超时和连接失败',()=>{
 assert.match(monthlyFailureMessage('FRED_HTTP_receive_12002','request'),/接收响应超时（12002）/);
 assert.match(monthlyFailureMessage(Error('FRED_HTTP_send_12002'),'request'),/发送请求超时（12002）/);
 assert.match(monthlyFailureMessage('FRED_HTTP_send_12029','request'),/发送请求连接失败（12029）/);
 assert.match(monthlyFailureMessage('FRED_HTTP_receive_12030','request'),/连接中断或 TLS 错误/);
});
test('FRED 区分证书、HTTP状态、编码、大小限制与格式',()=>{
 assert.match(monthlyFailureMessage('FRED_HTTP_receive_12175','request'),/证书校验失败（12175）/);
 assert.match(monthlyFailureMessage('公开来源返回 HTTP 403，暂不可用','request'),/HTTP 403/);
 assert.match(monthlyFailureMessage('公开来源编码无效','request'),/响应编码无效/);
 assert.match(monthlyFailureMessage('接口响应超过 512 KB，请缩小查询范围','request'),/响应超过大小限制/);
 assert.match(monthlyFailureMessage('自定义接口读取超时','request'),/读取超时/);
 assert.match(monthlyFailureMessage(Error('月度价格 CSV 列头变化'),'parse'),/数据格式变化/);
});
test('FRED 未知错误、伪造标记与正文不直接进入界面',()=>{
 for(const value of [Error('token=fixture-secret https://example.test/private'),{message:'fixture-secret'},'FRED_HTTP_receive_12002\nfixture-secret','公开来源返回 HTTP 403，暂不可用 fixture-secret','FRED_HTTP_receive_99999999999']){
  const text=monthlyFailureMessage(value,'request');assert.match(text,/原因未确认/);assert.doesNotMatch(text,/fixture-secret|private|example/);
 }
 assert.doesNotMatch(monthlyFailureMessage(Error('body=fixture-secret'),'parse'),/fixture-secret/);
});
test('FRED 诊断仍保留旧日期说明，不声称修复或已成功',()=>{
 for(const value of ['FRED_HTTP_receive_0','FRED_HTTP_receive_99999','模拟模式已开启，已阻止真实调用；草稿保留']){
  const text=monthlyFailureMessage(value,'request');assert.match(text,/暂不可用，旧结果保留原日期/);assert.doesNotMatch(text,/已成功|已修复/);
 }
});
test('FRED 实际提供器按请求与解析阶段分类且每次只调用一次',async()=>{
 const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldTauri=Object.getOwnPropertyDescriptor(globalThis,'isTauri');
 Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});Object.defineProperty(globalThis,'isTauri',{value:true,configurable:true});
 let answer:unknown,requestError:unknown,calls=0;
 mockIPC((command)=>{if(command==='set_simulation_mode')return null;if(command==='read_builtin_public_source'){calls++;if(requestError)throw requestError;return answer;}throw Error('unexpected command');});
 try{
  await syncSimulationMode(false);
  for(const [error,pattern] of [['FRED_HTTP_receive_12002',/接收响应超时/],['公开来源返回 HTTP 503，暂不可用',/HTTP 503/],['private fixture-secret',/原因未确认/]] as const){
   requestError=error;calls=0;const result=await createPublicMonthlyProvider(true,"fred").load(new AbortController().signal);assert.equal(result.status,'error');assert.equal(result.data,null);assert.equal(result.retryable,false);assert.match(result.error!,pattern);assert.equal(calls,1);assert.doesNotMatch(result.error!,/fixture-secret/);
  }
  requestError=null;answer=receipt('monthly-commodities','<!doctype html>fixture-secret');calls=0;
  const malformed=await createPublicMonthlyProvider(true,"fred").load(new AbortController().signal);assert.match(malformed.error!,/数据格式变化/);assert.equal(calls,1);assert.doesNotMatch(malformed.error!,/fixture-secret/);
  answer=monthly();calls=0;const good=await createPublicMonthlyProvider(true,"fred").load(new AbortController().signal);assert.equal(good.status,'normal');assert.equal(good.error,undefined);assert.equal(good.data?.snapshot.items[0].value,5);assert.equal(calls,1);
  calls=0;await createPublicMonthlyProvider(false).load(new AbortController().signal);assert.equal(calls,0);
 }finally{await syncSimulationMode(false);clearMocks();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');if(oldTauri)Object.defineProperty(globalThis,'isTauri',oldTauri);else Reflect.deleteProperty(globalThis,'isTauri');}
});
test('IBGE 分季玉米与来源合计保持独立，不自行加总',()=>{const s=parsePublicIbge(ibge());assert.equal(s.month,'2026-09');assert.equal(s.items.length,5);assert.equal(s.items[1].name,'玉米（一季）');assert.equal(s.items[2].name,'玉米（二季）');assert.equal(s.items[0].value,100);});
test('IBGE 缺值不补零，真实零保留',()=>{const rows=ibgeProducts.map(p=>ibgeRow(p.id,p.id==='39441'?'..':p.id==='39442'?'0':'100'));const s=parsePublicIbge(ibge(rows));assert.equal(s.items[1].value,null);assert.equal(s.items[2].value,0);});
test('IBGE 全国范围、吨单位、变量和时期必须一致',()=>{for(const patch of [{D1C:'2'},{NC:'2'},{MC:'999'},{MN:'kg'},{D2C:'99'},{D3C:'299901'}])assert.throws(()=>parsePublicIbge(ibge([ibgeRow('39443','10',patch)])));});
test('IBGE 多月份与同品种重复不得拼接',()=>{assert.throws(()=>parsePublicIbge(ibge([ibgeRow('39443'),ibgeRow('39443')])));assert.throws(()=>parsePublicIbge(ibge([ibgeRow('39443'),ibgeRow('39441','100',{D3C:'202608'})])));});
test('出口检验只读首张全美表，合计不以三品种代替',()=>{const s=parsePublicInspections(inspections());assert.equal(s.items[3].current,9);assert.equal(s.items[2].current,0);assert.equal(s.items[0].current,1);assert.equal(s.weekEnding,'2026-10-15');assert.equal(s.publishedDate,'2026-10-19');});
test('出口检验错误编号、单位、错列和重复不能继续',()=>{for(const body of [inspectionBody.replace('WA_GR101','WA_OTHER'),inspectionBody.replace('METRIC TONS','BUSHELS'),inspectionBody.replace('CORN 1 2 3 4 5','CORN 1 2 3 4'),inspectionBody.replace('WHEAT 0 1 2 3 4','CORN 0 1 2 3 4'),inspectionBody.replace('10/08/2026','10/07/2026')])assert.throws(()=>parsePublicInspections(inspections(body)));});
test('出口检验缺品种不借后续港口表或补零',()=>{const s=parsePublicInspections(inspections(inspectionBody.replace('SOYBEANS 2 3 4 5 6\n','')));assert.equal(s.items[1].current,null);assert.equal(s.items[3].current,9);assert.equal(inspectionsState(s,true,now),'数据未更新');});
test('所有新来源拒绝伪造时间、错误来源及超大响应',()=>{for(const [parse,raw] of [[parsePublicNoaa,noaa()],[parseNassAnnual,annual()],[parseCropProgress,progress()],[parsePublicMonthly,monthly()],[parsePublicIbge,ibge()],[parsePublicInspections,inspections()]] as const){for(const patch of [{key:'wrong'},{collectedAt:'2026-02-30T00:00:00Z'},{collectedAt:'2999-01-01T00:00:00Z'},{body:'x'.repeat(1024*1024+1)}])assert.throws(()=>parse({...raw,...patch}));}});
test('新卡片保留来源、周期、缺值和错误，不冒充期货或预报',()=>{const rendered=[renderToStaticMarkup(createElement(PublicNoaaObservations,{snapshot:parsePublicNoaa(noaa()),error:'断网'})),renderToStaticMarkup(createElement(PublicNassAnnual,{snapshot:parseNassAnnual(annual())})),renderToStaticMarkup(createElement(PublicCropProgress,{snapshot:parseCropProgress(progress())})),renderToStaticMarkup(createElement(PublicMonthlyPrices,{snapshot:parsePublicMonthly(monthly())})),renderToStaticMarkup(createElement(PublicIbgeProduction,{snapshot:parsePublicIbge(ibge())})),renderToStaticMarkup(createElement(PublicExportInspections,{snapshot:parsePublicInspections(inspections())}))];for(const text of rendered)assert.match(text,/来源与日期/);assert.match(rendered[0],/数据未更新/);assert.match(rendered[1],/公吨/);assert.match(rendered[2],/2州汇总/);assert.match(rendered[3],/不是交易所实时价格/);assert.match(rendered[4],/自然年/);assert.match(rendered[5],/不是海湾/);});
test('默认开关、无后台和无重试与模拟排除均一致',()=>{const ids=['public-noaa','public-nass-annual','public-crop-progress','public-monthly','public-ibge','public-inspections'];for(const key of ['noaaEnabled','nassAnnualEnabled','cropProgressEnabled','monthlyEnabled','ibgeEnabled','inspectionsEnabled'] as const)assert.equal(emptySnapshotConnection[key],true);for(const p of providersFor(ids)){assert.equal(p.backgroundRefreshIntervalMs,null);assert.equal(p.retryPolicy?.maxRetries,0);}assert.equal(providersFor(ids,undefined,{includeDemoProviders:true}).length,0);});
test('关闭、模拟、配置失败均零真实来源读取，普通失败只调用一次',async()=>{const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldTauri=Object.getOwnPropertyDescriptor(globalThis,'isTauri');Object.defineProperty(globalThis,'window',{value:globalThis,configurable:true});Object.defineProperty(globalThis,'isTauri',{value:true,configurable:true});const calls:string[]=[];let badConfig=false;mockIPC((command,args)=>{calls.push(command);if(command==='set_simulation_mode'||command==='notification_apply')return null;if(command==='load_snapshot_connection'){if(badConfig)throw 'bad config';return {...emptySnapshotConnection};}throw Error('offline');});try{const factories=[createPublicNoaaProvider,createPublicInspectionsProvider,createPublicNassAnnualProvider,createPublicCropProgressProvider,createPublicMonthlyProvider,createPublicIbgeProvider];for(const make of factories)assert.equal((await make(false).load(new AbortController().signal)).status,'unavailable');assert.equal(calls.length,0);await syncSimulationMode(true);for(const make of factories)assert.equal((await make().load(new AbortController().signal)).status,'error');assert.equal(calls.filter(c=>c==='read_builtin_public_source').length,0);await syncSimulationMode(false);calls.length=0;for(const make of factories)assert.equal((await make().load(new AbortController().signal)).status,'error');assert.equal(calls.filter(c=>c==='read_builtin_public_source').length,6);calls.length=0;badConfig=true;await refreshDashboardData(['public-noaa','public-nass-annual','public-crop-progress','public-monthly','public-ibge','public-inspections'],{url:'',systemId:'',refreshIntervalSeconds:300});assert.equal(calls.filter(c=>c==='read_builtin_public_source').length,0);}finally{await syncSimulationMode(false);clearMocks();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');if(oldTauri)Object.defineProperty(globalThis,'isTauri',oldTauri);else Reflect.deleteProperty(globalThis,'isTauri');}});
