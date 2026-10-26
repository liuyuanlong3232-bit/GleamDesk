import type { ProviderRequestDiagnostics as Snapshot } from "../ports/providerDiagnostics";

const names: Record<string, string> = { "windows-health": "Windows 日志", "vps-status": "Beszel", "api-deepseek": "DeepSeek", "api-anthropic": "Anthropic", "agent-quotas":"AI Agent", "ollama-local":"Ollama" };

export function ProviderRequestDiagnostics({ snapshot, checking, onCheck }: { snapshot: Snapshot | null; checking: boolean; onCheck: (scope: "dashboard" | "both") => void }) {
  return <details className="provider-request-diagnostics">
    <summary>原生请求计数与窗口状态</summary>
    {snapshot ? <>
      <small>进程内累计 · 采集于 {new Date(snapshot.observedAtUnixMs).toLocaleTimeString("zh-CN")}</small>
      <p>{snapshot.windows.map((window) => `${window.label === "main" ? "主屏" : "控制台"}：${window.visible ? "可见" : "隐藏"}`).join(" · ")}</p>
      <div className="diagnostics-table-wrap"><table>
        <thead><tr><th>来源</th><th>命令</th><th>实际读取</th><th>复用</th><th>失败</th></tr></thead>
        <tbody>{snapshot.providers.map(({ id, metrics }) => <tr key={id}><th>{names[id] ?? id}{metrics?.inFlight && " · 读取中"}</th>
          {[metrics?.commands, metrics?.loads, metrics?.reused, metrics?.failures].map((value, index) => <td key={index}>{value ?? "未知"}</td>)}
        </tr>)}</tbody>
      </table></div>
      <small>实际读取指一次 Provider 加载；一次 Beszel 加载包含系统与统计查询。计数不会主动请求数据，重启后归零。</small>
      {snapshot.debugChecksAvailable && <>
        <div className="settings-actions"><button disabled={checking} onClick={() => onCheck("dashboard")}>检查控制台隐藏</button><button disabled={checking} onClick={() => onCheck("both")}>检查双窗口隐藏</button></div>
        <small>{checking ? "显隐检查进行中，窗口会自动恢复。" : "仅调试构建：临时隐藏 75 秒后自动恢复，不修改设置。已有请求可能完成；诊断刷新可核对实际读取时间。"}</small>
      </>}
      <details><summary>最近读取与显隐时间</summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details>
    </> : <small>原生计数不可用；浏览器预览不提供此数据。</small>}
  </details>;
}
