import { invoke, isTauri } from "@tauri-apps/api/core";
import type { ApplicationItem, ScannedApplication } from "../../types";

export interface LaunchResult {
  status: "launched" | "activated";
  processName?: string;
}

export async function scanApplications(): Promise<ScannedApplication[]> {
  if (!isTauri()) throw new Error("扫描 Windows 应用仅能在 AgentRoom 中进行。");
  return invoke<ScannedApplication[]>("scan_applications");
}

export async function launchApplication(application: ApplicationItem): Promise<LaunchResult> {
  if(["builtin-ollama","builtin-qwen","builtin-deepseek-local"].includes(application.id)&&application.target==="http://127.0.0.1:11434") {
    window.dispatchEvent(new CustomEvent("codex-desktop.local-ai-request",{detail:{id:application.id}}));
    return {status:"activated"};
  }
  const target = application.target.trim();
  if (!target) throw new Error("这个入口还没有配置路径，请在应用管理中扫描或填写目标。");
  if (application.type === "url" && !/^https?:\/\//i.test(target)) throw new Error("网址只支持 http 或 https 地址。");
  if (!isTauri()) {
    if (application.type !== "url") throw new Error("浏览器预览无法启动 Windows 程序，请在 AgentRoom 中打开。");
    window.open(target, "_blank", "noopener,noreferrer");
    return { status: "launched" };
  }
  return invoke<LaunchResult>("open_application", { application });
}

export async function revealApplication(application: ApplicationItem) {
  if (!isTauri()) throw new Error("浏览器预览无法打开 Windows 文件位置。");
  const target = application.sourcePath || application.target;
  return invoke<void>("reveal_application_target", { target });
}
