import type { NotificationCandidate } from "../../types";
import type { Provider, ProviderSnapshot } from "../../providers/contracts";
import type { ProviderData } from "../../providers/data";
import { loadSettings } from "../../providers/settingsStore";
import { logEvent } from "../appLogger";
import { applyNotifications } from "./repository";
import {newsFromAgriculture,newsNotificationCandidates} from "../../domain/news/newsAdapter";

function identity(value: string) {
  // Preserve normal event IDs; long source IDs use a stable 64-bit fingerprint.
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= 120) return value;
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `hash:${hash.toString(16)}`;
}

export function notificationsFromSnapshots(providers: Provider<ProviderData>[], snapshots: ProviderSnapshot<ProviderData>[]) {
  const candidates: NotificationCandidate[] = [];
  const completeScopes: string[] = [];
  const registered = new Map(providers.map((provider) => [provider.id, provider]));
  for (const snapshot of snapshots) {
    const provider = registered.get(snapshot.providerId);
    if (!provider || provider.name.includes("（演示）")) continue;
    completeScopes.push(provider.id);
    const failure = snapshot.status === "stale" || snapshot.status === "error"
      || ((snapshot.status === "unavailable" || snapshot.status === "degraded") && snapshot.retryable !== false && Boolean(snapshot.error));
    if (failure) {
      candidates.push({
        id: `condition:${identity(provider.id)}`, scope: provider.id, rule: "provider-status", kind: "condition",
        source: provider.kind === "api" ? "api" : provider.id === "hardware-status" ? "hardware" : "provider",
        severity: snapshot.status === "error" ? "error" : "warning",
        title: `${provider.name} ${snapshot.status === "stale" ? "数据已过期" : "读取异常"}`,
        detail: snapshot.error || "当前数据不可用", evidenceAt: snapshot.lastUpdated,
      });
    }
    if (snapshot.status === "normal" && snapshot.data?.type === "agriculture-status") {
      const fetched = Date.parse(snapshot.data.snapshot.fetchedAt);
      const now = Date.now();
      if (Number.isFinite(fetched) && fetched <= now && now-fetched <= 10*60_000)
        candidates.push(...newsNotificationCandidates(newsFromAgriculture(snapshot.data.snapshot,now),now));
    }
    if (snapshot.data?.type === "windows-health") {
      for (const event of snapshot.data.observation.events) {
        candidates.push({
          id: `event:${identity(event.id)}`, source: "system", scope: provider.id,
          rule: identity(`${event.channel}:${event.source}:${event.eventId}`), kind: "event",
          severity: event.severity === "warning" ? "warning" : "error",
          title: `${event.category} · ${event.eventId}`,
          detail: `${event.source} · ${event.message}${event.relatedProcess ? ` · ${event.relatedProcess}` : ""}`.slice(0, 2_500), evidenceAt: event.timestamp,
        });
      }
    }
  }
  return { candidates, completeScopes };
}

export function notificationBatches(candidates: NotificationCandidate[], completeScopes: string[]) {
  if (candidates.length <= 100) return [{ candidates, completeScopes }];
  const events = candidates.filter((candidate) => candidate.kind === "event");
  const batches: Array<{ candidates: NotificationCandidate[]; completeScopes: string[] }> = [];
  for (let offset = 0; offset < events.length; offset += 100) batches.push({ candidates: events.slice(offset, offset + 100), completeScopes: [] });
  // Resolve conditions only after the whole source batch has been processed.
  batches.push({ candidates: candidates.filter((candidate) => candidate.kind === "condition"), completeScopes });
  return batches;
}

export async function publishProviderNotifications(providers: Provider<ProviderData>[], snapshots: ProviderSnapshot<ProviderData>[]) {
  const batch = notificationsFromSnapshots(providers, snapshots);
  if (!batch.completeScopes.length) return;
  try {
    const preferences = loadSettings().notificationPreferences;
    for (const part of notificationBatches(batch.candidates, batch.completeScopes)) await applyNotifications(part.candidates, part.completeScopes, preferences);
  } catch {
    logEvent("error", "notifications.persist_failed");
  }
}
