export type PluginDataSource = "hardware" | "windows-health" | "vps" | "api-usage";
export interface PluginPermissions { dataRead: PluginDataSource[]; networkOrigins: string[]; storage: boolean; notifications: boolean }
export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  runtime: "wasm";
  entry: string;
  permissions: PluginPermissions;
  limits: { memoryMiB: number; timeoutMs: number; messageBytes: number };
}
export interface PluginGrant { pluginId: string; packageDigest: string; revoked: boolean; permissions: PluginPermissions }
export type PluginOperation = { type: "data-read"; source: PluginDataSource } | { type: "network"; url: string } | { type: "storage" } | { type: "notification" };
const sources = ["hardware", "windows-health", "vps", "api-usage"] as const;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function origins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8 || value.some((item) => typeof item !== "string")) throw new Error("插件网络权限列表无效");
  return [...new Set(value.map((item: string) => {
    const url = new URL(item);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/"
      || url.hostname.includes("*") || url.port || url.hostname === "localhost" || /^\d+(\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":")) throw new Error("插件只允许明确 HTTPS 域名来源");
    return url.origin;
  }))];
}

export function validatePluginManifest(value: unknown): PluginManifest {
  const input = record(value);
  const permission = record(input.permissions);
  const limits = record(input.limits);
  if (input.schemaVersion !== 1 || input.runtime !== "wasm" || typeof input.id !== "string" || !/^[a-z][a-z0-9.-]{2,63}$/.test(input.id)
    || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80
    || typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)
    || typeof input.entry !== "string" || !/^[a-zA-Z0-9_-]+\.wasm$/.test(input.entry)) throw new Error("插件清单或入口无效");
  if (!Array.isArray(permission.dataRead) || permission.dataRead.some((item) => !sources.includes(item as PluginDataSource))
    || typeof permission.storage !== "boolean" || typeof permission.notifications !== "boolean"
    || Object.keys(permission).some((key) => !["dataRead", "networkOrigins", "storage", "notifications"].includes(key))) throw new Error("插件请求了未知权限");
  const integer = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
  if (!integer(limits.memoryMiB, 16, 128) || !integer(limits.timeoutMs, 100, 5_000) || !integer(limits.messageBytes, 1_024, 65_536)) throw new Error("插件资源上限无效");
  return { schemaVersion: 1, runtime: "wasm", id: input.id, name: input.name, version: input.version, entry: input.entry,
    permissions: { dataRead: [...new Set(permission.dataRead as PluginDataSource[])], networkOrigins: origins(permission.networkOrigins), storage: permission.storage, notifications: permission.notifications },
    limits: { memoryMiB: limits.memoryMiB as number, timeoutMs: limits.timeoutMs as number, messageBytes: limits.messageBytes as number } };
}

/** Policy contract only. A future Rust broker must independently enforce it for every operation. */
export function permitsPluginOperation(manifest: PluginManifest, grant: PluginGrant | undefined, digest: string, operation: PluginOperation): boolean {
  if (!grant || grant.revoked || grant.pluginId !== manifest.id || grant.packageDigest !== digest || !/^[a-f0-9]{64}$/.test(digest)) return false;
  switch (operation.type) {
    case "data-read": return manifest.permissions.dataRead.includes(operation.source) && grant.permissions.dataRead.includes(operation.source);
    case "storage": return manifest.permissions.storage && grant.permissions.storage;
    case "notification": return manifest.permissions.notifications && grant.permissions.notifications;
    case "network": {
      try {
        const url = new URL(operation.url);
        return url.protocol === "https:" && !url.username && !url.password && manifest.permissions.networkOrigins.includes(url.origin) && grant.permissions.networkOrigins.includes(url.origin);
      } catch { return false; }
    }
  }
}
