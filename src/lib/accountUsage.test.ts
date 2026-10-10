import { describe, expect, it } from "vitest";
import { accountUsageAt, addAccountUsageDeclaration, normalizeAccountUsage, type AccountUsageDeclaration } from "./accountUsage";
import { resolveComfortUsage } from "./personComfort";
import { COMFORT_CURVE_VERSION } from "./comfortFeedback";
import type { ComfortFeedbackRecord } from "../types";
import type { TokeiUsage } from "./tokeiUsage";

const scope = "a".repeat(64);
const declaration: AccountUsageDeclaration = { scope, mode: "exclusive", personId: "person-a", effectiveFrom: "2026-09-09", declaredAt: "2026-09-10T04:00:00Z" };
const context = { scope, declarations: [declaration] };
const now = new Date("2026-09-10T12:00:00Z");
const data: TokeiUsage = { fetchedAt: now.toISOString(), status: "unavailable", localOnly: true, localUsageStatus: "unavailable", devices: [], groups: [{ id: "person-a", name: "Member A", deviceIds: [] }], defaultGroupId: "person-a", warnings: [], projectBreakdownAvailable: false };
const record: ComfortFeedbackRecord = { localDate: "2026-09-09", observedAt: now.toISOString(), comfort: "comfortable", personId: "person-a", observedUsedPercent: 18, usageObservedAt: now.toISOString(), usageCoverage: "partial", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION };
const resolve = (row = record, ctx = context, source = data) => resolveComfortUsage(row, source, [], [], now, ctx);

describe("account usage declarations and comfort", () => {
  it("uses real exclusive-account quota despite missing tokens and costs, without mutating feedback", () => {
    const before = structuredClone(record);
    expect(resolve()).toMatchObject({ usedPercent: 18, coverage: "partial", basis: "exclusive-account", reason: null });
    expect(record).toEqual(before);
    expect(record.quotaAllocation).toBeUndefined();
  });
  it("does not infer exclusive ownership or apply today's reference to yesterday", () => {
    expect(resolve(record, { scope, declarations: [] }).reason).toBe("unconfirmed");
    expect(resolve({ ...record, observedUsedPercent: null, usageCoverage: "unavailable" }).reason).toBe("missing-reference");
    expect(resolve(record, { scope: "b".repeat(64), declarations: [declaration] }).usedPercent).toBeNull();
    expect(resolve(record, { scope, declarations: [{ ...declaration, effectiveFrom: "2026-09-10" }] }).usedPercent).toBeNull();
  });
  it("retains shared safeguards and refuses another or deleted person", () => {
    expect(resolve(record, { scope, declarations: [{ ...declaration, mode: "shared" }] }).usedPercent).toBeNull();
    expect(resolve({ ...record, personId: "person-b" }).reason).toBe("person-mismatch");
    expect(resolve(record, context, { ...data, groups: [] }).reason).toBe("person-mismatch");
  });
  it.each([0, 18, 240])("preserves valid quota %s, never a budget ratio", value => {
    expect(resolve({ ...record, observedUsedPercent: value }).usedPercent).toBe(value);
  });
  it("rejects invalid, future and unavailable references", () => {
    for (const value of [-1, Number.NaN, 10001]) expect(resolve({ ...record, observedUsedPercent: value }).usedPercent).toBeNull();
    expect(resolve({ ...record, localDate: "2026-09-11" }).reason).toBe("invalid-date");
    expect(resolve({ ...record, usageCoverage: "unavailable" }).usedPercent).toBeNull();
  });
  it("prefers a confirmed exclusive interpretation while retaining an old cost allocation for rollback", () => {
    const stored = { ...record, quotaAllocation: { metricVersion: "cost-share-v1" as const, localDate: record.localDate, observedAt: now.toISOString(), totalUsedPercent: 18, personCostUsd: 10, totalCostUsd: 20, costShare: .5, allocatedUsedPercent: 9, coverage: "complete" as const, deviceIds: ["test-device"], missingDeviceIds: [] } };
    expect(resolve(stored).usedPercent).toBe(18);
    expect(resolve(stored, { scope, declarations: [{ ...declaration, mode: "shared" }] }).usedPercent).toBe(9);
    expect(stored.quotaAllocation.allocatedUsedPercent).toBe(9);
  });
  it("uses date boundaries, preserves past choices, and replaces only the explicit boundary", () => {
    const values = addAccountUsageDeclaration([declaration], { ...declaration, mode: "shared", effectiveFrom: "2026-09-10" });
    expect(accountUsageAt({ scope, declarations: values }, "2026-09-09")?.mode).toBe("exclusive");
    expect(accountUsageAt({ scope, declarations: values }, "2026-09-10")?.mode).toBe("shared");
    const reset = addAccountUsageDeclaration(values, { ...declaration, mode: "unconfirmed", effectiveFrom: "2026-09-10" });
    expect(reset).toHaveLength(2);
    expect(accountUsageAt({ scope, declarations: reset }, "2026-09-10")?.mode).toBe("unconfirmed");
    expect(normalizeAccountUsage(JSON.parse(JSON.stringify(reset)))).toEqual(reset);
  });
  it("fails closed on malformed settings rather than resurrecting an old declaration", () => {
    expect(normalizeAccountUsage([declaration, { ...declaration, effectiveFrom: "2026-02-30" }])).toEqual([]);
    expect(normalizeAccountUsage(null)).toEqual([]);
  });
});
