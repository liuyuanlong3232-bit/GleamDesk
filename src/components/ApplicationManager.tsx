import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationItem, ApplicationType, ScannedApplication } from "../types";
import { createApplicationId, normalizeApplications, moveApplication, parseApplicationImport, configVersion } from "../services/applicationStore";
import { applicationsFromPaths,mergeDroppedApplications,applicationTargetsEqual,normalizeApplicationName } from "../services/launcher/dockIngress";
import { readApplicationIcon } from "../services/iconStore";
import { discoverApplications } from "../services/launcher/appScanner";
import { AppGlyph } from "./ApplicationDock";

interface ApplicationManagerProps {
  applications: ApplicationItem[];
  onApplicationsChange: (next: ApplicationItem[] | ((current: ApplicationItem[]) => ApplicationItem[])) => void | Promise<void>;
}

export function ApplicationManager({ applications, onApplicationsChange }: ApplicationManagerProps) {
  const [scanned, setScanned] = useState<ScannedApplication[]>([]);
  const [visibleScanCount, setVisibleScanCount] = useState(40);
  const [scanning, setScanning] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [message, setMessage] = useState("");
  const [draft, setDraft] = useState({ name: "", type: "exe" as ApplicationType, target: "", arguments: "" });
  const importRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLInputElement>(null);
  const iconTarget = useRef<string | null>(null);
  const persist = async (next: Parameters<typeof onApplicationsChange>[0]): Promise<boolean> => {
    try { await onApplicationsChange(next); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "应用配置保存失败，未保存本次更改。"); return false; }
  };

  const scan = async () => {
    setScanning(true);
    setMessage("正在手动扫描开始菜单、桌面和常见程序目录…");
    try {
      const result = await discoverApplications();
      setScanned(result);
      setVisibleScanCount(40);
      setMessage(result.length ? `扫描完成，发现 ${result.length} 个入口。` : "没有发现快捷方式或程序；你也可以手动添加。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "应用扫描失败。");
    } finally {
      setScanning(false);
    }
  };

  const addScanned = async (candidate: ScannedApplication) => {
    try {
      if(!candidate.icon&&candidate.type!=="url"&&candidate.type!=="command") {
        const [metadata]=await applicationsFromPaths([candidate.sourcePath||candidate.target]);
        if(metadata)candidate={...candidate,icon:metadata.icon,iconSource:"system"};
      }
    } catch { /* A missing icon does not prevent adding a verified scanner target. */ }
    if (!await persist(current=>mergeDroppedApplications(current,[{...candidate,pinned:true,order:current.length,glyph:candidate.name.slice(0,1).toUpperCase(),color:"#67b5ff"}]))) return;
    setScanned((current) => current.filter((app) => app.id !== candidate.id));
    setMessage(`${candidate.name} 已添加，可在 Dock 使用。`);
  };

  const selectApplication = async () => {
    if (!isTauri()) { setMessage("请在桌面应用中使用选择器；浏览器预览可在下方粘贴目标路径。"); return; }
    setSelecting(true);
    try {
      const target = await invoke<string | null>("pick_application_target");
      if (!target) return;
      const [candidate] = await applicationsFromPaths([target]);
      if (!candidate) throw new Error("没有读取到这个应用的信息。");
      await addScanned(candidate);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "无法添加这个应用。");
    } finally {
      setSelecting(false);
    }
  };
  const addManual = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = draft.name.trim();
    const target = draft.target.trim();
    if (!name || !target) { setMessage("请填写应用名称和目标路径。"); return; }
    const next: ApplicationItem = {
      id: createApplicationId(name, target, Date.now()), name, icon: "", type: draft.type, target,
      arguments: draft.arguments.trim() || undefined, pinned: true, order: applications.length,
      glyph: name.slice(0, 1).toUpperCase(), color: "#67b5ff",
    };
    if (!await persist((current) => normalizeApplications([...current, next]))) return;
    setDraft({ name: "", type: "exe", target: "", arguments: "" });
    setMessage(`${name} 已添加。`);
  };

  const update = (id: string, patch: Partial<ApplicationItem>) => persist((current) => normalizeApplications(current.map((app) => app.id === id ? { ...app, ...patch } : app)));
  const move = (id: string, offset: number) => persist((current) => moveApplication(current, id, offset));

  const selectIcon = async (file?: File) => {
    const id = iconTarget.current;
    if (!file || !id) return;
    try { if (await update(id, { icon: await readApplicationIcon(file), iconSource: "custom" })) setMessage("自定义图标已保存到应用配置，可随配置一起导出。"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "图标设置失败。"); }
    finally { iconTarget.current = null; }
  };

  const exportConfig = () => {
    const blob = new Blob([JSON.stringify({ version: configVersion, apps: normalizeApplications(applications) }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "applications.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const importConfig = async (file?: File) => {
    if (!file) return;
    try {
      const value: unknown = JSON.parse(await file.text());
      const imported = parseApplicationImport(value);
      if (!imported) throw new Error("配置格式无效。");
      if (!await persist(imported)) return;
      setMessage(`已导入 ${imported.length} 个应用入口。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "应用配置导入失败。"); }
  };

  return <div className="application-manager">
    <div className="application-manager-heading"><strong>应用管理</strong><span>{applications.filter((app) => app.pinned).length} 个已固定 · 共 {applications.length} 个</span></div>
    <div className="application-manager-actions"><button onClick={() => void selectApplication()} disabled={selecting}>{selecting ? "正在读取…" : "选择程序或快捷方式"}</button><button onClick={() => void scan()} disabled={scanning}>{scanning ? "扫描中…" : "扫描已安装应用"}</button><button onClick={exportConfig}>导出配置</button><button onClick={() => importRef.current?.click()}>导入配置</button></div>
    <small>可以直接选择 EXE / LNK / URL 添加，也可以手动扫描已安装应用；扫描只在你点击时运行。</small>
    <input ref={importRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { void importConfig(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    <input ref={iconRef} className="visually-hidden" type="file" accept=".png,.svg,.ico,image/png,image/svg+xml,image/x-icon" onChange={(event) => { void selectIcon(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    {message && <small className="application-manager-message" role="status">{message}</small>}

    <strong className="application-list-title">已添加的应用</strong>
    {applications.length === 0 && <small>还没有应用入口。扫描已安装应用，或在下方手动添加。</small>}
    <div className="managed-app-list">{[...applications].sort((left, right) => left.order - right.order).map((app, index) => (
      <ManagedApplication key={app.id} app={app} index={index} count={applications.length} onUpdate={update} onMove={move} onDelete={() => persist((current) => normalizeApplications(current.filter((candidate) => candidate.id !== app.id)))} onSelectIcon={() => { iconTarget.current = app.id; iconRef.current?.click(); }} />
    ))}</div>

    {scanned.length > 0 && <>
      <strong className="application-list-title">扫描发现</strong>
      <div className="scan-results">{scanned.slice(0, visibleScanCount).map((app) => {
        const added = applications.some(candidate=>applicationTargetsEqual(candidate,{...app,pinned:true,order:0}));
        const fillsExisting=applications.some(candidate=>!candidate.target.trim()&&Boolean(normalizeApplicationName(app.name))&&normalizeApplicationName(candidate.name)===normalizeApplicationName(app.name));
        return <div className="scan-app-row" key={app.id}><span><b>{app.name}</b><small>{app.category} · {app.type === "shortcut" ? "快捷方式" : app.type === "url" ? "网址" : "程序"}</small></span><button disabled={added} onClick={() => addScanned(app)}>{added ? "已添加" : fillsExisting ? "补全已有入口" : "添加到 Dock"}</button></div>;
      })}</div>
      {scanned.length > visibleScanCount && <button className="show-more-apps" onClick={() => setVisibleScanCount((count) => Math.min(scanned.length, count + 40))}>再显示 40 项（剩余 {scanned.length - visibleScanCount}）</button>}
    </>}

    <strong className="application-list-title">手动添加</strong>
    <form className="application-add-form" onSubmit={addManual}>
      <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="应用名称" aria-label="应用名称" />
      <select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as ApplicationType }))} aria-label="应用类型">
        <option value="exe">程序</option><option value="shortcut">快捷方式</option><option value="url">网址</option><option value="command">命令</option>
      </select>
      <input value={draft.target} onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))} placeholder={draft.type === "url" ? "https://example.com" : draft.type === "command" ? "notepad.exe" : "C:\\路径\\应用.exe 或 .lnk"} aria-label="目标路径" />
      {draft.type !== "url" && <input value={draft.arguments} onChange={(event) => setDraft((current) => ({ ...current, arguments: event.target.value }))} placeholder="启动参数（可选）" aria-label="启动参数" />}
      <button type="submit">添加应用</button>
    </form>
    <small>自定义图标按 data URL 嵌入配置，导出后可随 applications.json 搬到其他电脑。</small>
  </div>;
}

function ManagedApplication({ app, index, count, onUpdate, onMove, onDelete, onSelectIcon }: {
  app: ApplicationItem;
  index: number;
  count: number;
  onUpdate: (id: string, patch: Partial<ApplicationItem>) => Promise<boolean>;
  onMove: (id: string, offset: number) => void;
  onDelete: () => void;
  onSelectIcon: () => void;
}) {
  const [name, setName] = useState(app.name);
  const [target, setTarget] = useState(app.target);
  const [argumentsValue, setArgumentsValue] = useState(app.arguments ?? "");
  const [type, setType] = useState<ApplicationType>(app.type);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setName(app.name);
    setTarget(app.target);
    setArgumentsValue(app.arguments ?? "");
    setType(app.type);
  }, [app.name, app.target, app.arguments, app.type]);
  const save = async () => { if (await onUpdate(app.id, { name: name.trim() || app.name, target: target.trim(), arguments: argumentsValue.trim() || undefined, type })) setEditing(false); };
  return <div className="managed-app-row">
    <AppGlyph application={app} />
    <div className="managed-app-fields">
      {editing ? <>
        <input value={name} onChange={(event) => setName(event.target.value)} aria-label={`${app.name} 名称`} />
        <select value={type} onChange={(event) => setType(event.target.value as ApplicationType)} aria-label={`${app.name} 类型`}><option value="exe">程序</option><option value="shortcut">快捷方式</option><option value="url">网址</option><option value="command">命令</option></select>
        <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="目标路径" aria-label={`${app.name} 目标路径`} />
        {type !== "url" && <input value={argumentsValue} onChange={(event) => setArgumentsValue(event.target.value)} placeholder="启动参数（可选）" aria-label={`${app.name} 启动参数`} />}
      </> : <><b>{app.name}</b><small>{app.target || "尚未配置目标路径"}</small></>}
      <div className="managed-app-controls">
        <label><input type="checkbox" checked={app.pinned} onChange={(event) => onUpdate(app.id, { pinned: event.target.checked })} />固定</label>
        <button disabled={index === 0} title="上移" onClick={() => onMove(app.id, -1)}>↑</button><button disabled={index === count - 1} title="下移" onClick={() => onMove(app.id, 1)}>↓</button>
        <button onClick={onSelectIcon}>图标</button>
        {editing ? <button onClick={save}>保存</button> : <button onClick={() => setEditing(true)}>编辑</button>}
        <button className="danger-action" onClick={onDelete}>删除</button>
      </div>
    </div>
  </div>;
}
