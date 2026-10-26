import assert from "node:assert/strict";
import { test } from "node:test";
import { toProviderDiagnostic, type Provider } from "../src/providers/contracts";
import { createProviderRuntime, type ProviderCache, type ProviderLock } from "../src/providers/providerRuntime";

function memoryCache(): ProviderCache {
  const values = new Map<string, string>();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => { values.set(key, value); },
  };
}

function sharedLock(): ProviderLock {
  let active = false;
  const waiting: Array<() => void> = [];
  return async (_name, run) => {
    if (active) await new Promise<void>((resolve) => waiting.push(resolve));
    active = true;
    try {
      return await run();
    } finally {
      active = false;
      waiting.shift()?.();
    }
  };
}

function sampleProvider(load: Provider<{ value: number }> ["load"]): Provider<{ value: number }> {
  return { id: "sample", name: "Sample Provider", kind: "system", refreshIntervalMs: 60_000, load };
}

test("domain cache version six does not reuse legacy presentation or quota text payloads", async () => {
  const cache = memoryCache();
  const legacyKey = "codex-desktop.provider.v3:sample%3Adefault";
  const legacy = JSON.stringify({ expiresAt: 50_000, snapshot: { providerId: "sample", status: "normal", data: { value: 99, notices: [] },
    lastUpdated: new Date(5_000).toISOString(), lastSuccessAt: new Date(5_000).toISOString() } });
  cache.set(legacyKey, legacy);
  const previousDomainKey = "codex-desktop.provider.v4:sample%3Adefault";
  cache.set(previousDomainKey, legacy);
  const previousQuotaKey = "codex-desktop.provider.v5:sample%3Adefault";
  cache.set(previousQuotaKey, legacy);
  let loads = 0;
  const provider = sampleProvider(async () => { loads += 1; return { status: "normal", data: { value: 2 } }; });
  const runtime = createProviderRuntime({ cache, now: () => 10_000 });
  const result = await runtime.refresh(provider);
  assert.equal(loads, 1);
  assert.deepEqual(result.data, { value: 2 });
  assert.equal(cache.get(legacyKey), legacy);
  assert.equal(cache.get(previousDomainKey), legacy);
  assert.equal(cache.get(previousQuotaKey), legacy);
  assert.ok(cache.get("codex-desktop.provider.v6:sample%3Adefault"));
});

test("provider success retains the actual observation time of a native cached result", async () => {
  const observedAt = new Date(8_000).toISOString();
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => 10_000 });
  const snapshot = await runtime.refresh(sampleProvider(async () => ({ status: "normal", data: { value: 4 }, observedAt })));
  assert.equal(snapshot.lastUpdated, new Date(10_000).toISOString());
  assert.equal(snapshot.lastSuccessAt, observedAt);
});

test("a first failed refresh can restore confirmed history only as stale data", async () => {
  const observedAt = new Date(5_000).toISOString();
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => 10_000 });
  const snapshot = await runtime.refresh(sampleProvider(async () => ({ status: "unavailable", data: { value: 4 },
    error: "connection failed", observedAt, retained: true, retryable: false })));
  assert.equal(snapshot.status, "stale");
  assert.equal(snapshot.lastSuccessAt, observedAt);
  assert.equal(snapshot.lastUpdated, new Date(10_000).toISOString());
  assert.deepEqual(snapshot.data, { value: 4 });
});

test("a failed refresh cannot replace newer cached data with older restored history", async () => {
  let timestamp = 10_000, fails = false;
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => timestamp });
  const provider = sampleProvider(async () => fails ? { status: "unavailable", data: { value: 1 },
    observedAt: new Date(5_000).toISOString(), retained: true, retryable: false } : { status: "normal", data: { value: 2 }, observedAt: new Date(8_000).toISOString() });
  await runtime.refresh(provider);
  timestamp += 60_000; fails = true;
  const failed = await runtime.refresh(provider);
  assert.equal(failed.status, "stale");
  assert.deepEqual(failed.data, { value: 2 });
  assert.equal(failed.lastSuccessAt, new Date(8_000).toISOString());
});

test("invalid observation times and retained values claiming success fail explicitly", async () => {
  for (const metadata of [{ observedAt: "invalid" }, { observedAt: new Date(100_000).toISOString() }, { retained: true }]) {
    const runtime = createProviderRuntime({ cache: memoryCache(), now: () => 10_000 });
    const snapshot = await runtime.refresh(sampleProvider(async () => ({ status: "normal", data: { value: 4 }, ...metadata })));
    assert.equal(snapshot.status, "error");
    assert.equal(snapshot.lastSuccessAt, null);
    assert.equal(snapshot.retryable, false);
  }
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => 10_000 });
  const unavailable = await runtime.refresh(sampleProvider(async () => ({ status: "unavailable", data: { value: 0 }, observedAt: new Date(9_000).toISOString(), retryable: false })));
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.lastSuccessAt, null, "a newly observed unavailable DTO is not a prior success");
});

test("separate window runtimes share one provider result and avoid duplicate loads", async () => {
  const cache = memoryCache();
  const lock = sharedLock();
  let calls = 0;
  const provider = sampleProvider(async () => {
    calls += 1;
    await Promise.resolve();
    return { status: "normal", data: { value: 7 } };
  });
  const firstWindow = createProviderRuntime({ cache, lock });
  const secondWindow = createProviderRuntime({ cache, lock });

  const [left, right] = await Promise.all([firstWindow.refresh(provider), secondWindow.refresh(provider)]);
  assert.equal(calls, 1);
  assert.deepEqual(left.data, { value: 7 });
  assert.deepEqual(right.data, { value: 7 });
});

test("provider runtime retries transient failures and publishes a normal snapshot", async () => {
  let calls = 0;
  const provider = sampleProvider(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return { status: "normal", data: { value: 3 } };
  });
  provider.retryPolicy = { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache: memoryCache(), wait: async () => undefined });

  const snapshot = await runtime.refresh(provider);
  assert.equal(calls, 2);
  assert.equal(snapshot.status, "normal");
  assert.deepEqual(snapshot.data, { value: 3 });
  assert.ok(snapshot.lastSuccessAt);
});

test("cache load time does not skip every second scheduled sampling tick", async () => {
  let timestamp = 10_000;
  let calls = 0;
  const provider = sampleProvider(async () => {
    calls += 1;
    timestamp += 150;
    return { status: "normal", data: { value: calls } };
  });
  provider.refreshIntervalMs = 2_000;
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => timestamp });
  await runtime.refresh(provider);
  timestamp = 10_300;
  await runtime.refresh(provider);
  assert.equal(calls, 1);
  timestamp = 11_950; // A timer can run slightly before the nominal cache boundary.
  assert.deepEqual((await runtime.refresh(provider)).data, { value: 2 });
  timestamp = 14_000;
  assert.deepEqual((await runtime.refresh(provider)).data, { value: 3 });
});

test("provider runtime marks retained successful data stale after a later failure", async () => {
  let timestamp = 10_000;
  let shouldFail = false;
  const provider = sampleProvider(async () => {
    if (shouldFail) throw new Error("offline now");
    return { status: "normal", data: { value: 9 } };
  });
  provider.retryPolicy = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache: memoryCache(), now: () => timestamp });
  const initial = await runtime.refresh(provider);
  timestamp += 60_001;
  shouldFail = true;

  const stale = await runtime.refresh(provider);
  assert.equal(initial.status, "normal");
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.data, { value: 9 });
  assert.match(stale.error ?? "", /offline now/);
  assert.equal(stale.lastSuccessAt, initial.lastSuccessAt);
});

test("three refresh failures open a cooldown without changing confirmed data or observation time", async () => {
  let timestamp = 10_000, calls = 0;
  const cache = memoryCache();
  const provider = sampleProvider(async () => {
    calls += 1;
    if (calls === 1) return { status: "normal", data: { value: 8 } };
    throw new Error(`offline ${calls}`);
  });
  provider.retryPolicy = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache, now: () => timestamp });
  const initial = await runtime.refresh(provider);
  timestamp += 60_001;
  let lastFailure: Awaited<ReturnType<typeof runtime.refresh>> | undefined;
  for (let failure = 1; failure <= 3; failure += 1) {
    timestamp += 1_001;
    const snapshot = await runtime.refresh(provider);
    assert.equal(snapshot.status, "stale");
    assert.deepEqual(snapshot.data, { value: 8 });
    assert.equal(snapshot.lastSuccessAt, initial.lastSuccessAt);
    lastFailure = snapshot;
  }
  const cooldownUntil = new Date(timestamp + 60_000).toISOString();
  timestamp += 10_000;
  const held = await runtime.refresh(provider);
  assert.equal(calls, 4);
  assert.equal(held.status, "stale");
  assert.match(held.error ?? "", /暂停刷新至/);
  assert.equal(held.retryAt, cooldownUntil);
  assert.equal(held.lastSuccessAt, initial.lastSuccessAt);
  assert.equal(held.lastUpdated, lastFailure?.lastUpdated);
  timestamp += 5_000;
  const heldAgain = await runtime.refresh(provider);
  assert.equal(calls, 4);
  assert.equal(heldAgain.lastUpdated, lastFailure?.lastUpdated);
  assert.equal(heldAgain.lastSuccessAt, initial.lastSuccessAt);
  assert.deepEqual(heldAgain.data, { value: 8 });
});

test("cooldown recovery success clears the cached count before the next failure", async () => {
  let timestamp = 1_000, calls = 0;
  const cache = memoryCache();
  const provider = sampleProvider(async () => {
    calls += 1;
    if (calls <= 3) throw new Error("offline");
    if (calls === 4) return { status: "normal", data: { value: 5 } };
    throw new Error("one failure after recovery");
  });
  provider.retryPolicy = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache, now: () => timestamp });
  for (let failure = 0; failure < 3; failure += 1) {
    await runtime.refresh(provider);
    timestamp += 1_001;
  }
  const cooling = await runtime.refresh(provider);
  assert.equal(cooling.retryAt, new Date(timestamp - 1_001 + 60_000).toISOString());
  timestamp = Date.parse(cooling.retryAt!);
  const recovered = await runtime.refresh(provider);
  assert.equal(calls, 4);
  assert.equal(recovered.status, "normal");
  const cacheKey = "codex-desktop.provider.v6:sample%3Adefault";
  assert.equal(JSON.parse(cache.get(cacheKey)!).failureCount, undefined, "success removes the old failure count");
  timestamp += 60_001;
  const nextFailure = await runtime.refresh(provider);
  const envelope = JSON.parse(cache.get(cacheKey)!);
  assert.equal(calls, 5);
  assert.equal(nextFailure.status, "stale");
  assert.equal(envelope.failureCount, 1);
  assert.equal(envelope.cooldownUntil, undefined, "one later failure does not immediately reopen the breaker");
});

test("a non-retryable result clears breaker state without scheduling a retry", async () => {
  const cache = memoryCache();
  let calls = 0;
  const cacheKey = "codex-desktop.provider.v6:sample%3Adefault";
  cache.set(cacheKey, JSON.stringify({
    expiresAt: 0,
    failureCount: 2,
    snapshot: { providerId: "sample", status: "error", data: null, lastUpdated: new Date(1_000).toISOString(), lastSuccessAt: null, error: "failed", retryable: true },
  }));
  const provider = sampleProvider(async () => {
    calls += 1;
    return { status: "unavailable", data: null, error: "not configured", retryable: false };
  });
  provider.retryPolicy = { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache, now: () => 2_000 });

  const result = await runtime.refresh(provider);
  const envelope = JSON.parse(cache.get(cacheKey)!);
  assert.equal(result.status, "unavailable");
  assert.equal(result.retryAt, undefined);
  assert.equal(calls, 1, "unavailable is not retried or counted as a breaker failure");
  assert.equal(envelope.failureCount, undefined);
  assert.equal(envelope.cooldownUntil, undefined);
});

test("error results with retryable false count toward cooldown without retrying a load", async () => {
  let timestamp = 5_000, calls = 0;
  const cache = memoryCache();
  const cacheKey = "codex-desktop.provider.v6:sample%3Adefault";
  const provider = sampleProvider(async () => {
    calls += 1;
    return { status: "error", data: null, error: "local read failed", retryable: false };
  });
  provider.retryPolicy = { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache, now: () => timestamp, wait: async () => undefined });

  for (let failure = 1; failure <= 3; failure += 1) {
    const result = await runtime.refresh(provider);
    assert.equal(result.status, "error");
    assert.equal(calls, failure, "retryable:false keeps each refresh to one provider.load call");
    assert.equal(JSON.parse(cache.get(cacheKey)!).failureCount, failure);
    if (failure < 3) timestamp += 60_001;
  }

  const cooling = await runtime.refresh(provider);
  assert.equal(calls, 3);
  assert.equal(cooling.retryable, false, "cooldown does not relabel the error as retryable");
  assert.ok(cooling.retryAt);
  const heldAt = cooling.lastUpdated;
  timestamp += 5_000;
  const heldAgain = await runtime.refresh(provider);
  assert.equal(calls, 3);
  assert.equal(heldAgain.retryAt, cooling.retryAt);
  assert.equal(heldAgain.lastUpdated, heldAt);
  assert.equal(heldAgain.retryable, false);
});

test("shared runtimes serialize one half-open attempt and cacheKey identities stay isolated", async () => {
  let timestamp = 2_000, firstCalls = 0, secondCalls = 0;
  const cache = memoryCache();
  const first = sampleProvider(async () => { firstCalls += 1; throw new Error("first offline"); });
  first.retryPolicy = { maxRetries: 1, initialDelayMs: 0, maxDelayMs: 0 };
  const second = { ...first, cacheKey: "other-config", load: async () => {
    secondCalls += 1;
    return { status: "normal" as const, data: { value: 2 } };
  } };
  const lock = sharedLock();
  const runtime = createProviderRuntime({ cache, lock, now: () => timestamp });
  const otherRuntime = createProviderRuntime({ cache, lock, now: () => timestamp });
  for (let failure = 0; failure < 3; failure += 1) {
    await runtime.refresh(first);
    timestamp += 1_001;
  }
  const firstCooling = await runtime.refresh(first);
  assert.equal(firstCalls, 6, "normal refreshes keep the configured single retry");
  assert.equal((await otherRuntime.refresh(first)).lastUpdated, firstCooling.lastUpdated);
  assert.equal(firstCalls, 6, "the other runtime reads the shared cooldown without loading");
  timestamp = Date.parse(firstCooling.retryAt!);
  const [failedRecovery, joinedRecovery] = await Promise.all([runtime.refresh(first), otherRuntime.refresh(first)]);
  assert.equal(firstCalls, 7, "half-open recovery is limited to one load even with maxRetries=1");
  assert.equal(failedRecovery.retryAt, new Date(timestamp + 60_000).toISOString());
  assert.equal(joinedRecovery.retryAt, failedRecovery.retryAt);
  assert.equal((await runtime.refresh(second)).status, "normal");
  assert.equal(secondCalls, 1);
  assert.equal(firstCalls, 7, "a different cacheKey does not alter the first provider cooldown");
});

test("provider timeouts abort the load and return a bounded error snapshot", async () => {
  let aborted = false;
  const provider = sampleProvider((_signal) => new Promise((_, reject) => {
    _signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  }));
  provider.timeoutMs = 250;
  provider.retryPolicy = { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0 };
  const runtime = createProviderRuntime({ cache: memoryCache() });

  const snapshot = await runtime.refresh(provider);
  assert.equal(aborted, true);
  assert.equal(snapshot.status, "error");
  assert.match(snapshot.error ?? "", /超过采样时限/);
});

test("Beszel cooldown retains a safe cause across windows without new loads or changed timestamps", async () => {
  let timestamp = 1_000, calls = 0, healthy = true;
  const cache = memoryCache();
  const provider = { ...sampleProvider(async () => {
    calls += 1;
    return healthy ? { status: "normal" as const, data: { value: 9 } }
      : { status: "error" as const, data: null, error: "Beszel API 令牌无效或无权读取该系统", retryable: false };
  }), id: "vps-status", name: "Beszel VPS 状态", retryPolicy: { maxRetries: 0 } };
  const runtime = createProviderRuntime({ cache, now: () => timestamp });
  const initial = await runtime.refresh(provider);
  healthy = false; timestamp += 60_001;
  for (let i = 0; i < 3; i += 1) { await runtime.refresh(provider); timestamp += 60_001; }
  // The third failure starts a 60s cooldown; move back inside that interval.
  timestamp -= 50_000;
  const lastFailure = JSON.parse(cache.get("codex-desktop.provider.v6:vps-status%3Adefault")!).snapshot;
  const secondWindow = createProviderRuntime({ cache, now: () => timestamp });
  const held = await secondWindow.refresh(provider);
  const heldAgain = await runtime.refresh(provider, true);
  assert.equal(calls, 4);
  assert.match(held.error!, /^Beszel API 令牌无效或无权读取该系统；连续读取失败，暂停刷新至 /);
  assert.equal(heldAgain.error, held.error, "the cause is not duplicated on repeated reads");
  assert.equal(held.lastUpdated, lastFailure.lastUpdated);
  assert.equal(held.lastSuccessAt, initial.lastSuccessAt);
  assert.deepEqual(held.data, initial.data);
  assert.equal(toProviderDiagnostic(provider, held).error, held.error);
  timestamp = Date.parse(held.retryAt!); healthy = true;
  const recovered = await runtime.refresh(provider);
  assert.equal(recovered.status, "normal");
  assert.equal(recovered.error, undefined);
  assert.equal(JSON.parse(cache.get("codex-desktop.provider.v6:vps-status%3Adefault")!).failureReason, undefined);
});

test("Beszel legacy cooldown does not invent a cause or echo untrusted cached diagnostics", async () => {
  for (const reason of [undefined, "Bearer synthetic-secret https://private.invalid/?token=synthetic-secret"]) {
    const cache = memoryCache(); let calls = 0;
    cache.set("codex-desktop.provider.v6:vps-status%3Adefault", JSON.stringify({ expiresAt: 60_000, cooldownUntil: 60_000,
      failureReason: reason, snapshot: { providerId: "vps-status", status: "error", data: null, lastUpdated: new Date(1_000).toISOString(),
        lastSuccessAt: null, error: "连续读取失败，暂停刷新至 old" } }));
    const provider = { ...sampleProvider(async () => { calls += 1; throw Error("unexpected load"); }), id: "vps-status" };
    const result = await createProviderRuntime({ cache, now: () => 10_000 }).refresh(provider);
    assert.equal(calls, 0);
    assert.match(result.error!, reason === undefined ? /上次失败原因未保留，等待自然重试/ : /详细原因未识别/);
    assert.doesNotMatch(result.error!, /synthetic-secret|private.invalid/);
    assert.doesNotMatch(cache.get("codex-desktop.provider.v6:vps-status%3Adefault")!, /synthetic-secret|private.invalid/);
  }
});

test("unexpected Beszel thrown errors are sanitized before caching", async () => {
  const cache = memoryCache();
  const provider = { ...sampleProvider(async () => { throw Error("Bearer synthetic-secret body https://private.invalid"); }),
    id: "vps-status", retryPolicy: { maxRetries: 0 } };
  const result = await createProviderRuntime({ cache }).refresh(provider);
  assert.equal(result.error, "Beszel 读取失败，详细原因未识别");
  assert.doesNotMatch(cache.get("codex-desktop.provider.v6:vps-status%3Adefault")!, /synthetic-secret|private.invalid/);
});
