import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { nativeEvidenceAnalyzer } from "../src/adapters/nativeEvidenceAnalyzer";
import { normalizeRemoteAnalysisSettings } from "../src/domain/analysis/remoteSettings";
import { prepareEvidenceBatch, runEvidenceAnalyzer } from "../src/application/evidenceAnalysis";
import { buildHistoryAnalysis } from "../src/application/historyAnalysis";
import type { HistoryRecord } from "../src/types";
import { readFileSync } from "node:fs";
import { analysisFixture } from "./helpers/analysisFixture";

test("native analysis golden fixture remains identical to the frontend evidence contract", async () => {
  assert.deepEqual(await analysisFixture(),JSON.parse(readFileSync("tests/fixtures/analysis-batch.json","utf8")));
});

function fixture() {
  const now = Date.parse("2026-10-05T02:10:00.000Z");
  const request = { from: new Date(now-600_000).toISOString(),to:new Date(now).toISOString(),timeZone:"Asia/Shanghai",sources:["hardware" as const] };
  const records: HistoryRecord[] = Array.from({length:20},(_,index) => { const at = now-600_000+index*30_000+10_000; return {
    id:`sample-${index}`,kind:"hardware_history",createdAt:new Date(Math.floor(at/30_000)*30_000).toISOString(),
    payload:{ sampledAtUnixMs:at,provenance:{schemaVersion:1,mode:"live",providerId:"hardware-status"},cpu:{usageStatus:"available",usagePercent:10+index} },
  }; });
  const report = buildHistoryAnalysis(request,{hardware:{records,totalCount:20,truncated:false}},request.to);
  const consent = { enabled:true as const,providerId:"analysis-deepseek",from:request.from,to:request.to,sources:request.sources };
  return { report,consent };
}
test("remote service is unselected for new, legacy, unsupported or OpenAI settings", () => {
  for (const value of [null,{}, {provider:"openai"},{provider:"custom-url"}]) assert.equal(normalizeRemoteAnalysisSettings(value).provider,null);
  assert.deepEqual(normalizeRemoteAnalysisSettings({provider:"deepseek",credentialRevision:1}),{provider:"deepseek",credentialRevision:1});
  assert.equal(normalizeRemoteAnalysisSettings({provider:"anthropic",credentialRevision:NaN}).credentialRevision,0);
});
test("native adapter passes the exact UTF8 body digest, one manual consent and no key or URL", async () => {
  const {report,consent} = fixture(); const commands: string[] = [];
  const adapter = nativeEvidenceAnalyzer("deepseek",consent,async <T>(command: string,args: Record<string,unknown>) => {
    commands.push(command); const request = args.request as {bodyJson:string;batchId:string;consent:unknown;provider:string};
    assert.equal(createHash("sha256").update(request.bodyJson,"utf8").digest("hex"),request.batchId);
    assert.deepEqual(request.consent,consent); assert.equal(request.provider,"deepseek");
    assert.ok(!("secret" in request)); assert.ok(!("url" in request));
    const body = JSON.parse(request.bodyJson); assert.equal(body.evidence.length,20);
    return {selection:{schemaVersion:1,batchId:request.batchId,selections:[{candidateId:body.candidates[0].id,evidenceIds:body.candidates[0].evidenceIds}]},
      receipt:{provider:"deepseek",model:"deepseek-flash",batchId:request.batchId,requestedAtUnixMs:1,completedAtUnixMs:2,inputTokens:null,outputTokens:null}} as T;
  });
  const result = await runEvidenceAnalyzer(report,adapter,consent);
  assert.equal(result.observations.length,1); assert.deepEqual(commands,["analyze_history_remote"]);
  assert.equal(adapter.receipt!.batchId,result.batchId);
});
test("missing scope consent and abort before dispatch never invoke a native request", async () => {
  const {report,consent} = fixture(); let calls=0;
  const adapter = nativeEvidenceAnalyzer("deepseek",consent,async () => { calls++; throw new Error("unexpected"); });
  await assert.rejects(runEvidenceAnalyzer(report,adapter,{...consent,to:report.request.from}));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(runEvidenceAnalyzer(report,adapter,consent,abort.signal)); assert.equal(calls,0);
});
test("abort after dispatch sends one cancellation and never publishes a late receipt", async () => {
  const {report,consent} = fixture(); const batch=await prepareEvidenceBatch(report); const abort = new AbortController();
  const commands: string[]=[]; let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>((r) => { resolve=r; });
  const adapter = nativeEvidenceAnalyzer("deepseek",consent,async <T>(command: string) => {
    commands.push(command); return (command === "analyze_history_remote" ? await pending : undefined) as T;
  });
  const result = adapter.analyze(batch,abort.signal); abort.abort();
  resolve({selection:{},receipt:{}}); await assert.rejects(result);
  assert.deepEqual(commands,["analyze_history_remote","cancel_history_analysis"]); assert.equal(adapter.receipt,null);
});
test("native failures are not retried and a foreign receipt is rejected", async () => {
  const {report,consent} = fixture(); let calls=0;
  const adapter=nativeEvidenceAnalyzer("deepseek",consent,async () => { calls++; throw new Error("quota"); });
  await assert.rejects(runEvidenceAnalyzer(report,adapter,consent),/quota/); assert.equal(calls,1);
  const bad=nativeEvidenceAnalyzer("deepseek",consent,async <T>() => ({selection:{},receipt:{provider:"anthropic",batchId:"wrong"}} as T));
  await assert.rejects(runEvidenceAnalyzer(report,bad,consent),/回执无效/); assert.equal(bad.receipt,null);
});
