import test from "node:test";
import assert from "node:assert/strict";
import { deriveRuntimeCpu } from "../scripts/runtime-cpu.mjs";

const startedAt = "2026-10-05T10:00:00.000Z";
const process = (cpuSeconds: number, extra = {}) => ({ id: 1, name: "app", startedAt, cpuSeconds, ...extra });
const record = (elapsedSeconds: number, processes: unknown[], logicalProcessors = 12) => ({ elapsedSeconds, processes, logicalProcessors });

test("resource CPU retains fractional process seconds and normalizes all processors", () => {
  const result = deriveRuntimeCpu([record(0, [process(1)]), record(30, [process(1.234375)])]);
  assert.equal(result[0].value, null);
  assert.equal(result[1].value, 100 * .234375 / 30 / 12);
  assert.ok(result[1].value > 0);
});

test("resource CPU sums individual counters and accepts a confirmed zero interval", () => {
  const rows = [record(0, [process(1), process(2, { id: 2 })]), record(30, [process(1.2), process(2.3, { id: 2 })]),
    record(60, [process(1.2), process(2.3, { id: 2 })])];
  const values = deriveRuntimeCpu(rows);
  assert.ok(Math.abs(values[1].value! - 100 * .5 / 30 / 12) < 1e-10);
  assert.equal(values[2].value, 0);
});

test("resource CPU resets on process birth changes and counter rollback", () => {
  const first = record(0, [process(2)]);
  assert.equal(deriveRuntimeCpu([first, record(30, [process(3, { startedAt: "2026-10-05T10:00:10.000Z" })])])[1].reason, "process_group_change");
  assert.equal(deriveRuntimeCpu([first, record(30, [process(1)])])[1].reason, "counter_rollback");
});

test("resource CPU never replaces missing counters or lifetime evidence with zero", () => {
  assert.equal(deriveRuntimeCpu([record(0, [process(1)]), record(30, [process(null as unknown as number)])])[1].value, null);
  const rows = [record(0, [process(1, { startedAt: undefined })]), record(30, [process(1.25, { startedAt: undefined })])];
  assert.equal(deriveRuntimeCpu(rows)[1].reason, "counter_or_lifetime_unavailable");
  assert.ok(deriveRuntimeCpu(rows, new Map([["1:app", startedAt]]))[1].value! > 0);
});

test("resource CPU rejects nonincreasing time and processor count changes", () => {
  assert.equal(deriveRuntimeCpu([record(0, [process(1)]), record(0, [process(2)])])[1].value, null);
  assert.equal(deriveRuntimeCpu([record(0, [process(1)]), record(30, [process(2)], 16)])[1].reason, "clock_or_processor_change");
});
