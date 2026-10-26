import type { ProviderDiagnostic, ProviderKind, ProviderResultStatus } from "../domain/providers/contracts";

export type ProviderLoadStatus = Exclude<ProviderResultStatus, "stale">;

export interface ProviderLoadResult<T> {
  status: ProviderLoadStatus;
  data: T | null;
  error?: string;
  retryable?: boolean;
  /** Actual observation time of data, including a retained history value on failure. */
  observedAt?: string;
  /** Data is an earlier successful value restored after this load failed. */
  retained?: boolean;
}

export interface ProviderRetryPolicy {
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export interface Provider<T> {
  id: string;
  name: string;
  kind: ProviderKind;
  refreshIntervalMs: number | null;
  backgroundRefreshIntervalMs?: number | null;
  timeoutMs?: number;
  retryPolicy?: Partial<ProviderRetryPolicy>;
  /** Include non-secret configuration that changes the provider result. */
  cacheKey?: string;
  load: (signal: AbortSignal) => Promise<ProviderLoadResult<T>>;
}

export interface ProviderSnapshot<T> extends Omit<ProviderLoadResult<T>, "status" | "observedAt" | "retained"> {
  status: ProviderResultStatus;
  providerId: string;
  lastUpdated: string | null;
  lastSuccessAt: string | null;
  retryAt?: string;
}

export function toProviderDiagnostic<T>(provider: Provider<T>, snapshot: ProviderSnapshot<T>): ProviderDiagnostic {
  return {
    providerId: provider.id,
    name: provider.name,
    status: snapshot.status,
    lastUpdated: snapshot.lastUpdated,
    lastSuccessAt: snapshot.lastSuccessAt,
    error: snapshot.error,
  };
}
