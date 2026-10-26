export interface ProviderRequestMetrics {
  commands: number;
  loads: number;
  reused: number;
  failures: number;
  inFlight: boolean;
  recentLoadsUnixMs: number[];
}
export interface ProviderRequestDiagnostics {
  debugChecksAvailable: boolean;
  observedAtUnixMs: number;
  windows: Array<{ label: string; visible: boolean }>;
  visibilityChanges: Array<{ label: string; visible: boolean; atUnixMs: number }>;
  providers: Array<{ id: string; metrics: ProviderRequestMetrics | null }>;
}
