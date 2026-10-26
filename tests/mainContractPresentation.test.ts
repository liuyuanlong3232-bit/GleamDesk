import test from "node:test";
import assert from "node:assert/strict";
import {splitContractPrices} from "../src/domain/agriculture/marketQuotes";
import type {AgricultureEnvelope,AgriculturePrice,MainContract} from "../src/domain/agriculture/contracts";

const saturday=Date.parse("2026-10-17T04:00:00Z");
const price=(symbol:string,day="2026-10-16"):AgriculturePrice=>({name:"测试品种",symbol,price:2000,change:1,date:day,status:"Cached",unit:"元/吨",source:"VPS / Tushare API"});
const envelope=(mappings:unknown[]):AgricultureEnvelope=>({schemaVersion:1,origin:"ssh:vps:203.0.113.10",fetchedAt:"2026-10-17T04:00:00Z",snapshots:{},radar:{status:"unavailable",quotes:[],mainContracts:mappings as MainContract[]}});
const mapping=(contract="C2701.DCE",day="2026-10-16",confirmed=true)=>({continuousSymbol:"C.DCE",contractSymbol:contract,mappingDate:day,confirmed,source:"VPS / 国内期货采集状态",collectedAt:"2026-10-17T08:04:00+08:00"});

test("周六无盘中雷达时仍显示周五最近确认主力及其确认日期",()=>{
  const prices=[price("C2611.DCE"),price("C2701.DCE")],before=JSON.stringify(prices);
  const view=splitContractPrices(prices,envelope([mapping()]),saturday);
  assert.equal(view.current.length,1);assert.equal(view.current[0].symbol,"C2701.DCE");
  assert.equal((view.current[0] as AgriculturePrice&{mappingDate:string}).mappingDate,"2026-10-16");
  assert.equal(view.current[0].date,"2026-10-16");assert.equal(view.history[0].symbol,"C2611.DCE");
  assert.equal(JSON.stringify(prices),before);
});

test("周一保留三天内最近确认结果，超过三天或来自未来的关系留在历史",()=>{
  const data=envelope([mapping()]),prices=[price("C2701.DCE")];
  assert.equal(splitContractPrices(prices,data,Date.parse("2026-10-19T04:00:00Z")).current.length,1);
  assert.equal(splitContractPrices(prices,data,Date.parse("2026-10-20T04:00:00Z")).history.length,1);
  assert.equal(splitContractPrices(prices,envelope([mapping("C2701.DCE","2026-10-18")]),saturday).current.length,0);
});

test("同品种选择最新关系日期，不把两个换月合约都当主力",()=>{
  const prices=[price("C2611.DCE","2026-10-15"),price("C2701.DCE")];
  const view=splitContractPrices(prices,envelope([mapping("C2611.DCE","2026-10-15"),mapping()]),saturday);
  assert.equal(view.current.length,1);assert.equal(view.current[0].symbol,"C2701.DCE");assert.equal(view.history[0].symbol,"C2611.DCE");
});

test("同日未确认旧月不妨碍另一个已确认月，只有未确认时不回退到旧映射",()=>{
  const prices=[price("C2611.DCE"),price("C2701.DCE")];
  assert.equal(splitContractPrices(prices,envelope([mapping("C2611.DCE","2026-10-16",false),mapping()]),saturday).current.length,1);
  assert.equal(splitContractPrices(prices,envelope([mapping("C2611.DCE","2026-10-15"),mapping("C2701.DCE","2026-10-16",false)]),saturday).current.length,0);
});

test("同日多个已确认合约或同一合约确认状态矛盾时保留历史",()=>{
  for(const mappings of [[mapping("C2611.DCE"),mapping()],[mapping(),mapping("C2701.DCE","2026-10-16",false)]]) {
    const view=splitContractPrices([price("C2611.DCE"),price("C2701.DCE")],envelope(mappings),saturday);
    assert.equal(view.current.length,0);assert.equal(view.history.length,2);
  }
});

test("行情日期更新到映射之后或行情已过期时不继续借用旧映射",()=>{
  assert.equal(splitContractPrices([price("C2701.DCE","2026-10-17")],envelope([mapping()]),saturday).current.length,0);
  assert.equal(splitContractPrices([price("C2701.DCE","2026-10-09")],envelope([mapping()]),saturday).current.length,0);
  assert.equal(splitContractPrices([price("C2701.DCE","")],envelope([mapping()]),saturday).current.length,0);
  assert.equal(splitContractPrices([{...price("C2701.DCE"),status:"Stale"}],envelope([mapping()]),saturday).current.length,0);
});

test("十二个品种可以各自确认，不依赖盘中雷达且不改写行情日期",()=>{
  const codes=["LH","M","C","A","CS","WH","Y","SR","CF","OI","P","JD"];
  const mappings=codes.map(code=>({...mapping(`${code}2701.${["WH","SR","CF","OI"].includes(code)?"ZCE":"DCE"}`),continuousSymbol:`${code}.${["WH","SR","CF","OI"].includes(code)?"ZCE":"DCE"}`}));
  const prices=mappings.map(item=>price(item.contractSymbol)),view=splitContractPrices(prices,envelope(mappings),saturday);
  assert.equal(view.current.length,12);assert.ok(view.current.every(item=>item.date==="2026-10-16"));
});

test("关系采集时间无效、来自未来或早于确认日期时不得当作可靠映射",()=>{
  for(const collectedAt of ["", "invalid", "2026-10-18T08:04:00+08:00", "2026-10-15T08:04:00+08:00"]) {
    assert.equal(splitContractPrices([price("C2701.DCE")],envelope([{...mapping(),collectedAt}]),saturday).current.length,0);
  }
});
