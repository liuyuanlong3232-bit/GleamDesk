import type { Provider } from "./contracts";

export interface PollingHost {
  isVisible(): boolean;
  subscribeVisibility(listener: () => void): () => void;
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timerId: number): void;
}

export function startProviderPolling<T>(
  requestedProviderIds: string[],
  providers: Provider<T>[],
  refresh: (providerIds: string[]) => void,
  host: PollingHost,
): () => void {
  let active = true;
  let timers: number[] = [];
  const stopTimers = () => {
    timers.forEach((timer) => host.clearInterval(timer));
    timers = [];
  };
  const restart = () => {
    if (!active) return;
    stopTimers();
    const visible = host.isVisible();
    if (visible && requestedProviderIds.length > 0) refresh(requestedProviderIds);
    timers = providers.flatMap((provider) => {
      const interval = visible ? provider.refreshIntervalMs : provider.backgroundRefreshIntervalMs ?? null;
      if (interval === null || interval < 1_000) return [];
      return [host.setInterval(() => {
        if (active) refresh([provider.id]);
      }, interval)];
    });
  };
  const unsubscribe = host.subscribeVisibility(restart);
  restart();
  return () => {
    active = false;
    stopTimers();
    unsubscribe();
  };
}
