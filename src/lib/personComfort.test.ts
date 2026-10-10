import { describe, expect, it } from "vitest";
import { COMFORT_CURVE_VERSION, personalizeComfortCurve } from "./comfortFeedback";
import { allocationForFeedback, backfillPersonAllocations, personalFeedbackView, refreshFeedbackUsage } from "./personComfort";
import { buildTokenComfortSnapshot } from "./tokenComfort";
import type { TokeiUsage } from "./tokeiUsage";
import type { ComfortFeedbackRecord } from "../types";

const date = "2026-09-08";
const now = new Date(2026, 8, 10, 12);
function usage(): TokeiUsage {
  const day = (cost: number) => ({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 100, estimatedCostUsd: cost, models: [] });
  return { fetchedAt: now.toISOString(), status: "ready", warnings: [], projectBreakdownAvailable: true, defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: ["mac"] }, { id: "blair", name: "成员乙", deviceIds: ["pc"] }], devices: [
    { id: "mac", updatedAt: now.toISOString(), stale: false, daily: { [date]: day(30) }, ranges: {} },
    { id: "pc", updatedAt: now.toISOString(), stale: false, daily: { [date]: day(70) }, ranges: {} },
  ] };
}
function record(personId: string | null = "alex"): ComfortFeedbackRecord {
  return { localDate: date, personId, comfort: "comfortable", observedAt: now.toISOString(), observedUsedPercent: 60, usageObservedAt: now.toISOString(), usageCoverage: "complete", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION };
}

describe("percentage comfort presentation", () => {
  it("allocates the shared percentage without overwriting the recorded total", () => {
    const original = record();
    const display = personalFeedbackView(original, usage(), [], [], now);
    expect(display.observedUsedPercent).toBeCloseTo(18);
    expect(original.observedUsedPercent).toBe(60);
    expect(display.quotaAllocation?.totalUsedPercent).toBe(60);
    expect(personalizeComfortCurve([display], now).observations[0]?.usedPercent).toBe(18);
  });
  it("backfills once without assigning legacy records or changing their feedback", () => {
    const legacy = record(null), assigned = record();
    const migrated = backfillPersonAllocations([legacy, assigned], usage(), [], [], now)!;
    expect(migrated[0]).toBe(legacy);
    expect(migrated[1].observedUsedPercent).toBe(60);
    expect(migrated[1].comfort).toBe(assigned.comfort);
    expect(migrated[1].observedAt).toBe(assigned.observedAt);
    expect(backfillPersonAllocations(migrated, usage(), [], [], now)).toBeNull();
    expect(personalFeedbackView(migrated[1], usage(), [], [], now).observedUsedPercent).toBeCloseTo(18);
  });
  it("never reapportions a saved allocation after costs change", () => {
    const stored = { ...record(), quotaAllocation: allocationForFeedback(record(), usage(), [], [], now) };
    const newer = usage(); newer.devices[0].daily[date].estimatedCostUsd = 90;
    expect(personalFeedbackView(stored, newer, [], [], now).observedUsedPercent).toBeCloseTo(18);
    expect(personalFeedbackView(stored, null, [], [], now).observedUsedPercent).toBeCloseTo(18);
  });
  it("shows partial estimates without permanently migrating them", () => {
    const partial = usage(); partial.devices = partial.devices.slice(0, 1);
    expect(personalFeedbackView(record(), partial, [], [], now).quotaAllocation?.coverage).toBe("partial");
    const migrated = backfillPersonAllocations([record()], partial, [], [], now);
    expect(migrated?.[0].quotaAllocation).toBeUndefined();
    expect(migrated?.[0].tokenSnapshot?.coverage).toBe("complete");
  });
  it("does not turn unavailable personal cost into zero or shared-account usage", () => {
    const missing = usage(); missing.devices[0].daily = {};
    expect(personalFeedbackView(record(), missing, [], [], now).observedUsedPercent).toBeNull();
    expect(backfillPersonAllocations([record()], missing, [], [], now)).toBeNull();
    expect(personalFeedbackView(record(null), missing, [], [], now).observedUsedPercent).toBe(60);
  });
  it("recovers tokens without historical quota and preserves the experience and owner", () => {
    const stored = { ...record(), observedUsedPercent: null, usageCoverage: "unavailable" as const };
    const token = buildTokenComfortSnapshot(usage(), "alex", date, now);
    const unavailable = allocationForFeedback(stored, usage(), [], [], now);
    const result = refreshFeedbackUsage(stored, token, unavailable);
    expect(result.tokenSnapshot?.totalTokens).toBe(100);
    expect(result.observedUsedPercent).toBeNull();
    expect(result.personId).toBe(stored.personId);
    expect(result.observedAt).toBe(stored.observedAt);
    expect(result.comfort).toBe(stored.comfort);
    expect(personalFeedbackView(result, usage(), [], [], now).observedUsedPercent).toBeNull();
  });
  it("replaces unavailable allocations once, without overwriting complete snapshots", () => {
    const missing = usage(); missing.devices = [];
    const stored = { ...record(), quotaAllocation: allocationForFeedback(record(), missing, [], [], now) };
    const migrated = backfillPersonAllocations([stored], usage(), [], [], now)!;
    expect(migrated[0].quotaAllocation?.allocatedUsedPercent).toBe(18);
    expect(migrated[0].updatedAt).toBe(now.toISOString());
    expect(backfillPersonAllocations(migrated, usage(), [], [], now)).toBeNull();
    const worse = refreshFeedbackUsage(migrated[0], buildTokenComfortSnapshot(missing, "alex", date, now), stored.quotaAllocation);
    expect(worse.tokenSnapshot).toBe(migrated[0].tokenSnapshot);
    expect(worse.quotaAllocation).toBe(migrated[0].quotaAllocation);
  });
  it("does not infer the whole shared-account allocation from local costs", () => {
    const local = { ...usage(), localOnly: true };
    expect(allocationForFeedback(record(), local, [], [], now)?.coverage).toBe("unavailable");
    expect(buildTokenComfortSnapshot(local, "alex", date, now)?.totalTokens).toBe(100);
  });
});
