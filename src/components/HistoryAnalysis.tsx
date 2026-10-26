import {CloseIcon} from "./CloseIcon";
import { useEffect, useRef, useState } from "react";
import type { AnalysisSource, HistoryAnalysisReport } from "../domain/analysis/contracts";
import { analysisSources } from "../domain/analysis/contracts";
import { isHistoryReportFresh, runHistoryAnalysis } from "../application/historyAnalysis";
import { selectHistoryRepository } from "../services/historyRepository";
import { isTauri } from "../tauri";
import { isWindowVisible, subscribeWindowVisibility } from "../services/windowVisibility";
import { runEvidenceAnalyzer } from "../application/evidenceAnalysis";
import { nativeEvidenceAnalyzer, type AnalysisReceipt } from "../adapters/nativeEvidenceAnalyzer";
import { analysisModels, type RemoteAnalysisSettings } from "../domain/analysis/remoteSettings";
import { hasCredential } from "../services/credentials";
import type { AnalysisCandidate } from "../domain/analysis/contracts";

const names: Record<AnalysisSource, string> = { hardware: "本机硬件", system: "Windows 事件", vps: "VPS", api: "API 余额与费用" };
const sentFields: Record<AnalysisSource, string> = { hardware: "本机硬件指标", system: "事件来源、ID、级别和消息", vps: "VPS Hub 地址、System ID 和指标", api: "API 账户、余额、费用、币种和报告区间" };
const sourceStatus = { available: "历史可读取", partial: "部分可用", DATA_UNAVAILABLE: "数据不可用" };
const time = (value: string | null, zone: string) => value ? new Intl.DateTimeFormat("zh-CN", {
  timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(value)) : "无样本";
const format = (value: number) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);

export function HistoryAnalysis({ simulationEnabled, remoteSettings, showLauncher=true }: { simulationEnabled: boolean; remoteSettings: RemoteAnalysisSettings; showLauncher?:boolean }) {
  const [opened, setOpened] = useState(false);
  const [minutes, setMinutes] = useState(10);
  const [sources, setSources] = useState<AnalysisSource[]>(["hardware"]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<HistoryAnalysisReport | null>(null);
  const [evidenceCount, setEvidenceCount] = useState(40);
  const revision = useRef(0);
  const remoteAbort = useRef<AbortController | null>(null);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [credential, setCredential] = useState<boolean | null>(null);
  const [remoteError, setRemoteError] = useState("");
  const [remoteResult, setRemoteResult] = useState<{ observations: AnalysisCandidate[]; receipt: AnalysisReceipt } | null>(null);
  const [clock, setClock] = useState(Date.now());
  const clearRemote = () => {
    remoteAbort.current?.abort(); remoteAbort.current = null;
    setRemoteBusy(false); setConfirmed(false); setRemoteResult(null); setRemoteError("");
  };
  useEffect(() => {
    const unsubscribe = subscribeWindowVisibility(() => {
      if (!isWindowVisible()) { revision.current++; setLoading(false); clearRemote(); }
    });
    return () => { revision.current++; remoteAbort.current?.abort(); unsubscribe(); };
  }, []);
  useEffect(() => {
    clearRemote(); let active = true; setCredential(null);
    if (remoteSettings.provider) void hasCredential(`analysis-${remoteSettings.provider}`).then((value) => { if (active) setCredential(value); })
      .catch(() => { if (active) setRemoteError("无法读取推理凭据状态"); });
    return () => { active = false; };
  }, [remoteSettings.provider, remoteSettings.credentialRevision, simulationEnabled]);
  useEffect(() => { if (!opened) return; setClock(Date.now()); const timer = window.setInterval(() => setClock(Date.now()), 1_000); return () => window.clearInterval(timer); }, [opened]);
  const reset = () => { revision.current++; clearRemote(); setLoading(false); setReport(null); setError(""); };
  const close = () => { revision.current++; clearRemote(); setLoading(false); setOpened(false); };
  useEffect(()=>{const open=()=>setOpened(true);window.addEventListener("codex-desktop.open-history-analysis",open);return()=>window.removeEventListener("codex-desktop.open-history-analysis",open);},[]);
  const reportFresh = !!report && isHistoryReportFresh(report, clock);
  useEffect(() => { if (!reportFresh) setConfirmed(false); }, [reportFresh]);
  const remote = async () => {
    if (!report || !remoteSettings.provider || !confirmed || !credential || simulationEnabled || remoteBusy || !isTauri()) return;
    // The latest source sample can expire before the report's own two-minute window.
    // Recheck the current clock at the click, rather than trusting the last timer render.
    if (!isHistoryReportFresh(report, Date.now())) {
      setClock(Date.now()); setConfirmed(false); setRemoteError("报告或来源样本已过期，请重新生成本地报告后确认"); return;
    }
    const current = revision.current;
    const controller = new AbortController(); remoteAbort.current = controller;
    const consent = { enabled: true as const, providerId: `analysis-${remoteSettings.provider}`, from: report.request.from, to: report.request.to, sources: [...report.request.sources] };
    const analyzer = nativeEvidenceAnalyzer(remoteSettings.provider, consent);
    setRemoteBusy(true); setRemoteError(""); setRemoteResult(null); setConfirmed(false);
    try {
      const result = await runEvidenceAnalyzer(report, analyzer, consent, controller.signal);
      if (revision.current === current && !controller.signal.aborted && analyzer.receipt) setRemoteResult({ observations: result.observations, receipt: analyzer.receipt });
    } catch (error) {
      if (revision.current === current && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : typeof error === "string" ? error : "远程分析失败；未自动重试";
        setRemoteError(message.length <= 200 ? message : "远程分析失败；未自动重试");
      }
    } finally { if (remoteAbort.current === controller) { remoteAbort.current = null; setRemoteBusy(false); } }
  };
  const run = async () => {
    const current = ++revision.current;
    clearRemote(); setClock(Date.now());
    setLoading(true); setError(""); setReport(null); setEvidenceCount(40);
    // Current hardware bucket is still being upserted every sample. Use only closed buckets
    // so consent and the native recheck refer to a stable snapshot while the user reads it.
    const generated = new Date();
    const to = new Date(Math.floor(generated.getTime() / 30_000) * 30_000);
    try {
      const result = await runHistoryAnalysis(selectHistoryRepository(isTauri()), {
        from: new Date(to.getTime() - minutes * 60_000).toISOString(), to: to.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", sources: [...sources],
      }, generated.toISOString());
      if (revision.current === current) setReport(result);
    } catch {
      if (revision.current === current) setError("历史分析无法读取有效数据。请检查数据来源或调整时间范围。");
    } finally { if (revision.current === current) setLoading(false); }
  };
  return <>
    {showLauncher&&<button className="history-analysis-launcher glass" onClick={() => setOpened(true)} aria-expanded={opened}>历史分析</button>}
    {opened && <section className="history-analysis-panel glass" role="dialog" aria-modal="false" aria-label="历史分析">
      <div className="history-analysis-heading"><div><strong>历史证据与统计</strong><small>从本机历史读取，按实际采样时间分析</small></div><button className="ui-icon-button" onClick={close} aria-label="关闭历史分析"><CloseIcon/></button></div>
      {simulationEnabled && <p className="history-analysis-warning">模拟模式正在运行；本页只接受已确认来源的真实历史。</p>}
      <div className="history-analysis-controls"><label>时间范围<select value={minutes} disabled={loading} onChange={(event) => { reset(); setMinutes(Number(event.target.value)); }}>
        <option value={10}>最近 10 分钟</option><option value={60}>最近 1 小时</option><option value={360}>最近 6 小时</option><option value={1440}>最近 24 小时</option><option value={10080}>最近 7 天</option>
      </select></label><button disabled={loading || sources.length === 0} onClick={() => void run()}>{loading ? "读取中…" : "生成本地报告"}</button></div>
      <fieldset disabled={loading}><legend>数据来源</legend>{analysisSources.map((source) => <label key={source}><input type="checkbox" checked={sources.includes(source)}
        onChange={(event) => { reset(); setSources((current) => event.target.checked ? [...current, source] : current.filter((item) => item !== source)); }} />{names[source]}</label>)}</fieldset>
      <p className="history-analysis-note">生成本地报告只读取本机历史，范围结束于最近一个完整的 30 秒历史桶。远程分析需要先在设置中选择服务，再确认本次发送。OpenAI 接入暂缓。</p>
      {error && <p role="alert" className="history-analysis-warning">{error}</p>}
      {report && <>
        <div className="history-analysis-meta"><strong>{sourceStatus[report.status]}</strong>
          <span>请求：{time(report.request.from, report.request.timeZone)} — {time(report.request.to, report.request.timeZone)}</span>
          <span>实际：{time(report.actualFrom, report.request.timeZone)} — {time(report.actualTo, report.request.timeZone)}</span>
          <span>时区 {report.request.timeZone} · 生成于 {time(report.generatedAt, report.request.timeZone)}</span></div>
        <div className="history-analysis-sources">{report.sources.map((source) => <article key={source.source}>
          <strong>{names[source.source]} · {sourceStatus[source.status]}</strong><small>{source.acceptedCount} 个有效样本 · 查询匹配 {source.queriedCount} 条 · 排除 {source.excludedCount} 条{source.truncated ? " · 已截断" : ""}</small>
          {source.issues.map((issue) => <small key={issue}>{issue}</small>)}</article>)}</div>
        {report.metrics.length > 0 && <div className="history-analysis-table-wrap"><table><caption>有效样本统计</caption><thead><tr><th>指标 / 单位</th><th>样本</th><th>最小</th><th>最大</th><th>样本均值</th></tr></thead>
          <tbody>{report.metrics.map((metric) => <tr key={metric.key}><th>{metric.label} / {metric.unit}{metric.periodStart && <small>UTC 费用范围：{metric.periodStart} — {metric.periodEnd}</small>}</th>
            <td>{metric.sampleCount}</td><td>{format(metric.minimum)}</td><td>{format(metric.maximum)}</td><td>{format(metric.sampleMean)}</td></tr>)}</tbody></table></div>}
        <div className="history-analysis-readiness"><strong>后续 AI 分析所需数据：{report.aiReadiness.eligible ? "通过当前稳定性检查" : "尚未满足"}</strong>
          {report.aiReadiness.reasons.map((reason) => <small key={reason}>{reason}</small>)}<small>本地检查通过不会自动发送数据；原生层将在发送前再次核对真实记录。</small></div>
        <section className="history-analysis-remote" aria-label="远程 AI 分析">
          <strong>AI 筛选与排列观察项</strong>
          <small>{remoteSettings.provider ? `${remoteSettings.provider === "deepseek" ? "DeepSeek" : "Anthropic"} · ${analysisModels[remoteSettings.provider]}` : "尚未选择推理服务。请在设置 → AI 历史分析中配置。"}</small>
          {remoteSettings.provider && <small>{credential === null ? "正在检查推理凭据" : credential ? "独立推理凭据已保存" : "请在设置中保存独立推理凭据"}</small>}
          <small>拟发送 {report.evidence.length} 条记录（记录 ID、来源、时间）：{report.request.sources.map((source) => sentFields[source]).join("；")}。下方证据列表可逐条查看。密钥只用于认证。</small>
          <small>范围（UTC）：{report.request.from} — {report.request.to} · 来源：{report.request.sources.map((source) => names[source]).join("、")}</small>
          <small>最多返回 12 项，关联原有证据；不会生成执行动作或因果结论。调用可能产生服务费用。</small>
          {!reportFresh && <small className="history-analysis-warning">报告或来源样本已过期，请重新生成后确认。</small>}
          {simulationEnabled && <small className="history-analysis-warning">模拟模式下不能发送远程分析。</small>}
          <label><input type="checkbox" checked={confirmed} disabled={remoteBusy || !isTauri() || !credential || !report.aiReadiness.eligible || !reportFresh || simulationEnabled}
            onChange={(event) => setConfirmed(event.target.checked)} />我确认将本次范围的证据发送到上述服务，并接受可能产生的费用</label>
          <div className="settings-actions"><button disabled={!confirmed || remoteBusy || !credential || !remoteSettings.provider || !report.aiReadiness.eligible || !reportFresh || simulationEnabled || !isTauri()}
            onClick={() => void remote()}>{remoteBusy ? "分析中…" : "发送本次分析"}</button>{remoteBusy && <button onClick={() => { clearRemote(); setRemoteError("已请求取消；已发送的请求仍可能计费，请等原生请求结束后再试。"); }}>取消分析</button>}</div>
          <small>以 60 秒为等待期限，超时不自动重试。取消生效可能需要等待当前网络操作结束；已发送的数据无法撤回。</small>
          {remoteError && <p className="history-analysis-warning" role="alert">{remoteError}</p>}
          {remoteResult && <>
            <small>完成：{remoteResult.receipt.model} · {time(new Date(remoteResult.receipt.completedAtUnixMs).toISOString(), report.request.timeZone)} · 输入 / 输出 token：{remoteResult.receipt.inputTokens ?? "未知"} / {remoteResult.receipt.outputTokens ?? "未知"}</small>
            <details><summary>本次证据批次 SHA-256</summary><code>{remoteResult.receipt.batchId}</code></details>
            {!remoteResult.observations.length && <small>模型未选出观察项；这不证明没有异常。</small>}
            {remoteResult.observations.map((candidate, index) => <article className="history-analysis-candidate" key={candidate.id}><strong>{index + 1}. {candidate.title}</strong><p>{candidate.detail}</p>
              <details><summary>关联证据（{candidate.evidenceIds.length}）</summary><code>{candidate.evidenceIds.join("\n")}</code></details></article>)}
            <small>AI 只负责选择和排序；所显示的统计与说明由本地证据计算。缺失指标不补零，时间共现不证明因果。</small>
          </>}
        </section>
        {report.candidates.length > 0 && <details><summary>观察项与证据引用（{report.candidates.length}）</summary>{report.candidates.map((candidate) => <article className="history-analysis-candidate" key={candidate.id}>
          <strong>{candidate.title}</strong><p>{candidate.detail}</p><small>引用 {candidate.evidenceIds.length} 条记录</small><details><summary>查看记录 ID</summary><code>{candidate.evidenceIds.join("\n")}</code></details></article>)}</details>}
        <details><summary>证据记录（{report.evidence.length}）</summary>{report.evidence.slice(0, evidenceCount).map((entry) => <article className="history-analysis-evidence" key={entry.id}>
          <strong>{names[entry.source]} · {time(entry.observedAt, report.request.timeZone)}</strong><code>{entry.id}</code><small>来源 {entry.providerId}{entry.sourceUrl ? ` · ${entry.sourceUrl}` : ""}</small>
          {entry.event && <p>{entry.event.source} / Event ID {entry.event.eventId}：{entry.event.message}</p>}</article>)}
          {report.evidence.length > evidenceCount && <button onClick={() => setEvidenceCount((count) => count + 40)}>再显示 40 条</button>}</details>
        <ul className="history-analysis-uncertainties">{report.uncertainties.map((uncertainty) => <li key={uncertainty}>{uncertainty}</li>)}</ul>
      </>}
    </section>}
  </>;
}
