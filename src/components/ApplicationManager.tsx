import { useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationItem, ScannedApplication } from "../types";
import { mergeDroppedApplications, applicationTargetsEqual, normalizeApplicationName, applicationsFromPaths } from "../services/launcher/dockIngress";
import { discoverApplications } from "../services/launcher/appScanner";
import { AppGlyph } from "./ApplicationDock";

interface ApplicationManagerProps {
  applications: ApplicationItem[];
  onApplicationsChange: (next: ApplicationItem[] | ((current: ApplicationItem[]) => ApplicationItem[])) => void | Promise<void>;
}

// 应用库只展示当前在 Dock 上的应用；不再内嵌编辑、导入导出或手动添加入口。
export function ApplicationManager({ applications, onApplicationsChange }: ApplicationManagerProps) {
  const [scanned, setScanned] = useState<ScannedApplication[]>([]);
  const [visibleScanCount, setVisibleScanCount] = useState(40);
  const [scanning, setScanning] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [message, setMessage] = useState("");
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
      setMessage(result.length ? `扫描完成，发现 ${result.length} 个入口。` : "没有发现快捷方式或程序。");
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
    if (!isTauri()) { setMessage("请在桌面应用中使用选择器。"); return; }
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

  const pinned = applications.filter((app) => app.pinned).sort((left, right) => left.order - right.order);

  return <div className="application-manager app-library">
    <div className="application-manager-heading"><strong>应用库</strong><span>{pinned.length} 个在 Dock</span></div>

    <div className="app-library-toolbar">
      <button onClick={() => void scan()} disabled={scanning}>{scanning ? "扫描中…" : "扫描已安装应用"}</button>
      <button onClick={() => void selectApplication()} disabled={selecting}>{selecting ? "读取中…" : "添加程序"}</button>
    </div>
    <small className="app-library-hint">拖动桌面或开始菜单的快捷方式到 Dock 即可添加；Dock 里右键可更换图标或移除。</small>
    {message && <small className="application-manager-message" role="status">{message}</small>}

    {pinned.length === 0
      ? <small>Dock 上还没有应用。扫描已安装应用，或直接把快捷方式拖到 Dock。</small>
      : <div className="app-library-grid">
        {pinned.map((app) => <button key={app.id} type="button" title={app.name} aria-pressed="true"
          className="app-library-card is-pinned"
          onClick={() => { void persist((current) => current.map((item) => item.id === app.id ? { ...item, pinned: false } : item)); }}>
          <AppGlyph application={app} />
          <span>{app.name}</span>
        </button>)}
      </div>}

    {scanned.length > 0 && <div className="app-library-scan">
      <strong className="application-list-title">扫描发现</strong>
      <div className="app-library-grid">
        {scanned.slice(0, visibleScanCount).map((app) => {
          const added = applications.some(candidate => applicationTargetsEqual(candidate, { ...app, pinned: true, order: 0 }));
          const fillsExisting = applications.some(candidate => !candidate.target.trim() && Boolean(normalizeApplicationName(app.name)) && normalizeApplicationName(candidate.name) === normalizeApplicationName(app.name));
          return <button key={app.id} type="button" title={app.name} disabled={added} className="app-library-card is-scan" onClick={() => void addScanned(app)}>
            <span className="app-library-glyph">{app.name.slice(0, 1).toUpperCase()}</span>
            <span>{app.name}</span>
            <i className="app-library-badge">{added ? "已添加" : fillsExisting ? "补全" : "+"}</i>
          </button>;
        })}
      </div>
      {scanned.length > visibleScanCount && <button className="show-more-apps" onClick={() => setVisibleScanCount((count) => Math.min(scanned.length, count + 40))}>再显示 40 项（剩余 {scanned.length - visibleScanCount}）</button>}
    </div>}
  </div>;
}
