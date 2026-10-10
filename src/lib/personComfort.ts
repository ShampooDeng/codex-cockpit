import { buildComfortPrompt } from "./comfortFeedback";
import { buildPersonQuotaAllocation } from "./personQuotaAllocation";
import { buildTokenComfortSnapshot } from "./tokenComfort";
import type { TokeiUsage } from "./tokeiUsage";
import type { CodexDailyUsage, ComfortFeedbackRecord, ComfortQuotaAllocation, ComfortTokenSnapshot, DailyUsageSummary } from "../types";

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
export function personalFeedbackView(record: ComfortFeedbackRecord, data: TokeiUsage | null, official: readonly CodexDailyUsage[] = [], history: readonly DailyUsageSummary[] = [], now = new Date()): ComfortFeedbackRecord {
  if (!record.personId) return record;
  const quotaAllocation = allocationForFeedback(record, data, official, history, now);
  return {
    ...record,
    quotaAllocation,
    observedUsedPercent: quotaAllocation?.allocatedUsedPercent ?? null,
    usageCoverage: quotaAllocation?.coverage ?? "unavailable",
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

export function missingComfortUsageReason(record: ComfortFeedbackRecord, data: TokeiUsage | null, zh: boolean): string {
  const person = data?.groups.find(group => group.id === record.personId);
  if (person && !person.deviceIds.length) return zh ? "成员尚未关联设备，请在组员设置中关联本机。" : "Assign this device to the member in settings.";
  if (!data || data.localUsageStatus === "unavailable") return zh ? "用量采集暂不可用，已保留体验和原快照。" : "Usage collection is unavailable; saved feedback and snapshots are retained.";
  if (record.observedUsedPercent == null && record.quotaAllocation?.totalUsedPercent == null) return zh ? "缺少该日的历史额度参考；Token 可单独更新，百分比仍待补充。" : "Historical quota is missing; tokens can update independently while the percentage remains unknown.";
  if (data.localOnly) return zh ? "本机 Token 已独立统计；仅有本机成本无法确认共享账号的个人额度占比。" : "Local tokens are counted independently; local costs alone cannot establish your share of the account quota.";
  return zh ? "该日的设备日账或成本不完整，暂不能计算个人额度百分比。" : "This day's device ledger or costs are incomplete; the personal quota percentage is unavailable.";
}
