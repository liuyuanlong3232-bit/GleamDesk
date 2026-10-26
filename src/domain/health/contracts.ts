export type EventLogReadStatus = "ok" | "partial" | "unavailable" | "error";

export interface SystemEvent {
  id: string;
  timestamp: string;
  channel: "System" | "Application";
  recordId: string;
  source: string;
  eventId: number;
  level: string;
  category: string;
  message: string;
  severity: "critical" | "error" | "warning";
  relatedProcess?: string;
}

export interface EventLogObservation {
  status: EventLogReadStatus;
  scannedAt: string;
  events: SystemEvent[];
  warnings: string[];
}
