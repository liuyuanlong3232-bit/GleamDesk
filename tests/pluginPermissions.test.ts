import assert from "node:assert/strict";
import { test } from "node:test";
import { permitsPluginOperation, validatePluginManifest, type PluginGrant } from "../src/domain/plugins/permissions";
const input = { schemaVersion: 1, id: "desktop.hardware-summary", name: "硬件摘要", version: "1.0.0", runtime: "wasm", entry: "main.wasm",
  permissions: { dataRead: ["hardware"], networkOrigins: ["https://example.com"], storage: true, notifications: false },
  limits: { memoryMiB: 64, timeoutMs: 2_000, messageBytes: 16_384 } };
const digest = "a".repeat(64);

test("plugin permission policy denies missing grants, revoked grants, and changed package digests", () => {
  const manifest = validatePluginManifest(input);
  const grant: PluginGrant = { pluginId: manifest.id, packageDigest: digest, revoked: false, permissions: manifest.permissions };
  const operation = { type: "data-read" as const, source: "hardware" as const };
  assert.equal(permitsPluginOperation(manifest, undefined, digest, operation), false);
  assert.equal(permitsPluginOperation(manifest, grant, digest, operation), true);
  assert.equal(permitsPluginOperation(manifest, { ...grant, revoked: true }, digest, operation), false);
  assert.equal(permitsPluginOperation(manifest, grant, "b".repeat(64), operation), false);
  assert.equal(permitsPluginOperation(manifest, grant, digest, { type: "data-read", source: "api-usage" }), false);
});

test("plugin manifests reject arbitrary execution, traversal, wildcard origins and unknown credentials permission", () => {
  for (const modification of [{ runtime: "native" }, { entry: "../main.wasm" }, { permissions: { ...input.permissions, credentials: true } },
    { permissions: { ...input.permissions, networkOrigins: ["https://*.example.com"] } }, { permissions: { ...input.permissions, networkOrigins: ["http://example.com"] } },
    { limits: { ...input.limits, memoryMiB: 4_096 } }]) assert.throws(() => validatePluginManifest({ ...input, ...modification }));
});

test("a network request requires matching manifest and user grant origins", () => {
  const manifest = validatePluginManifest(input);
  const grant: PluginGrant = { pluginId: manifest.id, packageDigest: digest, revoked: false, permissions: { ...manifest.permissions, networkOrigins: [] } };
  assert.equal(permitsPluginOperation(manifest, grant, digest, { type: "network", url: "https://example.com/api" }), false);
  grant.permissions.networkOrigins = manifest.permissions.networkOrigins;
  assert.equal(permitsPluginOperation(manifest, grant, digest, { type: "network", url: "https://example.com/api" }), true);
  assert.equal(permitsPluginOperation(manifest, grant, digest, { type: "network", url: "https://example.com.evil.test/api" }), false);
  assert.equal(permitsPluginOperation(manifest, grant, digest, { type: "network", url: "https://user:secret@example.com/api" }), false);
});
