import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { mockIPC, mockWindows, clearMocks } from "@tauri-apps/api/mocks";
import { isWindowVisible, startNativeWindowVisibility, subscribeWindowVisibility,requestAppExit } from "../src/services/windowVisibility";
import { startPassthroughEscape } from "../src/tauri";
import { defaultSettings, loadSettings, saveSettings } from "../src/providers/settingsStore";

test("退出使用页面确认状态，禁止WebView确认框；取消零调用，确认一次，失败上报",async()=>{
 const beforeWindow=Object.getOwnPropertyDescriptor(globalThis,"window"),beforeTauri=Object.getOwnPropertyDescriptor(globalThis,"isTauri");
 let fail=false;const calls:{command:string;payload:unknown}[]=[];
 Object.defineProperty(globalThis,"window",{configurable:true,value:{confirm:()=>{throw Error("不得调用被裁剪的 WebView confirm");}}});
 Object.defineProperty(globalThis,"isTauri",{configurable:true,value:true});
 mockIPC((command,payload)=>{calls.push({command,payload});if(fail)throw Error("exit failed");return null;});
 try{assert.equal(await requestAppExit(false),false);assert.equal(calls.length,0);assert.equal(await requestAppExit(true),true);assert.deepEqual(calls,[{command:"quit_app",payload:{confirmed:true}}]);fail=true;await assert.rejects(requestAppExit(true));}
 finally{clearMocks();if(beforeWindow)Object.defineProperty(globalThis,"window",beforeWindow);else Reflect.deleteProperty(globalThis,"window");if(beforeTauri)Object.defineProperty(globalThis,"isTauri",beforeTauri);else Reflect.deleteProperty(globalThis,"isTauri");}
});

test("native visibility listens on this window and removes its subscription on cleanup", async () => {
  const host = Object.assign(new EventTarget(), { crypto: webcrypto });
  Object.defineProperty(globalThis, "window", { value: host, configurable: true });
  Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
  Object.defineProperty(globalThis, "document", { value: Object.assign(new EventTarget(), { visibilityState: "visible" }), configurable: true });
  mockWindows("dashboard");
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  let callbackId = 0;
  mockIPC((command, payload) => {
    calls.push({ command, payload: payload as Record<string, unknown> });
    if (command === "plugin:event|listen") { callbackId = (payload as { handler: number }).handler; return callbackId; }
    if (command === "window_visible") return false;
    return null;
  });
  let changes = 0;
  const unsubscribe = subscribeWindowVisibility(() => { changes++; });
  const stop = startNativeWindowVisibility();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls.find((call) => call.command === "plugin:event|listen")?.payload.target, { kind: "Window", label: "dashboard" });
  assert.equal(isWindowVisible(), false);
  const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback(id: number, payload: unknown): void } }).__TAURI_INTERNALS__;
  internals.runCallback(callbackId, { event: "window-visibility-changed", payload: true });
  assert.equal(isWindowVisible(), true);
  assert.equal(changes, 2);
  stop(); unsubscribe();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(calls.some((call) => call.command === "plugin:event|unlisten"));
  clearMocks();
  Reflect.deleteProperty(globalThis, "isTauri");
});

test("native passthrough escape updates saved preference without changing other settings", async () => {
  const host = Object.assign(new EventTarget(), { crypto: webcrypto });
  Object.defineProperty(globalThis, "window", { value: host, configurable: true });
  Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
  } });
  mockWindows("dashboard");
  const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
  let callbackId = 0;
  mockIPC((command, payload) => {
    calls.push({ command, payload: payload as Record<string, unknown> });
    if (command === "plugin:event|listen") { callbackId = (payload as { handler: number }).handler; return callbackId; }
    return null;
  });
  saveSettings({ ...defaultSettings, mousePassthrough: true, desktopMode: true, blur: 19 });
  const stop = startPassthroughEscape(() => saveSettings({ ...loadSettings(), mousePassthrough: false }));
  await new Promise(resolve => setTimeout(resolve, 0));
  const listener = calls.find(call => call.command === "plugin:event|listen");
  assert.equal(listener?.payload.event, "mouse-passthrough-disabled");
  assert.deepEqual(listener?.payload.target, { kind: "Window", label: "dashboard" });
  const internals = (window as unknown as { __TAURI_INTERNALS__: { runCallback(id: number, payload: unknown): void } }).__TAURI_INTERNALS__;
  internals.runCallback(callbackId, { event: "mouse-passthrough-disabled", payload: null });
  assert.equal(loadSettings().mousePassthrough, false);
  assert.equal(loadSettings().desktopMode, true);
  assert.equal(loadSettings().blur, 19);
  stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(calls.some(call => call.command === "plugin:event|unlisten"));
  clearMocks();
  Reflect.deleteProperty(globalThis, "isTauri");
});
