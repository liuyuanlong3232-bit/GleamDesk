import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { analysisModels, type RemoteAnalysisSettings, type RemoteAnalysisProvider } from "../domain/analysis/remoteSettings";
import { clearCredential, hasCredential, saveCredential } from "../services/credentials";

export function AnalysisConnectionsSettings({ settings, onChange }: { settings: RemoteAnalysisSettings; onChange: (next: RemoteAnalysisSettings) => void }) {
  const [secret, setSecret] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const revision = settings.credentialRevision;
  const provider = settings.provider;
  useEffect(() => {
    let active = true; setSecret(""); setMessage(""); setConfigured(null);
    if (provider) void hasCredential(`analysis-${provider}`).then((value) => { if (active) setConfigured(value); })
      .catch(() => { if (active) setMessage("无法读取推理凭据状态"); });
    return () => { active = false; };
  }, [provider, revision]);
  const save = async (remove: boolean) => {
    if (!provider) return;
    setBusy(true); setMessage("");
    try {
      if (remove) await clearCredential(`analysis-${provider}`); else await saveCredential(`analysis-${provider}`, secret.trim());
      setSecret(""); setConfigured(!remove);
      onChange({ ...settings, credentialRevision: Date.now() });
      setMessage(remove ? "推理凭据已删除" : "推理凭据已保存");
    } catch { setMessage("无法保存或删除推理凭据，请在 Windows 应用中重试"); }
    finally { setBusy(false); }
  };
  return <div className="settings-section api-settings">
    <small>手动发送，按服务计费。</small>
    <label>推理服务<select value={provider ?? ""} disabled={busy} onChange={(event) => onChange({ ...settings, provider: event.target.value ? event.target.value as RemoteAnalysisProvider : null })}>
      <option value="">未选择 · 关闭远程分析</option><option value="deepseek">DeepSeek</option><option value="anthropic">Anthropic</option>
    </select></label>
    {provider && <>
      <small>模型：{analysisModels[provider]} · {configured === null ? "正在检查凭据" : configured ? "已保存独立推理凭据" : "尚未保存推理凭据"}</small>
      <label>独立推理 API 密钥<input type="password" autoComplete="new-password" disabled={!isTauri() || busy} value={secret} placeholder="输入推理密钥，仅保存在本机" onChange={(event) => setSecret(event.target.value)} /></label>
      <div className="settings-actions"><button disabled={!isTauri() || busy || !secret.trim()} onClick={() => void save(false)}>保存推理凭据</button>{configured && <button disabled={busy} onClick={() => void save(true)}>删除推理凭据</button>}</div>
      <small>使用推理密钥，组织 Admin Key 不适用。</small>
    </>}
    <details className="settings-help"><summary>接入帮助</summary><p>每次发送前确认历史范围，不自动调用或重试。推理密钥与账单读取凭据独立保存，不进入应用配置、历史或分析请求正文。OpenAI 历史分析暂未接入。</p></details>
    {!isTauri()&&<small>账户连接需要 Windows 桌面程序。</small>}
    {message && <small role="status">{message}</small>}
  </div>;
}
