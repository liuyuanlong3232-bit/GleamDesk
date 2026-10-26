import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

let nativeVisible = true;
const listeners = new Set<() => void>();
export async function requestAppExit(confirmed=false):Promise<boolean>{
  if(!confirmed)return false;
  if(!isTauri())throw Error("退出程序需要 Windows 桌面版");
  await invoke("quit_app",{confirmed:true});
  return true;
}
export function isWindowVisible() { return nativeVisible && document.visibilityState === "visible"; }
function update(visible: boolean) {
  if (nativeVisible === visible) return;
  nativeVisible = visible;
  listeners.forEach((listener) => listener());
}
export function subscribeWindowVisibility(listener: () => void) {
  listeners.add(listener);
  document.addEventListener("visibilitychange", listener);
  return () => { listeners.delete(listener); document.removeEventListener("visibilitychange", listener); };
}
export function startNativeWindowVisibility() {
  if (!isTauri()) return () => {};
  let active = true;
  let unlisten: (() => void) | undefined;
  let revision = 0;
  void getCurrentWindow().listen<boolean>("window-visibility-changed", (event) => {
    revision += 1;
    if (active) update(event.payload);
  }).then(async (stop) => {
    if (!active) { stop(); return; }
    unlisten = stop;
    const beforeRead = revision;
    const visible = await invoke<boolean>("window_visible");
    if (active && beforeRead === revision) update(visible);
  }).catch(() => {});
  return () => { active = false; unlisten?.(); };
}
