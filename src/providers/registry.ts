import {createPublicArgentinaProvider,createPublicConabProvider,createPublicOverseasFuturesProvider,createPublicChinaFuturesProvider,createPublicAStocksProvider} from "./publicDataProviders";
import type { Provider } from "./contracts";
import type { ProviderData } from "./data";
import type { BeszelProviderConfig } from "./server/beszelProvider";
import { createBeszelProvider } from "./server/beszelProvider";
import { createWindowsHealthProvider } from "./system/windowsHealthProvider";
import { createHardwareProvider } from "./system/hardwareProvider";
import { demoProviderRegistry } from "./demo/registry";
import type { ApiConnectionSettings } from "../types";
import { createApiUsageProvider, defaultApiConnections } from "./api/apiUsageProvider";
import { unavailableApiProvider } from "./unavailableRegistry";
import { createAgentUsageProvider } from "./agents/agentUsageProvider";
import {createCustomHttpProvider} from "./agriculture/customHttpProvider";
import {createPublicNewsProvider,createPublicMarketProvider,createPublicCftcProvider,createPublicWasdeProvider,createPublicInspectionsProvider,createPublicNoaaProvider,createPublicNassAnnualProvider,createPublicCropProgressProvider,createPublicMonthlyProvider,createPublicIbgeProvider} from "./publicDataProviders";
import {createPublicWeatherProvider} from "./agriculture/publicWeatherProvider";
import { createAgricultureProvider } from "./agriculture/agricultureProvider";
import { createOllamaProvider } from "./local/ollamaProvider";
import type { SnapshotConnection } from "../domain/agriculture/contracts";

export interface ProviderRegistryOptions {
  includeLiveProviders?: boolean;
  includeDemoProviders?: boolean;
  apiConfig?: ApiConnectionSettings;
  snapshotConnection?: SnapshotConnection;
  // Selected market instruments; each public provider validates its own symbol subset.
  stockSymbols?:string[];
}

export function providersFor(
  ids: string[],
  beszelConfig: BeszelProviderConfig = { url: "", systemId: "", refreshIntervalSeconds: 30 },
  options: ProviderRegistryOptions = {},
): Provider<ProviderData>[] {
  const requested = new Set(ids);
  const includeLiveProviders = options.includeLiveProviders ?? true;
  const includeDemoProviders = options.includeDemoProviders ?? !includeLiveProviders;
  const selected: Provider<ProviderData>[] = [];

  if (includeDemoProviders) {
    selected.push(...demoProviderRegistry.filter((provider) => requested.has(provider.id)));
  }
  if (includeLiveProviders && !includeDemoProviders) {
    if (requested.has("agent-quotas")) selected.push(createAgentUsageProvider(options.apiConfig?.localAgentUsageEnabled === true));
    if (requested.has("api-balances") || requested.has("api-deepseek")) selected.push(createApiUsageProvider("deepseek", options.apiConfig ?? defaultApiConnections));
    if (requested.has("api-balances") || requested.has("api-mimo")) selected.push(createApiUsageProvider("mimo", options.apiConfig ?? defaultApiConnections));
    if (requested.has("api-balances") || requested.has("api-anthropic")) selected.push(createApiUsageProvider("anthropic", options.apiConfig ?? defaultApiConnections));
    if (requested.has("api-balances") || requested.has("api-openai")) selected.push(createApiUsageProvider("openai", options.apiConfig ?? defaultApiConnections));
    if (requested.has("api-unsupported")) selected.push(unavailableApiProvider);
  }
  if (includeLiveProviders && requested.has("vps-status")) selected.push(createBeszelProvider(beszelConfig));
  if (includeLiveProviders && (requested.has("system-health") || requested.has("windows-health") || requested.has("notifications"))) selected.push(createWindowsHealthProvider());
  if (includeLiveProviders && requested.has("hardware-status")) selected.push(createHardwareProvider());
  if (includeLiveProviders && !includeDemoProviders && (requested.has("agent-quotas") || requested.has("ollama-local"))) selected.push(createOllamaProvider());
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("agriculture-status"))selected.push(createAgricultureProvider(options.snapshotConnection));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-weather"))selected.push(createPublicWeatherProvider(options.snapshotConnection?.weatherEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("custom-market-quotes"))selected.push(createCustomHttpProvider(options.snapshotConnection?.customSources));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-news"))selected.push(createPublicNewsProvider(options.snapshotConnection?.newsEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-market"))selected.push(createPublicMarketProvider(options.snapshotConnection?.marketEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-cftc"))selected.push(createPublicCftcProvider(options.snapshotConnection?.cftcEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-nass-annual"))selected.push(createPublicNassAnnualProvider(options.snapshotConnection?.nassAnnualEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-crop-progress"))selected.push(createPublicCropProgressProvider(options.snapshotConnection?.cropProgressEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-monthly"))selected.push(createPublicMonthlyProvider(options.snapshotConnection?.monthlyEnabled,options.snapshotConnection?(options.snapshotConnection.monthlySource??"fred"):"worldbank"));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-ibge"))selected.push(createPublicIbgeProvider(options.snapshotConnection?.ibgeEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-noaa"))selected.push(createPublicNoaaProvider(options.snapshotConnection?.noaaEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-inspections"))selected.push(createPublicInspectionsProvider(options.snapshotConnection?.inspectionsEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-wasde"))selected.push(createPublicWasdeProvider(options.snapshotConnection?.wasdeEnabled));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-cn-futures"))selected.push(createPublicChinaFuturesProvider(options.snapshotConnection?.chinaFuturesEnabled??false,options.stockSymbols));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-a-shares"))selected.push(createPublicAStocksProvider(options.snapshotConnection?.aSharesEnabled??false,options.stockSymbols));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-overseas-futures"))selected.push(createPublicOverseasFuturesProvider(options.snapshotConnection?.overseasFuturesEnabled??false,options.stockSymbols));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-conab"))selected.push(createPublicConabProvider(options.snapshotConnection?.conabEnabled??false));
  if(includeLiveProviders&&!includeDemoProviders&&requested.has("public-argentina"))selected.push(createPublicArgentinaProvider(options.snapshotConnection?.argentinaEnabled??false));
  return selected;
}
