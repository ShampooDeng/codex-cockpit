// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useComfortUsage } from "./useComfortUsage";
import { createUsagePreview } from "./tokeiUsage";
const read = vi.hoisted(() => vi.fn());
vi.mock("./tokeiBridge", () => ({ getTokeiUsage: read }));

it("returns the same fresh native ledger to the saver and the rendered state", async () => {
  const first = { ...createUsagePreview(new Date(2026, 8, 10, 12)), localDeviceId: "local-test-device" };
  read.mockResolvedValueOnce(first);
  const hook = renderHook(() => useComfortUsage(true));
  await waitFor(() => expect(hook.result.current.data).toBe(first));
  expect(hook.result.current.localDeviceId).toBe("local-test-device");
  const fresh = { ...first, fetchedAt: "2026-09-10T05:00:00Z" };
  read.mockResolvedValueOnce(fresh);
  await act(async () => { expect(await hook.result.current.refresh()).toBe(fresh); });
  expect(hook.result.current.data).toBe(fresh);
  read.mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await expect(hook.result.current.refresh()).rejects.toThrow("offline"); });
  expect(hook.result.current.data).toBe(fresh);
  expect(hook.result.current.error).toBe(true);
  hook.unmount();
});
