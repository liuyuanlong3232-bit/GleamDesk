import assert from "node:assert/strict";
import { test } from "node:test";
import type { Provider } from "../src/providers/contracts";
import { startProviderPolling, type PollingHost } from "../src/providers/pollingLifecycle";
import { createHardwareProvider } from "../src/providers/system/hardwareProvider";

test("native hardware polling stops while hidden and resumes on visibility", () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    const hardware = createHardwareProvider();
    assert.equal(hardware.refreshIntervalMs, 2_000);
    assert.equal(hardware.backgroundRefreshIntervalMs, null);
    let visible = true, nextId = 0, refreshes = 0;
    let changed: (() => void) | undefined;
    const timers = new Map<number, number>();
    const stop = startProviderPolling([hardware.id], [hardware], () => { refreshes++; }, {
      isVisible: () => visible,
      subscribeVisibility: listener => { changed = listener; return () => { changed = undefined; }; },
      setInterval: (_callback, milliseconds) => { const id = ++nextId; timers.set(id, milliseconds); return id; },
      clearInterval: id => { timers.delete(id); },
    });
    assert.deepEqual([...timers.values()], [2_000]);
    visible = false; changed?.();
    assert.equal(timers.size, 0); assert.equal(refreshes, 1);
    visible = true; changed?.();
    assert.deepEqual([...timers.values()], [2_000]); assert.equal(refreshes, 2);
    stop(); assert.equal(timers.size, 0);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

function provider(id: string, visible: number | null, hidden: number | null): Provider<{ value: number }> {
  return {
    id,
    name: id,
    kind: "system",
    refreshIntervalMs: visible,
    backgroundRefreshIntervalMs: hidden,
    load: async () => ({ status: "normal", data: { value: 1 } }),
  };
}

test("provider polling switches cadence on visibility and stops timers and listeners on cleanup", () => {
  let visible = true;
  let visibilityListener: (() => void) | undefined;
  let unsubscribeCount = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const refreshes: string[][] = [];
  const host: PollingHost = {
    isVisible: () => visible,
    subscribeVisibility: (listener) => {
      visibilityListener = listener;
      return () => { unsubscribeCount += 1; visibilityListener = undefined; };
    },
    setInterval: (callback, milliseconds) => {
      const id = ++nextTimerId;
      timers.set(id, { callback, milliseconds });
      return id;
    },
    clearInterval: (id) => { timers.delete(id); },
  };

  const stop = startProviderPolling(["system-health", "vps-status", "local-hardware"], [
    provider("windows-health", 60_000, null),
    provider("vps-status", 30_000, null),
    provider("local-hardware", 2_000, 15_000),
    provider("static-demo", null, null),
  ], (ids) => refreshes.push(ids), host);

  assert.deepEqual(refreshes, [["system-health", "vps-status", "local-hardware"]]);
  assert.deepEqual([...timers.values()].map((timer) => timer.milliseconds), [60_000, 30_000, 2_000]);
  [...timers.values()][0].callback();
  assert.deepEqual(refreshes[1], ["windows-health"]);

  visible = false;
  visibilityListener?.();
  assert.deepEqual([...timers.values()].map((timer) => timer.milliseconds), [15_000]);
  assert.equal(refreshes.length, 2, "hidden windows do not trigger an immediate refresh");

  visible = true;
  visibilityListener?.();
  assert.deepEqual(refreshes.at(-1), ["system-health", "vps-status", "local-hardware"]);
  assert.deepEqual([...timers.values()].map((timer) => timer.milliseconds), [60_000, 30_000, 2_000]);

  stop();
  assert.equal(timers.size, 0);
  assert.equal(unsubscribeCount, 1);
  assert.equal(visibilityListener, undefined);
});

test("an empty visible-widget selection schedules no provider work", () => {
  let timersCreated = 0;
  let refreshes = 0;
  const host: PollingHost = {
    isVisible: () => true,
    subscribeVisibility: () => () => undefined,
    setInterval: () => { timersCreated += 1; return timersCreated; },
    clearInterval: () => undefined,
  };
  startProviderPolling([], [], () => { refreshes += 1; }, host)();
  assert.equal(timersCreated, 0);
  assert.equal(refreshes, 0, "an empty request should not be issued");
});
