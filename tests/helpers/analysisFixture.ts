import { buildHistoryAnalysis } from "../../src/application/historyAnalysis";
import { prepareEvidenceBatch } from "../../src/application/evidenceAnalysis";
import type { HistoryRecord } from "../../src/types";
export async function analysisFixture() {
  const now=Date.parse("2026-10-05T02:10:00.000Z"), from=now-600_000;
  const records: HistoryRecord[] = Array.from({length:20},(_,index) => {
    const at=from+index*30_000+10_000;
    return {id:`sample-${index}`,kind:"hardware_history",createdAt:new Date(Math.floor(at/30_000)*30_000).toISOString(),payload:{
      sampledAtUnixMs:at,provenance:{schemaVersion:1,mode:"live",providerId:"hardware-status"},cpu:{usageStatus:"available",usagePercent:10+index},
      memory:{status:"available",usagePercent:41.12345},network:{status:"available",uploadBytesPerSecond:1234.125,downloadBytesPerSecond:4096.25},
      disks:{status:"available",volumes:[{name:"C:\\",totalBytes:1000,usedBytes:300,usagePercent:30}]},
      gpu:{name:"RTX Test",status:"available",usageStatus:"unsupported",memoryStatus:"available",memoryUsedBytes:123,memoryTotalBytes:789,temperatureStatus:"available",temperatureC:62},
    }};
  });
  for (const [index,source] of ["Display","Application Error"].entries()) records.push({id:`event-${index}`,kind:"system_events",createdAt:new Date(now-60_000+index*1000).toISOString(),payload:{
    provenance:{schemaVersion:1,mode:"live",providerId:"windows-health"},timestamp:new Date(now-60_000+index*1000).toISOString(),eventId:1000+index,source,severity:"error",message:"Fixture event: no real crash or system change.",
  }});
  records.push({id:"vps",kind:"vps_history",createdAt:new Date(now-30_000).toISOString(),payload:{
    provenance:{schemaVersion:1,mode:"live",providerId:"vps-status"},serverId:"fixture-id",hubUrl:"https://fixture.example.com/",snapshot:{state:"online",lastUpdated:new Date(now-30_000).toISOString(),gauges:[{label:"CPU",value:12},{label:"内存",value:40}]},
  }});
  for (const source of ["deepseek","anthropic"]) records.push({id:`api-${source}`,kind:"usage_history",createdAt:new Date(now-20_000).toISOString(),payload:{
    schemaVersion:1,simulation:false,source,accounts:[{id:"fixture",currency:source === "deepseek" ? "CNY" : "USD",state:"normal",observedAt:new Date(now-20_000).toISOString(),
      balance:source === "deepseek" ? 123.45 : undefined,todayCost:source === "anthropic" ? 1.25 : undefined,monthCost:source === "anthropic" ? 10.25 : undefined,
      todayPeriodStart:"2026-10-05T00:00:00.000Z",todayPeriodEnd:"2026-10-06T00:00:00.000Z",periodStart:"2026-10-01T00:00:00.000Z",periodEnd:"2026-11-01T00:00:00.000Z"}],
  }});
  const request={from:new Date(from).toISOString(),to:new Date(now).toISOString(),timeZone:"Asia/Shanghai",sources:["hardware","system","vps","api"] as const};
  const queried = Object.fromEntries(["hardware","system","vps","api"].map((source) => {
    const kind = {hardware:"hardware_history",system:"system_events",vps:"vps_history",api:"usage_history"}[source];
    const entries=records.filter((r) => r.kind===kind); return [source,{records:entries,totalCount:entries.length,truncated:false}];
  }));
  const report=buildHistoryAnalysis({...request,sources:[...request.sources]},queried,new Date(now).toISOString());
  const {batchId,...batch}=await prepareEvidenceBatch(report);
  return JSON.parse(JSON.stringify({generatedAt:report.generatedAt,batchId,batch,records}));
}
