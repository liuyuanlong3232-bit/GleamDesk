import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MonitorInfo, WallpaperProfile } from "./types";
import type { ProviderRequestDiagnostics } from "./ports/providerDiagnostics";

export async function readMonitors(): Promise<MonitorInfo[]> {
  if (!isTauri()) {
    return [
      { id: "primary-preview", name: "主屏", x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: true },
      { id: "secondary-preview", name: "副屏（预览）", x: 1920, y: 0, width: 1920, height: 1080, scaleFactor: 1, isPrimary: false },
    ];
  }
  return invoke<MonitorInfo[]>("list_monitors");
}

export async function openDashboardWindow(primary?: boolean) {
  if (isTauri()) return invoke<void>("open_dashboard", { primary });
}

export async function showMainWindow() {
  return invoke<void>("show_main");
}

export async function restoreWindows() {
  if (isTauri()) return invoke<void>("restore_windows");
}

export async function setDesktopMode(enabled: boolean) {
  if (isTauri()) return invoke<void>("set_desktop_mode", { enabled });
}

export async function setMousePassthrough(enabled: boolean) {
  if (isTauri()) return invoke<void>("set_mouse_passthrough", { enabled });
}

export function startPassthroughEscape(onEscape: () => void) {
  if (!isTauri()) return () => {};
  let active = true;
  let unlisten: (() => void) | undefined;
  void getCurrentWindow().listen("mouse-passthrough-disabled", () => {
    if (active) onEscape();
  }).then((stop) => {
    if (!active) { stop(); return; }
    unlisten = stop;
  }).catch(() => {});
  return () => { active = false; unlisten?.(); };
}

export type MainWindowHitRegion = { x: number; y: number; width: number; height: number };

export function measureMainWindowHitRegions(): MainWindowHitRegion[] {
  const root = document.querySelector<HTMLElement>(".main-screen");
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-main-hit-region]")).flatMap((element) => {
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
    return [{ x: rect.left, y: rect.top, width: rect.width, height: rect.height }];
  });
}

export async function updateMainWindowHitRegions() {
  if (!isTauri()) return;
  const regions = measureMainWindowHitRegions();
  if (regions.length) await invoke<void>("set_main_window_hit_regions", { regions });
}

export function startMainWindowHitRegionTracking() {
  if (!isTauri()) return () => {};
  const root = document.querySelector<HTMLElement>(".main-screen");
  if (!root) return () => {};
  let frame = 0;
  let hudMotionUntil = 0;
  const publish = () => {
    frame = 0;
    const regions = measureMainWindowHitRegions();
    if (regions.length) void invoke("set_main_window_hit_regions", { regions }).catch(() => {});
    if (performance.now() < hudMotionUntil) schedule();
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(publish);
  };
  const resizeObserver = new ResizeObserver(schedule);
  const observeRegions = () => {
    resizeObserver.disconnect();
    root.querySelectorAll<HTMLElement>("[data-main-hit-region]").forEach((element) => resizeObserver.observe(element));
  };
  const mutationObserver = new MutationObserver(() => { observeRegions(); schedule(); });
  mutationObserver.observe(root, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style", "data-main-hit-region"] });
  observeRegions();
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  const hudMotion=(event:AnimationEvent)=>{if(event.target instanceof HTMLElement&&event.target.classList.contains("island-popover")){hudMotionUntil=performance.now()+450;schedule()}};
  root.addEventListener("animationstart",hudMotion);
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    root.removeEventListener("animationstart",hudMotion);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
  };
}

export function measureDockWindowHitRegions(): MainWindowHitRegion[] {
  const root = document.querySelector<HTMLElement>(".dock-surface");
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>("[data-dock-hit-region]")).flatMap((element) => {
    // Native window regions clip painting as well as mouse input. Measure the
    // complete glass surface, including its glow, and keep both fade surfaces.
    for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.display === "none" || style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) return [];
    }
    const rect = element.getBoundingClientRect();
    if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return [];
    const padding = 6;
    return [{ x: rect.left - padding, y: rect.top - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 }];
  });
}

export function startDockWindowHitRegionTracking() {
  if (!isTauri()) return () => {};
  const root = document.querySelector<HTMLElement>(".dock-surface");
  if (!root) return () => {};
  let frame = 0;
  let trackUntil = 0;
  let lastRegions = "";
  const publish = () => {
    frame = 0;
    const regions = measureDockWindowHitRegions();
    const signature = JSON.stringify(regions);
    if (regions.length && signature !== lastRegions) {
      lastRegions = signature;
      void invoke("set_dock_window_hit_regions", { regions }).catch(() => { lastRegions = ""; });
    }
    // Transforms do not trigger ResizeObserver: follow the bounded 280ms fade
    // and sample the final frame instead of retaining an intermediate crop.
    if (performance.now() < trackUntil) frame = requestAnimationFrame(publish);
  };
  const schedule = () => {
    trackUntil = performance.now() + 350;
    if (!frame) frame = requestAnimationFrame(publish);
  };
  const resizeObserver = new ResizeObserver(schedule);
  const observeRegions = () => {
    resizeObserver.disconnect();
    root.querySelectorAll<HTMLElement>("[data-dock-hit-region]").forEach((element) => resizeObserver.observe(element));
  };
  const mutationObserver = new MutationObserver(() => { observeRegions(); schedule(); });
  mutationObserver.observe(root, { attributes: true, childList: true, subtree: true, attributeFilter: ["class", "style", "data-dock-hit-region"] });
  observeRegions();
  root.addEventListener("transitionrun", schedule);
  root.addEventListener("transitionend", schedule);
  root.addEventListener("transitioncancel", schedule);
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  schedule();
  return () => {
    if (frame) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    mutationObserver.disconnect();
    root.removeEventListener("transitionrun", schedule);
    root.removeEventListener("transitionend", schedule);
    root.removeEventListener("transitioncancel", schedule);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
  };
}
export async function applyStartupPreferences(preferences: {
  mode: string;
  showMain: boolean;
  showDashboard: boolean;
  desktopMode: boolean;
}) {
  if (isTauri()) return invoke<void>("apply_startup_preferences", preferences);
}

export async function readWallpaperProfile(): Promise<WallpaperProfile> {
  if (!isTauri()) return { path: null, luminance: null, profile: "unknown" };
  return invoke<WallpaperProfile>("read_wallpaper_profile");
}

export async function readRuntimeStatus(): Promise<string> {
  if (!isTauri()) return "浏览器预览环境";
  return invoke<string>("runtime_status");
}
export async function readProviderRequestDiagnostics(): Promise<ProviderRequestDiagnostics | null> {
  if (!isTauri()) return null;
  return invoke<ProviderRequestDiagnostics>("provider_request_diagnostics");
}

export { isTauri };
