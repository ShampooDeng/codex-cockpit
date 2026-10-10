// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { COMFORT_CURVE_VERSION } from "../lib/comfortFeedback";
import { buildTokenComfortSnapshot } from "../lib/tokenComfort";
import { buildPersonQuotaAllocation } from "../lib/personQuotaAllocation";
import type { ComfortFeedbackRecord } from "../types";
import type { TokeiUsage } from "../lib/tokeiUsage";
import { PersonComfortSection } from "./PersonComfortSection";
import type { AccountUsageDeclaration } from "../lib/accountUsage";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 7, 14, 12)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("applies an explicit historical personal-account declaration to one valid record and explains the other", () => {
  const source = { ...data(), localOnly: true, localProfileScope: "a".repeat(64) };
  const valid = { ...record("alex", "comfortable"), observedUsedPercent: 18, quotaAllocation: null };
  const missing = { ...valid, localDate: "2026-08-13", observedUsedPercent: null, usageCoverage: "unavailable" as const };
  function Harness() {
    const [declarations, setDeclarations] = useState<AccountUsageDeclaration[]>([]);
    return <PersonComfortSection data={source} personId="alex" records={[missing, valid]} language="zh-CN" accountUsage={{ scope: source.localProfileScope, declarations }} onAccountUsageChange={setDeclarations} onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={vi.fn()} />;
  }
  const { container } = render(<Harness />);
  expect(screen.getByText("已保存 2 条体验，其中 0 条可用于曲线。")).toBeInTheDocument();
  fireEvent.click(screen.getByText("账号使用方式 · 未确认"));
  fireEvent.change(screen.getByLabelText("账号使用方式"), { target: { value: "exclusive" } });
  fireEvent.change(screen.getByLabelText("生效日期"), { target: { value: "2026-08-12" } });
  expect(screen.getByRole("button", { name: "应用使用方式" })).toBeDisabled();
  fireEvent.click(screen.getByLabelText("也应用到所选历史日期起的记录"));
  fireEvent.click(screen.getByRole("button", { name: "应用使用方式" }));
  expect(screen.getByText("已保存 2 条体验，其中 1 条可用于曲线。")).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  expect(screen.getByText(/^1 条：缺少该日的历史额度参考/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("gridcell", { name: /8月12日.*18%/ }));
  expect(screen.getByText(/仅本人使用 · 采用账号额度记录 · 部分采集/)).toBeInTheDocument();
  expect(valid.quotaAllocation).toBeNull();
});

function data(): TokeiUsage {
  const day = (tokens: number, cost: number) => ({ inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: tokens, estimatedCostUsd: cost, models: [] });
  return { fetchedAt: new Date().toISOString(), status: "ready", defaultGroupId: "alex", groups: [{ id: "alex", name: "成员甲", deviceIds: ["mac"] }, { id: "blair", name: "成员乙", deviceIds: ["pc"] }], warnings: [], projectBreakdownAvailable: true, devices: [
    { id: "mac", updatedAt: new Date().toISOString(), stale: false, daily: { "2026-08-12": day(2e6, 30) }, ranges: {} },
    { id: "pc", updatedAt: new Date().toISOString(), stale: false, daily: { "2026-08-12": day(8e6, 70) }, ranges: {} },
  ] };
}
function record(personId: string | null, comfort: ComfortFeedbackRecord["comfort"]): ComfortFeedbackRecord {
  const entry: ComfortFeedbackRecord = { localDate: "2026-08-12", observedAt: new Date().toISOString(), personId, comfort, observedUsedPercent: personId ? 12 : 33, usageObservedAt: new Date().toISOString(), usageCoverage: "partial", usageSource: "official-snapshot", curveVersion: COMFORT_CURVE_VERSION, tokenSnapshot: personId ? buildTokenComfortSnapshot(data(), personId, "2026-08-12") : null };
  return { ...entry, quotaAllocation: personId ? buildPersonQuotaAllocation(data(), personId, entry.localDate, entry) : null };
}

it("switches people without showing the other person's feedback or assigning legacy records", () => {
  const records = [record("alex", "comfortable"), record("blair", "overloaded"), record(null, "idle")];
  function Harness() {
    const [personId, setPersonId] = useState<string | null>("alex");
    return <PersonComfortSection data={data()} personId={personId} records={records} language="zh-CN" onPersonChange={setPersonId} onChange={vi.fn()} onRefreshSnapshot={vi.fn()} />;
  }
  const { container } = render(<Harness />);
  expect(screen.getByLabelText("谁的体验").closest("header")).toHaveTextContent("舒适曲线");
  expect(screen.getByRole("gridcell", { name: /8月12日.*刚刚好.*≈3.6%/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("谁的体验"), { target: { value: "blair" } });
  expect(screen.getByRole("gridcell", { name: /8月12日.*有点撑.*≈8.4%/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  fireEvent.change(screen.getByLabelText("谁的体验"), { target: { value: "" } });
  expect(screen.getByRole("gridcell", { name: /8月12日.*很轻松/ })).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(1);
  expect(screen.getByRole("radio", { name: "刚刚好" })).toBeDisabled();
  expect(records[2].personId).toBeNull();
});

it("shows the saved snapshot instead of silently replacing it with a newer daily total", () => {
  const stored = record("alex", "comfortable");
  const newer = data();
  newer.devices[0].daily["2026-08-12"].totalTokens = 10e6;
  newer.devices[0].daily["2026-08-12"].inputTokens = 10e6;
  newer.devices[0].daily["2026-08-12"].estimatedCostUsd = 300;
  const refresh = vi.fn();
  render(<PersonComfortSection data={newer} personId="alex" records={[stored]} language="zh-CN" onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={refresh} />);
  fireEvent.click(screen.getByRole("gridcell", { name: /8月12日.*≈3.6%/ }));
  expect(screen.queryByText("分摊明细")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "更新分摊" })).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "刚刚好" })).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
});

it("shows fixed-form efficiency with directly labeled percentage axes", () => {
  const { container } = render(<PersonComfortSection data={data()} personId="alex" records={[record("alex", "comfortable")]} language="zh-CN" onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={vi.fn()} />);
  expect(screen.getByText("个人估算用量（%）").closest("svg")).not.toBeNull();
  expect(screen.getByText("相对效率（评分）").closest("svg")).not.toBeNull();
  expect(container.querySelector(".token-comfort-trend")).toBeNull();
  expect(container.querySelector(".comfort-curve-line--personalized")).not.toBeNull();
  expect(screen.queryByText("每日 Token（M）")).toBeNull();
});

it("keeps saved experiences visible when percentage data is unavailable and offers token refresh", () => {
  const source = data(); source.localOnly = true;
  const stored = { ...record("alex", "comfortable"), observedUsedPercent: null, usageCoverage: "unavailable" as const, quotaAllocation: null };
  const refresh = vi.fn();
  const { container } = render(<PersonComfortSection data={source} personId="alex" records={[stored]} language="zh-CN" onPersonChange={vi.fn()} onChange={vi.fn()} onRefreshSnapshot={refresh} />);
  expect(screen.getByText("已保存 1 条体验，其中 0 条可用于曲线。")).toBeInTheDocument();
  expect(container.querySelectorAll(".comfort-curve-observation")).toHaveLength(0);
  fireEvent.click(screen.getByRole("gridcell", { name: /8月12日.*刚刚好/ }));
  expect(screen.getByText(/已保存体验.*额度百分比暂不可用/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "更新用量" }));
  expect(refresh).toHaveBeenCalledWith("2026-08-12");
});
