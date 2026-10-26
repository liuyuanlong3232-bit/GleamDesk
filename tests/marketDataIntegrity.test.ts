import {readFileSync} from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {agriculturePresentation,type AgricultureEnvelope} from "../src/domain/agriculture/contracts";
import {formatMarketTime,marketQuotes,splitContractPrices,tradingDate} from "../src/domain/agriculture/marketQuotes";
import {priceHistory} from "../src/components/ResearchPanels";
import {WorkbenchOverview} from "../src/components/WorkbenchOverview";
import {NewsWorkspace} from "../src/components/NewsWorkspace";
import {emptyDashboardData} from "../src/providers/dashboardAdapter";

const now=Date.parse("2026-10-16T08:00:00Z");
const envelope=():AgricultureEnvelope=>({schemaVersion:1,origin:"ssh:vps:203.0.113.10",fetchedAt:"2026-10-16T08:00:00Z",snapshots:{}});
const daily=(price:number,collectedDate:string,sourceDate="2026-10-15",symbol="SI=F")=>({name:"COMEX 银",symbol,price,sourceDate,collectedDate,changePct:price-100});
const future=(symbol:string,price:number,collectedDate:string,sourceDate="2026-10-15")=>({name:"玉米",symbol,price,collectedDate,sourceDate,changePct:1,previousClose:price-1,source:"Tushare",unit:"元/吨"});
const snapshot=(data:AgricultureEnvelope,prices:Record<string,unknown>[],generated="2026-10-16T08:30:00+08:00")=>{
  data.snapshots.global_snapshot={path:"fixture",fileModifiedAt:data.fetchedAt,payload:{generated_at_bjt:generated,prices}};
};

test("同交易日旧快照不得覆盖新数据库行情，价格和涨跌幅一起选取",()=>{
  const data=envelope(); data.market=[{symbol:"SI=F",history:[daily(100,"2026-10-16T10:00:00+08:00")]}];
  data.history=[{generatedAt:"2026-10-16T09:00:00+08:00",prices:[{symbol:"SI=F",quote_date:"2026-10-15",price:90,change_pct:-10}]}];
  snapshot(data,[{symbol:"SI=F",commodity:"COMEX 银",quote_date:"2026-10-15",price:80,change_pct:-20}]);
  const before=JSON.stringify(data),quote=marketQuotes(data).get("SI=F")![0];
  assert.equal(quote.value,100);assert.equal(quote.dayChange,0);assert.equal(quote.collectedAt,"2026-10-16T10:00:00+08:00");
  assert.equal(JSON.stringify(data),before);
});

test("确实更新的快照能覆盖旧数据库记录，缺涨跌幅不得借上一条",()=>{
  const data=envelope();data.market=[{symbol:"SI=F",history:[daily(90,"2026-10-16T08:00:00+08:00")]}];
  snapshot(data,[{symbol:"SI=F",commodity:"COMEX 银",quote_date:"2026-10-15",price:100}],"2026-10-16T10:00:00+08:00");
  const quote=marketQuotes(data).get("SI=F")![0];
  assert.equal(quote.value,100);assert.equal(quote.dayChange,null);assert.equal(quote.sourceDate,"2026-10-15");
  assert.equal(quote.collectedAt,"2026-10-16T10:00:00+08:00");assert.match(quote.source,/全球行情快照/);
  assert.equal(agriculturePresentation(data,now).prices[0].change,null);
});

test("不同品种、不同真实交易日独立保留，不因为旧交易日较晚采集而混行",()=>{
  const data=envelope();data.market=[{symbol:"SI=F",history:[daily(100,"2026-10-16T08:00:00+08:00")]},{symbol:"GC=F",history:[daily(200,"2026-10-16T08:00:00+08:00","2026-10-15","GC=F")]}];
  snapshot(data,[{symbol:"SI=F",quote_date:"2026-10-14",price:90}],"2026-10-16T10:00:00+08:00");
  const quotes=marketQuotes(data);assert.equal(quotes.get("SI=F")!.length,2);
  assert.equal(quotes.get("SI=F")!.at(-1)!.value,100);assert.equal(quotes.get("GC=F")!.at(-1)!.value,200);
});

test("已知采集时间不被未知或无效时间覆盖，相同时间保留数据库记录",()=>{
  for(const generated of ["", "invalid", "2026-10-16T10:00:00+08:00"]) {
    const data=envelope(); data.market=[{symbol:"SI=F",history:[daily(100,"2026-10-16T10:00:00+08:00")]}];
    snapshot(data,[{symbol:"SI=F",quote_date:"2026-10-15",price:90}],generated);
    assert.equal(marketQuotes(data).get("SI=F")![0].value,100);
  }
});

test("同一来源的重复日线也按采集时间选择，与数组顺序无关",()=>{
  const older=daily(90,"2026-10-16T01:00:00Z"),newer=daily(100,"2026-10-16T10:00:00+08:00");
  for(const history of [[newer,older],[older,newer]]) {
    const data=envelope();data.market=[{symbol:"SI=F",history}];
    assert.equal(marketQuotes(data).get("SI=F")![0].value,100);
  }
});

test("无时区的 VPS 采集时间按北京时间比较，只有采集日期时不猜同日先后",()=>{
  for(const collected of ["2026-10-16 10:00:00","2026-10-16T10:00:00","2026-10-16"]) {
    const data=envelope();data.market=[{symbol:"SI=F",history:[daily(100,collected)]}];
    snapshot(data,[{symbol:"SI=F",quote_date:"2026-10-15",price:90}],"2026-10-16T01:00:00Z");
    assert.equal(marketQuotes(data).get("SI=F")![0].value,100);
  }
  assert.equal(formatMarketTime("2026-10-16T10:00:00"),"2026-10-16 10:00:00");
  assert.equal(tradingDate("20260230"),null);assert.equal(tradingDate("2026-02-30"),null);
  assert.equal(tradingDate("20261015"),"2026-10-15");
});

test("农业卡片和历史曲线采用同一条较新的真实日线",()=>{
  const data=envelope(),day=new Date().toISOString().slice(0,10);
  data.market=[{symbol:"SI=F",history:[daily(100,"2026-10-16T10:00:00+08:00",day)]}];
  snapshot(data,[{symbol:"SI=F",commodity:"COMEX 银",quote_date:day,price:90,change_pct:-10}]);
  assert.equal(agriculturePresentation(data,now).prices[0].price,100);
  assert.equal(agriculturePresentation(data,now).prices[0].change,0);
  assert.equal(priceHistory(data,"SI=F")[0].value,100);
});

test("国内备用快照缺价格保持空，缺日期不借用整个快照的交易日",()=>{
  const data=envelope();data.snapshots.china_snapshot={path:"fixture",fileModifiedAt:data.fetchedAt,payload:{futures_as_of_trade_date:"2026-10-15",futures:[{symbol:"C2611.DCE",name:"玉米"},{symbol:"A2611.DCE",name:"大豆",close:5000,trade_date:"20261014"}]}};
  const rows=agriculturePresentation(data,now).prices;
  assert.equal(rows[0].price,null);assert.equal(rows[0].date,null);assert.equal(rows[0].status,"Unknown");
  assert.equal(rows[1].price,5000);assert.equal(rows[1].date,"2026-10-14");
});

test("国内数据库某合约日期缺失时，不借另一个合约的日期",()=>{
  const data=envelope(); data.chinaFutures=[{symbol:"C2611.DCE",history:[future("C2611.DCE",2000,"2026-10-16T08:04:00+08:00","")]},{symbol:"A2611.DCE",history:[future("A2611.DCE",5000,"2026-10-16T08:04:00+08:00")]}];
  const rows=agriculturePresentation(data,now).prices;
  assert.equal(rows[0].date,null);assert.equal(rows[0].status,"Unknown");assert.equal(rows[1].date,"2026-10-15");
});

test("换月时两个实际合约独立保留，各合约选自己的最新交易日和采集时间",()=>{
  const data=envelope();const old=future("C2609.DCE",2100,"2026-10-16T08:04:00+08:00","2026-10-14");
  const early=future("C2611.DCE",2200,"2026-10-16T08:00:00+08:00"),late=future("C2611.DCE",2300,"2026-10-16T08:04:00+08:00");
  // Both contracts may arrive under the same commodity group during rollover.
  data.chinaFutures=[{symbol:"C.DCE",history:[old,early,late]}];
  data.radar={status:"available",quotes:[],mainContracts:[{continuousSymbol:"C.DCE",contractSymbol:"C2611.DCE",mappingDate:"2026-10-16"}]};
  const before=JSON.stringify(data),rows=agriculturePresentation(data,now).prices,view=splitContractPrices(rows,data,now);
  assert.equal(rows.length,2);assert.equal(rows.find(row=>row.symbol==="C2611.DCE")!.price,2300);
  assert.equal(rows.find(row=>row.symbol==="C2611.DCE")!.collectedAt,late.collectedDate);
  assert.equal(view.current.length,1);assert.equal(view.current[0].symbol,"C2611.DCE");
  assert.equal(view.history[0].symbol,"C2609.DCE");assert.equal(view.history[0].date,"2026-10-14");assert.equal(view.history[0].price,2100);
  assert.equal(JSON.stringify(data),before);
});

test("国内同合约较旧交易日即使晚采集也不覆盖新交易日，空价格不借旧价格",()=>{
  const data=envelope();const newest=future("C2611.DCE",2300,"2026-10-16T08:04:00+08:00");
  const refetchedOld=future("C2611.DCE",2200,"2026-10-16T12:00:00+08:00","2026-10-14");
  for(const history of [[newest,refetchedOld],[refetchedOld,newest]]) {
    data.chinaFutures=[{symbol:"C2611.DCE",history}];
    const row=agriculturePresentation(data,now).prices[0];
    assert.equal(row.price,2300);assert.equal(row.date,"2026-10-15");assert.equal(row.collectedAt,newest.collectedDate);
  }
  data.chinaFutures![0].history=[refetchedOld,{...newest,price:null as unknown as number}];
  const missing=agriculturePresentation(data,now).prices[0];assert.equal(missing.price,null);assert.equal(missing.date,"2026-10-15");
});

test("换月没有映射时都保留在历史，有重复相同映射时仍只显示一个主力",()=>{
  const data=envelope();data.chinaFutures=[{symbol:"C.DCE",history:[future("C2609.DCE",2100,"2026-10-16T08:04:00+08:00"),future("C2611.DCE",2300,"2026-10-16T08:04:00+08:00")]}];
  const rows=agriculturePresentation(data,now).prices;
  assert.equal(splitContractPrices(rows,data,now).history.length,2);
  const mapping={continuousSymbol:"C.DCE",contractSymbol:"C2611.DCE",mappingDate:"2026-10-16"};
  data.radar={status:"available",quotes:[],mainContracts:[mapping,mapping]};
  const view=splitContractPrices(rows,data,now);assert.equal(view.current.length,1);assert.equal(view.history.length,1);
  data.radar.mainContracts=[{...mapping,contractSymbol:"A2611.DCE"}];
  assert.equal(splitContractPrices(rows,data,now).current.length,0);
});

test("换月映射若同品种同日冲突，不把两个合约都当成已确认主力",()=>{
  const data=envelope();data.chinaFutures=[{symbol:"C.DCE",history:[future("C2609.DCE",2100,"2026-10-16T08:04:00+08:00"),future("C2611.DCE",2300,"2026-10-16T08:04:00+08:00")]}];
  data.radar={status:"available",quotes:[],mainContracts:["C2609.DCE","C2611.DCE"].map(contractSymbol=>({continuousSymbol:"C.DCE",contractSymbol,mappingDate:"2026-10-16"}))};
  const view=splitContractPrices(agriculturePresentation(data,now).prices,data,now);
  assert.equal(view.current.length,0);assert.equal(view.history.length,2);
});

test("工作台使用自定义名字，空名字显示我的工作台",()=>{
  const html=renderToStaticMarkup(createElement(WorkbenchOverview,{data:emptyDashboardData(),onNotifications(){},onRoom(){},onConnections(){},vpsInterval:60}));
  assert.doesNotMatch(html,/Holle Felix/);assert.match(html,/wb-personal-title[^>]*>我的工作台/);
  const named=renderToStaticMarkup(createElement(WorkbenchOverview,{data:emptyDashboardData(),displayName:"测试昵称",onNotifications(){},onRoom(){},onConnections(){},vpsInterval:60}));
  assert.match(named,/wb-personal-title[^>]*>测试昵称/);
});

test("新闻页无金十来源时不显示采集说明，有来源分支保留真实检查周期",()=>{
  const html=renderToStaticMarkup(createElement(NewsWorkspace,{visible:false}));
  assert.doesNotMatch(html,/每\s*2\s*分钟采集/);assert.doesNotMatch(html,/本页每分钟检查/);
  const source=readFileSync("src/components/NewsWorkspace.tsx","utf8");
  assert.match(source,/\(jin10\|\|jin10Error\)\&\&<p>金十快讯：[\s\S]*?采集周期未知 \/ 本页每分钟检查/);
});
