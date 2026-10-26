export type LogLevel = "info" | "warn" | "error";

export interface AppLogEntry {
  at: string;
  level: LogLevel;
  event: string;
  details?: Record<string, string | number | boolean | null>;
}

const storageKey = "codex-desktop.logs.v1";
const maxEntries = 200;

export function logEvent(
  level: LogLevel,
  event: string,
  details?: AppLogEntry["details"],
) {
  const entry: AppLogEntry = { at: new Date().toISOString(), level, event, details };
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
  output("[GleamDesk]", entry);
  try {
    const previous = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as AppLogEntry[];
    localStorage.setItem(storageKey, JSON.stringify([...previous.slice(-(maxEntries - 1)), entry]));
  } catch {
    // Logging must not interfere with the UI when storage is unavailable.
  }
}

export function readRecentLogs(): AppLogEntry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(storageKey) ?? "[]") as unknown;
    return Array.isArray(entries) ? entries.slice(-maxEntries) as AppLogEntry[] : [];
  } catch {
    return [];
  }
}
