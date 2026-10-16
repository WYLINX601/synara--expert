import "../../index.css";

import type { McpDiscoveryResult, McpImportResult } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  discoverMcpConnections: vi.fn<() => Promise<McpDiscoveryResult>>(),
  importMcpConnections: vi.fn<() => Promise<McpImportResult>>(),
  toast: vi.fn(),
}));
vi.mock("~/workbench/host/expertClient", () => ({ ensureExpertClient: () => harness }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));

import { LocalMcpDiscoveryPanel } from "./LocalMcpDiscoveryPanel";

let unmount: (() => Promise<void>) | undefined;
const onBack = vi.fn();
const onImported = vi.fn<() => Promise<void>>();

beforeEach(() => {
  vi.resetAllMocks();
  onImported.mockResolvedValue(undefined);
  harness.discoverMcpConnections.mockResolvedValue({
    scanId: "scan",
    sources: [],
    candidates: ["Alpha", "Beta"].map((name) => ({
      candidateId: name,
      name,
      suggestedId: name.toLowerCase(),
      sourceKind: "codex" as const,
      sourcePath: "/tmp/config.toml",
      sourceEntryId: name,
      protocol: "stdio" as const,
      summary: "local-mcp",
      status: "ready" as const,
      issues: [],
    })),
  });
  harness.importMcpConnections.mockResolvedValue({
    scanId: "scan",
    items: [{ candidateId: "Alpha", targetId: "alpha", status: "imported", revision: 1 }],
  });
});
afterEach(async () => {
  await unmount?.();
  unmount = undefined;
});

async function openAndSelect(names = ["Alpha"]) {
  const view = await render(<LocalMcpDiscoveryPanel onBack={onBack} onImported={onImported} />);
  unmount = () => view.unmount();
  for (const name of names)
    await page.getByRole("checkbox", { name: `选择 ${name}`, exact: true }).click();
  await page.getByRole("button", { name: `导入所选（${names.length}）`, exact: true }).click();
}

describe("local MCP import feedback", () => {
  it("returns after a successful refresh and shows only a success toast", async () => {
    await openAndSelect();
    await expect.poll(() => onBack.mock.calls.length).toBe(1);
    expect(onImported).toHaveBeenCalledOnce();
    expect(harness.toast).toHaveBeenCalledWith({ type: "success", title: "已导入 1 个 MCP 连接" });
    expect(page.getByText("导入结果", { exact: true }).length).toBe(0);
    expect(page.getByLabelText("发现流程").length).toBe(0);
  });

  it("keeps failed candidates selected and disables successful ones after partial success", async () => {
    harness.importMcpConnections.mockResolvedValue({
      scanId: "scan",
      items: [
        { candidateId: "Alpha", targetId: "alpha", status: "imported", revision: 1 },
        { candidateId: "Beta", targetId: "beta", status: "failed", message: "配置已变化" },
      ],
    });
    await openAndSelect(["Alpha", "Beta"]);
    await expect.poll(() => harness.toast.mock.calls.length).toBe(1);
    expect(onBack).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Alpha", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Alpha", exact: true }))
      .not.toBeChecked();
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Beta", exact: true }))
      .toBeChecked();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "成功 1 个，失败 1 个",
        description: expect.stringContaining("Beta：配置已变化"),
      }),
    );
  });

  it("reports expired scans in a toast and allows rescanning", async () => {
    harness.importMcpConnections.mockResolvedValue({
      scanId: "scan",
      items: [
        {
          candidateId: "Alpha",
          targetId: "alpha",
          status: "failed",
          message: "Discovery results expired.",
        },
      ],
    });
    await openAndSelect();
    await expect.poll(() => harness.toast.mock.calls.length).toBe(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(onImported).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "成功 0 个，失败 1 个" }),
    );
    await page.getByRole("button", { name: "重新扫描", exact: true }).click();
    await expect.poll(() => harness.discoverMcpConnections.mock.calls.length).toBe(2);
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Alpha", exact: true }))
      .not.toBeChecked();
  });

  it("does not misreport a list refresh failure as an import failure or allow reimport", async () => {
    onImported.mockRejectedValue(new Error("offline"));
    await openAndSelect();
    await expect.poll(() => harness.toast.mock.calls.length).toBe(1);
    expect(onBack).not.toHaveBeenCalled();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning", title: "已导入，列表刷新失败" }),
    );
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Alpha", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "导入所选（0）", exact: true }))
      .toBeDisabled();
  });

  it("reports a rejected request without leaving or clearing the selection", async () => {
    harness.importMcpConnections.mockRejectedValue(new Error("连接已断开"));
    await openAndSelect();
    await expect.poll(() => harness.toast.mock.calls.length).toBe(1);
    expect(harness.toast).toHaveBeenCalledWith({
      type: "error",
      title: "导入 MCP 连接失败",
      description: "连接已断开",
    });
    expect(onBack).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Alpha", exact: true }))
      .toBeChecked();
  });

  it("counts skipped items separately and does not call them imported", async () => {
    harness.importMcpConnections.mockResolvedValue({
      scanId: "scan",
      items: [{ candidateId: "Alpha", targetId: "alpha", status: "skipped" }],
    });
    await openAndSelect();
    await expect.poll(() => harness.toast.mock.calls.length).toBe(1);
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "info", title: "已跳过 1 个 MCP 连接" }),
    );
    expect(onImported).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
  });

  it("locks navigation and repeat import until the pending request completes", async () => {
    let finish!: (result: McpImportResult) => void;
    harness.importMcpConnections.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await openAndSelect();
    await expect.element(page.getByRole("button", { name: "导入中…", exact: true })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "← 返回连接列表", exact: true }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("checkbox", { name: "选择 Beta", exact: true }))
      .toBeDisabled();
    expect(harness.importMcpConnections).toHaveBeenCalledOnce();
    finish({
      scanId: "scan",
      items: [{ candidateId: "Alpha", targetId: "alpha", status: "imported", revision: 1 }],
    });
    await expect.poll(() => onBack.mock.calls.length).toBe(1);
  });
});
