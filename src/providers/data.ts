import type { HardwareSnapshot } from "../domain/hardware/contracts";
import type { AgentQuotaAccount } from "../domain/agent/contracts";
import type { ApiUsageAccount } from "../domain/api/contracts";
export type { AgentQuotaAccount } from "../domain/agent/contracts";
export type { ApiUsageAccount } from "../domain/api/contracts";
import type { ApplicationItem } from "../domain/applications/contracts";
import type { VpsObservation } from "../domain/vps/contracts";
import type { EventLogObservation } from "../domain/health/contracts";

export interface AgentQuotaData {
  type: "agent-quotas";
  mode?: "live" | "demo";
  accounts: AgentQuotaAccount[];
}

export interface ApiUsageData {
  type: "api-balances";
  mode?: "live" | "demo";
  accounts: ApiUsageAccount[];
}

export interface ApplicationCatalogData {
  type: "application-catalog";
  applications: ApplicationItem[];
}

export interface VpsStatusData {
  type: "vps-status";
  observation: VpsObservation;
}

export interface WindowsHealthData {
  type: "windows-health";
  observation: EventLogObservation;
}

export interface HardwareStatusData {
  type: "hardware-status";
  snapshot: HardwareSnapshot;
}
export interface LocalAiData { type: "local-ai"; snapshot: import("../domain/local/contracts").LocalAiSnapshot }

export interface AgricultureData {type: "agriculture-status";snapshot:import("../domain/agriculture/contracts").AgricultureEnvelope}
export interface PublicWeatherData {type:"public-weather";snapshot:import("../domain/agriculture/publicWeather").PublicWeatherSnapshot}
export interface CustomMarketData {type:"custom-market-quotes";snapshot:import("../domain/agriculture/customHttpQuotes").CustomQuotesSnapshot}
export interface PublicNewsData {type:"public-news";snapshot:import("../domain/news/publicFeeds").PublicNewsSnapshot}
export interface PublicMarketData {type:"public-market";snapshot:import("../domain/agriculture/publicMarket").PublicMarketSnapshot}
export interface PublicCftcData {type:"public-cftc";snapshot:import("../domain/agriculture/publicCftc").PublicCftcSnapshot}
export interface PublicWasdeData {type:"public-wasde";snapshot:import("../domain/agriculture/publicWasde").PublicWasdeSnapshot}
export interface PublicInspectionsData {type:"public-inspections";snapshot:import("../domain/agriculture/publicInspections").PublicInspectionsSnapshot}
export interface PublicNoaaData {type:"public-noaa";snapshot:import("../domain/agriculture/publicNoaa").PublicNoaaSnapshot}
export interface PublicNassAnnualData {type:"public-nass-annual";snapshot:import("../domain/agriculture/publicNass").PublicNassAnnualSnapshot}
export interface PublicCropProgressData {type:"public-crop-progress";snapshot:import("../domain/agriculture/publicNass").PublicCropProgressSnapshot}
export interface PublicMonthlyData {type:"public-monthly";snapshot:import("../domain/agriculture/publicReferenceData").PublicMonthlySnapshot}
export interface PublicIbgeData {type:"public-ibge";snapshot:import("../domain/agriculture/publicReferenceData").PublicIbgeSnapshot}
export interface PublicAStocksData {type:"public-a-shares";snapshot:import("../domain/agriculture/publicAStocks").AStocksSnapshot}
export interface PublicChinaFuturesData {type:"public-cn-futures";snapshot:import("../domain/agriculture/publicChinaFutures").ChinaFuturesSnapshot}
export interface PublicOverseasFuturesData {type:"public-overseas-futures";snapshot:import("../domain/agriculture/publicOverseasFutures").OverseasFuturesSnapshot}
export interface PublicConabData {type:"public-conab";snapshot:import("../domain/agriculture/publicReferenceData").PublicConabSnapshot}
export interface PublicArgentinaData {type:"public-argentina";snapshot:import("../domain/agriculture/publicReferenceData").PublicArgentinaSnapshot}
export type ProviderData = PublicArgentinaData | PublicConabData | PublicOverseasFuturesData | PublicChinaFuturesData | PublicAStocksData | PublicNassAnnualData | PublicCropProgressData | PublicMonthlyData | PublicIbgeData | PublicNoaaData | PublicInspectionsData | PublicWasdeData | PublicCftcData | PublicNewsData | PublicMarketData | CustomMarketData | PublicWeatherData | AgricultureData | AgentQuotaData | ApiUsageData | ApplicationCatalogData | VpsStatusData | WindowsHealthData | HardwareStatusData | LocalAiData;
