import test from "node:test";
import assert from "node:assert/strict";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {MarketWatchRow} from "../src/components/MarketWorkspace";
import {marketQuotes,marketQuoteState,formatMarketTime,splitContractPrices} from "../src/domain/agriculture/marketQuotes";
import type {AgricultureEnvelope,AgriculturePrice,RadarQuote} from "../src/domain/agriculture/contracts";
const envelope=():AgricultureEnvelope=>({schemaVersion:1,origin:"ssh:vps:203.0.113.10",fetchedAt:"2026-10-15T07:05:00Z",snapshots:{},market:[{symbol:"SI=F",history:[{symbol:"SI=F",name:"COMEX 银",sourceDate:"2026-10-14",price:50,collectedDate:"2026-10-15",changePct:-7.928}]}],radar:{status:"available",quotes:[{symbol:"000426.SZ",sourceSymbol:"sz000426",price:20,changePct:-4,quoteAt:null,collectedAt:"2026-10-15T07:04:02Z",source:"VPS / 新浪盘中雷达",dataType:"intraday"}],mainContracts:[]}});

test("COMEX daily change survives without invented quote time or interval fallback",()=>{
 const q=marketQuotes(envelope()).get("SI=F")![0];assert.equal(q.dayChange,-7.928);assert.equal(q.sourceDate,"2026-10-14");assert.equal(q.quoteAt,null);assert.equal(q.dataType,"daily");
 const data=envelope();data.market![0].history[0].changePct=null;assert.equal(marketQuotes(data).get("SI=F")![0].dayChange,null);
});
test("four radar instruments require own snapshots, never Yahoo or another silver instrument",()=>{
 const data=envelope();data.market!.push({symbol:"AG.SHF",history:[{name:"wrong fallback",symbol:"AG.SHF",sourceDate:"2026-10-15",price:999,collectedDate:"2026-10-15"}]},{symbol:"LME-SN",history:[{name:"old tin",symbol:"LME-SN",sourceDate:"2026-10-15",price:999,collectedDate:"2026-10-15"}]});
 let q=marketQuotes(data);assert.equal(q.has("AG.SHF"),false);assert.equal(q.has("LME-SN"),false);assert.equal(q.get("000426.SZ")![0].sourceDate,"");
 data.radar!.status="unavailable";q=marketQuotes(data);assert.equal(q.has("000426.SZ"),false);
});
test("invalid, duplicate and offsetless radar samples fail closed",()=>{
 for(const patch of [{price:0},{price:NaN},{collectedAt:"2026-10-15T07:04:02"}]){const data=envelope();Object.assign(data.radar!.quotes[0],patch);assert.equal(marketQuotes(data).has("000426.SZ"),false);}
 const data=envelope();data.radar!.quotes.push({...data.radar!.quotes[0]});assert.equal(marketQuotes(data).has("000426.SZ"),false);
});
test("freshness uses observation time, never the newest SSH fetchedAt",()=>{
 const data=envelope(),q=marketQuotes(data).get("000426.SZ")![0];assert.equal(marketQuoteState(q,Date.parse("2026-10-15T07:05:00Z")),"");assert.equal(marketQuoteState(q,Date.parse("2026-10-15T08:00:00Z")),"数据未更新");assert.equal(marketQuoteState(q,Date.parse("2026-10-15T06:00:00Z")),"暂不可用");assert.equal(marketQuoteState(undefined),"暂不可用");
 assert.equal(marketQuoteState(marketQuotes(data).get("SI=F")![0],Date.parse("2026-10-20T07:05:00Z")),"数据未更新");
});
test("times format explicitly in Beijing and date-only remains date-only",()=>{
 assert.equal(formatMarketTime("2026-10-15T07:04:02Z"),"2026-10-15 15:04:02");assert.equal(formatMarketTime("2026-10-15 15:04"),"2026-10-15 15:04:00");assert.equal(formatMarketTime("2026-10-14"),"2026-10-14");assert.equal(formatMarketTime(null),"未提供");
});
test("recent confirmed contracts survive weekends without relabeling source dates",()=>{
 const prices:AgriculturePrice[]=[{name:"玉米",symbol:"C2607.DCE",price:100,change:0,date:"2026-06-18",status:"Stale",unit:null,source:"VPS / Tushare"},{name:"玉米",symbol:"C2611.DCE",price:200,change:0,date:"2026-10-14",status:"Cached",unit:null,source:"VPS / Tushare"}];
 const before=JSON.stringify(prices),data=envelope(),now=Date.parse("2026-10-15T07:05:00Z");assert.equal(splitContractPrices(prices,data,now).current.length,0);
 data.radar!.mainContracts=[{continuousSymbol:"C.DCE",contractSymbol:"C2611.DCE",mappingDate:"2026-10-15"}];const view=splitContractPrices(prices,data,now);assert.equal(view.current[0].symbol,"C2611.DCE");assert.equal(view.history[0].symbol,"C2607.DCE");assert.equal(JSON.stringify(prices),before);
 assert.equal(splitContractPrices(prices,data,now+86400000).current.length,1);assert.equal(splitContractPrices(prices,data,now+5*86400000).current.length,0);
});
test("UI distinguishes missing quote time, collected time, type, stale and missing price",()=>{
 const q=marketQuotes(envelope()).get("000426.SZ")![0];const html=renderToStaticMarkup(createElement(MarketWatchRow,{asset:{id:"test",name:"测试股票",symbol:"000426.SZ"},quote:q,now:Date.parse("2026-10-15T08:00:00Z")}));
 assert.match(html,/盘中快照/);assert.match(html,/行情时间：未提供/);assert.match(html,/数据未更新/);assert.match(html,/<details/);assert.match(html,/采集时间：<!-- -->2026-10-15 15:04:02|采集时间：2026-10-15 15:04:02/);assert.doesNotMatch(html,/判断|理由/);
 const missing=renderToStaticMarkup(createElement(MarketWatchRow,{asset:{id:"tin",name:"LME 锡",symbol:"LME-SN"}}));assert.match(missing,/暂不可用/);assert.doesNotMatch(missing,/<b>0<\/b>/);
});
test("four independent snapshots keep independent prices and timestamps",()=>{
 const data=envelope();data.radar!.quotes=["000426.SZ","000960.SZ","AG.SHF","SN.SHF"].map((symbol,i):RadarQuote=>({...data.radar!.quotes[0],symbol,price:100+i,collectedAt:`2026-10-15T07:0${i}:00Z`}));
 const result=marketQuotes(data);for(let i=0;i<4;i++){const q=result.get(data.radar.quotes[i].symbol)![0];assert.equal(q.value,100+i);assert.equal(q.collectedAt,data.radar.quotes[i].collectedAt);}
});
