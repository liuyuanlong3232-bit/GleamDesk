import type { ProviderLoadResult, Provider, ProviderSnapshot, ProviderRetryPolicy } from "./contracts";
import { safeBeszelError } from "../domain/vps/contracts";

interface CacheEnvelope<T> {
  expiresAt: number;
  snapshot: ProviderSnapshot<T>;
  failureCount?: number;
  cooldownUntil?: number;
  failureReason?: string;
}

export interface ProviderCache {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export type ProviderLock = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface ProviderRuntimeOptions {
  cache?: ProviderCache;
  lock?: ProviderLock;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

const staticCacheMs = 24 * 60 * 60_000;
const defaultRetryPolicy: ProviderRetryPolicy = { maxRetries: 1, initialDelayMs: 750, maxDelayMs: 5_000 };

function browserCache(): ProviderCache | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return {
      get: (key) => window.localStorage.getItem(key),
      set: (key, value) => window.localStorage.setItem(key, value),
    };
  } catch {
    return undefined;
  }
}

const browserLock: ProviderLock = async (name, run) => {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(name, { mode: "exclusive" }, run);
  }
  return run();
};

function defaultWait(milliseconds: number) {
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function isStatus(value: unknown): value is ProviderSnapshot<unknown>["status"] {
  return value === "normal" || value === "degraded" || value === "stale" || value === "unavailable" || value === "error";
}

function readEnvelope<T>(cache: ProviderCache | undefined, key: string): CacheEnvelope<T> | undefined {
  if (!cache) return undefined;
  try {
    const raw = cache.get(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    if (typeof value.expiresAt !== "number" || !value.snapshot || !isStatus(value.snapshot.status)) return undefined;
    return {
      expiresAt: value.expiresAt,
      snapshot: value.snapshot as ProviderSnapshot<T>,
      failureCount: Number.isSafeInteger(value.failureCount) && (value.failureCount ?? -1) >= 0 ? value.failureCount : undefined,
      cooldownUntil: typeof value.cooldownUntil === "number" && Number.isFinite(value.cooldownUntil) && value.cooldownUntil >= 0 ? value.cooldownUntil : undefined,
      failureReason: typeof value.failureReason === "string" ? value.failureReason : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeEnvelope<T>(cache: ProviderCache | undefined, key: string, envelope: CacheEnvelope<T>) {
  if (!cache) return;
  try {
    cache.set(key, JSON.stringify(envelope));
  } catch {
    // Provider results remain usable when browser storage is unavailable or full.
  }
}

function isLoadResult<T>(value: unknown): value is ProviderLoadResult<T> {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ProviderLoadResult<T>>;
  return result.status === "normal" || result.status === "degraded" || result.status === "unavailable" || result.status === "error";
}

function createTimeoutError(providerName: string) {
  return new Error(`${providerName} 超过采样时限`);
}

function observationTime(value: unknown, now: number): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= 0 && timestamp <= now + 1_000 ? new Date(timestamp).toISOString() : null;
}

export function createProviderRuntime(options: ProviderRuntimeOptions = {}) {
  const cache = options.cache ?? browserCache();
  const lock = options.lock ?? browserLock;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? defaultWait;
  const inFlight = new Map<string, Promise<ProviderSnapshot<unknown>>>();

  async function refresh<T>(provider: Provider<T>, force = false): Promise<ProviderSnapshot<T>> {
    const identity = `${provider.id}:${provider.cacheKey ?? "default"}`;
    const existing = inFlight.get(identity);
    if (existing) {
      if (!force) return existing as Promise<ProviderSnapshot<T>>;
      await existing;
      return refresh(provider, true);
    }

    const task = lock(`codex-desktop-provider:${identity}`, async () => {
      const cacheKey = `codex-desktop.provider.v6:${encodeURIComponent(identity)}`;
      const previous = readEnvelope<T>(cache, cacheKey);
      const timestamp = now();
      if (previous?.cooldownUntil && previous.cooldownUntil > timestamp) {
        const failureReason = provider.id === "vps-status"
          ? safeBeszelError(previous.failureReason ?? (previous.snapshot.error?.startsWith("连续读取失败")
            ? "上次失败原因未保留，等待自然重试" : previous.snapshot.error))
          : undefined;
        const snapshot: ProviderSnapshot<T> = {
          ...previous.snapshot,
          status: previous.snapshot.data !== null && previous.snapshot.lastSuccessAt ? "stale" : "error",
          error: `${failureReason ? `${failureReason}；` : ""}连续读取失败，暂停刷新至 ${new Date(previous.cooldownUntil).toISOString()}`,
          retryAt: new Date(previous.cooldownUntil).toISOString(),
        };
        writeEnvelope(cache, cacheKey, { ...previous, failureReason, expiresAt: previous.cooldownUntil, snapshot });
        return snapshot;
      }
      if (!force && previous && previous.expiresAt > timestamp) return previous.snapshot;

      const policy: ProviderRetryPolicy = {
        maxRetries: Math.max(0, Math.min(3, provider.retryPolicy?.maxRetries ?? defaultRetryPolicy.maxRetries)),
        initialDelayMs: Math.max(0, provider.retryPolicy?.initialDelayMs ?? defaultRetryPolicy.initialDelayMs),
        maxDelayMs: Math.max(0, provider.retryPolicy?.maxDelayMs ?? defaultRetryPolicy.maxDelayMs),
      };
      const halfOpenRecovery = previous?.cooldownUntil !== undefined && previous.cooldownUntil <= timestamp;
      const maxAttempts = halfOpenRecovery ? 1 : policy.maxRetries + 1;
      const timeoutMs = Math.max(250, provider.timeoutMs ?? 15_000);
      let lastResult: ProviderLoadResult<T> = { status: "error", data: null, error: `${provider.name} 读取失败`, retryable: true };
      let retriesUsed = 0;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const controller = new AbortController();
        let timeoutHandle: ReturnType<typeof globalThis.setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = globalThis.setTimeout(() => {
              controller.abort();
              reject(createTimeoutError(provider.name));
            }, timeoutMs);
          });
          const load = provider.load(controller.signal).catch((error: unknown) => {
            if (controller.signal.aborted) throw createTimeoutError(provider.name);
            throw error;
          });
          const result = await Promise.race([load, timeout]);
          if (!isLoadResult<T>(result) || (result.status === "normal" && result.data === null) || (result.status === "degraded" && result.data === null)
            || (result.observedAt !== undefined && observationTime(result.observedAt, now()) === null)
            || (result.retained === true && observationTime(result.observedAt, now()) === null)
            || ((result.status === "normal" || result.status === "degraded") && result.retained === true)) {
            lastResult = { status: "error", data: null, error: `${provider.name} 返回了无效数据`, retryable: false };
          } else {
            lastResult = result;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || `${provider.name} 读取失败`);
          lastResult = {
            status: "error",
            data: null,
            error: message.replace(/[\r\n\t]+/g, " ").slice(0, 240),
            retryable: !message.includes("超过采样时限"),
          };
        } finally {
          if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle);
        }

        if ((lastResult.status === "normal" || lastResult.status === "degraded") && lastResult.data !== null) break;
        if (!lastResult.retryable || attempt + 1 >= maxAttempts) break;
        retriesUsed += 1;
        const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** attempt);
        if (delay > 0) await wait(delay);
      }

      const completedAt = now();
      const successful = (lastResult.status === "normal" || lastResult.status === "degraded") && lastResult.data !== null;
      const failureReason = provider.id === "vps-status" && lastResult.status === "error" ? safeBeszelError(lastResult.error) : undefined;
      const failureCount = successful || lastResult.status === "unavailable"
        ? 0
        : lastResult.status === "error" ? (previous?.failureCount ?? 0) + 1 : 0;
      const cooldownUntil = lastResult.status === "error" && failureCount >= 3
        ? completedAt + 60_000
        : undefined;
      const previousSuccessAt = observationTime(previous?.snapshot.lastSuccessAt, completedAt);
      const observedAt = observationTime(lastResult.observedAt, completedAt);
      const cachedData = previousSuccessAt && previous?.snapshot.data !== null ? previous?.snapshot.data ?? null : null;
      const restoredIsNewer = lastResult.retained === true && lastResult.data !== null && observedAt !== null
        && (cachedData === null || Date.parse(observedAt) >= Date.parse(previousSuccessAt!));
      const retainedData = restoredIsNewer ? lastResult.data : cachedData;
      const retainedSuccessAt = restoredIsNewer ? observedAt : previousSuccessAt;
      const retryDelayMs = retriesUsed > 0
        ? Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** retriesUsed)
        : Math.max(1_000, policy.initialDelayMs);
      const retryAt = successful || (lastResult.retryable === false && cooldownUntil === undefined)
        ? undefined
        : new Date(cooldownUntil ?? completedAt + retryDelayMs).toISOString();
      const snapshot: ProviderSnapshot<T> = {
        providerId: provider.id,
        status: successful ? lastResult.status : retainedData !== null && retainedSuccessAt ? "stale" : lastResult.status,
        data: successful ? lastResult.data : retainedData ?? lastResult.data,
        error: provider.id === "vps-status" && lastResult.error ? safeBeszelError(lastResult.error) : lastResult.error,
        lastUpdated: new Date(completedAt).toISOString(),
        lastSuccessAt: successful ? observedAt ?? new Date(completedAt).toISOString() : retainedSuccessAt,
        retryAt,
        retryable: lastResult.retryable,
      };
      const refreshInterval = provider.refreshIntervalMs ?? staticCacheMs;
      // Polling starts the interval before the load finishes. Anchor freshness
      // to that start so a fast load does not cause every second tick to reuse
      // the previous sample. Keep one second after slow loads to merge waiters.
      const schedulingMargin = Math.min(250, refreshInterval / 10);
      const cacheDuration = successful ? Math.max(1_000, refreshInterval - schedulingMargin - (completedAt - timestamp)) : retryAt ? Math.max(1_000, Date.parse(retryAt) - completedAt) : Math.max(1_000, refreshInterval);
      writeEnvelope(cache, cacheKey, {
        expiresAt: completedAt + cacheDuration,
        snapshot,
        failureCount: failureCount || undefined,
        cooldownUntil,
        failureReason,
      });
      return snapshot;
    });

    inFlight.set(identity, task as Promise<ProviderSnapshot<unknown>>);
    try {
      return await task;
    } finally {
      inFlight.delete(identity);
    }
  }

  return { refresh };
}

export const providerRuntime = createProviderRuntime();
