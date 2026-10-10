import { buildComfortPrompt, localDateKey } from "./comfortFeedback";
import { accountUsageAt, EMPTY_ACCOUNT_USAGE, validDeclarationDate, type AccountUsageContext } from "./accountUsage";
import { MAX_DAILY_OBSERVED_PERCENT } from "../types";
import { buildPersonQuotaAllocation } from "./personQuotaAllocation";
import { buildTokenComfortSnapshot } from "./tokenComfort";
import type { TokeiUsage } from "./tokeiUsage";
import type { CodexDailyUsage, ComfortFeedbackRecord, ComfortQuotaAllocation, ComfortTokenSnapshot, DailyUsageSummary } from "../types";

export type ComfortUsageReason = "missing-reference" | "unconfirmed" | "person-mismatch" | "shared-incomplete" | "invalid-date" | "collection-unavailable";
export interface ResolvedComfortUsage {
  usedPercent: number | null;
  coverage: ComfortFeedbackRecord["usageCoverage"];
  basis: "exclusive-account" | "cost-share" | "legacy" | "unavailable";
  reason: ComfortUsageReason | null;
}

/** One interpretation for plots, daily details, reminders and missing-data explanations. Never persist this view. */
export function resolveComfortUsage(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date(), context: AccountUsageContext = EMPTY_ACCOUNT_USAGE): ResolvedComfortUsage {
  const missing = (reason: ComfortUsageReason): ResolvedComfortUsage => ({ usedPercent: null, coverage: "unavailable", basis: "unavailable", reason });
  if (!validDeclarationDate(record.localDate) || record.localDate > localDateKey(now)) return missing("invalid-date");
  const validReference = (value: Pick<ComfortFeedbackRecord, "observedUsedPercent" | "usageCoverage" | "usageObservedAt">) => value.observedUsedPercent != null
    && Number.isFinite(value.observedUsedPercent) && value.observedUsedPercent >= 0 && value.observedUsedPercent <= MAX_DAILY_OBSERVED_PERCENT
    && value.usageCoverage !== "unavailable" && (value.usageObservedAt == null || Number.isFinite(Date.parse(value.usageObservedAt)) && Date.parse(value.usageObservedAt) <= now.getTime() + 300_000);
  const reference = validReference(record) ? record : buildComfortPrompt({ localDate: record.localDate, isCatchUp: true }, official.find(day => day.localDate === record.localDate) ?? null, history);
  const declaration = accountUsageAt(context, record.localDate);
  if (!record.personId) return validReference(record) ? { usedPercent: record.observedUsedPercent, coverage: record.usageCoverage, basis: "legacy", reason: null } : missing("missing-reference");
  if (declaration?.mode === "exclusive") {
    if (record.personId !== declaration.personId || !data?.groups.some(group => group.id === declaration.personId)) return missing("person-mismatch");
    return validReference(reference) ? { usedPercent: reference.observedUsedPercent, coverage: reference.usageCoverage, basis: "exclusive-account", reason: null } : missing("missing-reference");
  }
  const allocation = allocationForFeedback(record, data, official, history, now);
  if (declaration?.mode !== "unconfirmed" && allocation?.allocatedUsedPercent != null && allocation.coverage !== "unavailable") {
    return { usedPercent: allocation.allocatedUsedPercent, coverage: allocation.coverage, basis: "cost-share", reason: null };
  }
  if (!validReference(reference)) return missing("missing-reference");
  if (declaration?.mode === "unconfirmed" || !declaration && data?.localOnly) return missing("unconfirmed");
  if (!data) return missing("collection-unavailable");
  return missing("shared-incomplete");
}

export function comfortUsageReasonText(reason: ComfortUsageReason, zh: boolean): string {
  const labels: Record<ComfortUsageReason, [string, string]> = {
    "missing-reference": ["缺少该日的历史额度参考；Token 可单独更新，无法据此补出百分比。", "Historical quota is missing; updating tokens cannot reconstruct the percentage."],
    unconfirmed: ["请确认账号是仅本人使用还是多人共用，以及适用日期。", "Confirm whether this account is personal or shared, and the applicable dates."],
    "person-mismatch": ["独享声明与这条记录的成员不匹配，或该成员已不存在。", "The personal-account declaration does not match this member, or the member no longer exists."],
    "shared-incomplete": ["已有账号额度，但个人分摊所需的设备日账或成本不完整。", "Account quota is available, but device ledgers or costs are insufficient for a personal share."],
    "invalid-date": ["日期无效或尚未到来，暂不用于曲线。", "The date is invalid or in the future; it cannot be plotted."],
    "collection-unavailable": ["用量读取暂不可用，已保留体验和原快照。", "Usage is unavailable; feedback and saved snapshots are retained."],
  };
  return labels[reason][zh ? 0 : 1];
}

/** The stored percentage remains the shared account total, never allocated twice. */
export function allocationForFeedback(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortQuotaAllocation | null {
  if (!record.personId) return null;
  if (record.quotaAllocation && record.quotaAllocation.coverage !== "unavailable") return record.quotaAllocation;
  if (!data) return record.quotaAllocation ?? null;
  const total = record.observedUsedPercent !== null && record.usageCoverage !== "unavailable"
    ? record
    : buildComfortPrompt({ localDate: record.localDate, isCatchUp: true }, official.find(day => day.localDate === record.localDate) ?? null, history);
  return buildPersonQuotaAllocation(data, record.personId, record.localDate, total, now);
}

/** A derived view for the original smooth-knee fitter; do not persist this view. */
export function personalFeedbackView(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date(), context: AccountUsageContext = EMPTY_ACCOUNT_USAGE): ComfortFeedbackRecord {
  if (!record.personId) return record;
  const quotaAllocation = allocationForFeedback(record, data, official, history, now);
  const resolved = resolveComfortUsage(record, data, official, history, now, context);
  return {
    ...record,
    quotaAllocation,
    observedUsedPercent: resolved.usedPercent,
    usageCoverage: resolved.coverage,
  };
}

/** Upgrade existing assigned feedback once, retaining its feeling and raw total. */
export function backfillPersonAllocations(records: readonly ComfortFeedbackRecord[], data: TokeiUsage, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortFeedbackRecord[] | null {
  let changed = false;
  const next = records.map(record => {
    if (!record.personId) return record;
    const allocation = allocationForFeedback(record, data, official, history, now);
    const token = !record.tokenSnapshot || record.tokenSnapshot.coverage === "unavailable" ? buildTokenComfortSnapshot(data, record.personId, record.localDate, now) : null;
    const improveAllocation = (!record.quotaAllocation || record.quotaAllocation.coverage === "unavailable") && allocation?.coverage === "complete" && allocation.allocatedUsedPercent !== null;
    const improveToken = token?.coverage === "complete";
    if (!improveAllocation && !improveToken) return record;
    changed = true;
    return { ...record, ...(improveAllocation ? { quotaAllocation: allocation } : {}), ...(improveToken ? { tokenSnapshot: token } : {}), updatedAt: now.toISOString() };
  });
  return changed ? next : null;
}

const coverageRank = { unavailable: 0, partial: 1, complete: 2 };

/** Explicit refresh updates independent snapshots without downgrading coverage. */
export function refreshFeedbackUsage(record: ComfortFeedbackRecord, token: ComfortTokenSnapshot | null, allocation: ComfortQuotaAllocation | null): ComfortFeedbackRecord {
  const oldToken = record.tokenSnapshot;
  const oldAllocation = record.quotaAllocation;
  const acceptToken = token && token.coverage !== "unavailable"
    && coverageRank[token.coverage] >= coverageRank[oldToken?.coverage ?? "unavailable"]
    && !(token.coverage === "partial" && oldToken && token.totalTokens < oldToken.totalTokens);
  const acceptAllocation = allocation && allocation.coverage !== "unavailable" && allocation.allocatedUsedPercent !== null
    && coverageRank[allocation.coverage] >= coverageRank[oldAllocation?.coverage ?? "unavailable"];
  return { ...record, ...(acceptToken ? { tokenSnapshot: token } : {}), ...(acceptAllocation ? { quotaAllocation: allocation } : {}) };
}

export function missingComfortUsageReason(record: ComfortFeedbackRecord, data: TokeiUsage | null, zh: boolean, context: AccountUsageContext = EMPTY_ACCOUNT_USAGE): string {
  const result = resolveComfortUsage(record, data, [], [], new Date(), context);
  return result.reason ? comfortUsageReasonText(result.reason, zh) : "";
}
