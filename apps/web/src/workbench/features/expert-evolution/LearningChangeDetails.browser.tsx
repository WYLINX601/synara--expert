import "../../../index.css";
import type {
  LearningChangeSet,
  LearningSkillChangeDetail,
  SkillEvolutionRequest,
  SkillEvolutionResponse,
  SpaceMemoryEntry,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  calls: [] as SkillEvolutionRequest[],
  changes: [] as LearningChangeSet[],
  memory: [] as SpaceMemoryEntry[],
  failure: "" as "" | "conflict" | "unknown" | "lost" | "saved_unbound" | "read" | "mismatch",
  revertGate: null as Promise<void> | null,
  skill: null as LearningSkillChangeDetail | null,
  opened: [] as string[],
  server: {
    skillEvolution: vi.fn<(request: SkillEvolutionRequest) => Promise<SkillEvolutionResponse>>(),
  },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ server: harness.server }) }));
import { LearningChangeDetails, learningChangesQueryOptions } from "./LearningChangeDetails";
import { skillEvolutionQueryKey } from "./model";

const scope = {
  ownerId: "owner",
  expertId: "expert",
  spaceId: "space-origin",
  projectId: "project-origin",
};
const source = {
  kind: "message" as const,
  messageId: "message-1",
  threadId: "thread-1",
  role: "user" as const,
  contentHash: `sha256:${"1".repeat(64)}`,
  quote: "以后先写三条结论。<script>window.untrusted=true</script>",
  truncated: true,
};
function memory(revision: number): SpaceMemoryEntry {
  return {
    memoryId: "memory-1",
    revision,
    contentHash: `sha256:${String(revision).repeat(64)}`,
    kind: "rule",
    key: "report.preference",
    content: revision === 1 ? "先列三条结论。" : "先列三条结论，再展开依据。",
    scope,
    projectBound: false,
    sourceRefs: [source],
    changeId: `change-${revision}`,
    commitSequence: revision,
    observedAt: "2026-10-31T01:00:00.000Z",
    status: "active",
  };
}
const ref = (revision: number) => ({
  assetKind: "memory" as const,
  memoryId: "memory-1",
  revision,
  contentHash: memory(revision).contentHash,
});
function change(): LearningChangeSet {
  return {
    changeId: "change-2",
    requestId: "request-2",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    ownerId: "owner",
    expertId: "expert",
    sourceScope: scope,
    assetKind: "memory",
    before: ref(1),
    after: ref(2),
    sourceRefs: [source],
    status: "committed",
    summary: "报告偏好",
    createdAt: "2026-10-31T01:00:00.000Z",
    updatedAt: "2026-10-31T01:00:00.000Z",
  };
}
let dispose: (() => Promise<void>) | undefined;
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(learningChangesQueryOptions("expert").queryKey, harness.changes);
  function Fixture() {
    const [open, setOpen] = useState(true);
    const changes = useQuery(learningChangesQueryOptions("expert"));
    return (
      <>
        <button onClick={() => setOpen(true)}>打开变化</button>
        <LearningChangeDetails
          change={
            open ? (changes.data?.find((item) => item.changeId === "change-2") ?? null) : null
          }
          expertId="expert"
          expertName="研究助手"
          sourceTitles={new Map([["thread-1", "论文阅读"]])}
          onOpenTask={(threadId) => harness.opened.push(threadId)}
          disabled={false}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  const view = await render(
    <QueryClientProvider client={client}>
      <Fixture />
    </QueryClientProvider>,
  );
  dispose = async () => {
    await view.unmount();
    client.clear();
  };
  await expect.element(page.getByRole("dialog")).toBeVisible();
  return client;
}
beforeEach(() => {
  harness.calls = [];
  harness.changes = [change()];
  harness.memory = [memory(1), memory(2)];
  harness.failure = "";
  harness.revertGate = null;
  harness.skill = null;
  harness.opened = [];
  harness.server.skillEvolution.mockReset().mockImplementation(async (request) => {
    harness.calls.push(request);
    if (request.action === "learningChanges") return { learningChanges: harness.changes };
    if (request.action === "learningReadSkillChange")
      return harness.skill ? { learningSkillChange: harness.skill } : {};
    if (request.action === "learningReadMemory") {
      if (harness.failure === "read") throw new Error("指定历史版本不可用");
      const entry = harness.memory.find((item) => item.revision === request.revision)!;
      return { memoryEntry: harness.failure === "mismatch" ? { ...entry, revision: 9 } : entry };
    }
    if (request.action === "learningRevert") {
      if (harness.revertGate) await harness.revertGate;
      if (harness.failure === "conflict")
        throw new Error("该变化与后续修改冲突：同一段审核顺序后来已被修改。");
      if (harness.failure === "unknown") throw new Error("连接中断，结果未知。");
      if (harness.failure === "saved_unbound") return { learningStatus: "saved_unbound" };
      const original = harness.changes[0]!;
      harness.changes = [{ ...original, status: "reverted" }];
      if (harness.failure === "lost") throw new Error("连接中断，结果未知。");
      return {
        learningStatus: "committed",
        learningChange: {
          ...original,
          revertsChangeId: original.changeId,
          changeId: "inverse",
          requestId: request.operationId,
          status: "committed",
        },
      };
    }
    return {};
  });
});
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

async function captureEvidence(name: string) {
  const directory = import.meta.env.VITE_PHASE2_EVIDENCE_DIR;
  if (typeof directory === "string" && directory)
    await page.screenshot({ path: `${directory}/${name}.png` });
}

describe("learning change detail", () => {
  it("reads exact memory revisions and renders source text, kind, scope and truncation without markup", async () => {
    const client = await mount();
    await expect.element(page.getByText("记忆 · 行为规则", { exact: true })).toBeVisible();
    await expect.element(page.getByText("先列三条结论。", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("先列三条结论，再展开依据。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(source.quote, { exact: true })).toBeVisible();
    await expect.element(page.getByText(/来源已截断/)).toBeVisible();
    await expect.element(page.getByText(/适用范围：研究助手 · 来源 Space/)).toBeVisible();
    expect(
      harness.calls
        .filter((item) => item.action === "learningReadMemory")
        .map((item) => (item.action === "learningReadMemory" ? item.revision : null)),
    ).toEqual([1, 2]);
    expect((window as unknown as { untrusted?: boolean }).untrusted).toBeUndefined();
    await client.invalidateQueries({ queryKey: skillEvolutionQueryKey("expert") });
    expect(harness.calls.filter((item) => item.action === "learningReadMemory")).toHaveLength(2);
  });
  it.each([
    {
      kind: "rule" as const,
      spaceId: "space-origin",
      projectBound: undefined,
      projectScoped: false,
    },
    {
      kind: "fact" as const,
      spaceId: "space-origin",
      projectBound: undefined,
      projectScoped: true,
    },
    { kind: "fact" as const, spaceId: "space-origin", projectBound: false, projectScoped: true },
    {
      kind: "environment" as const,
      spaceId: "space-origin",
      projectBound: false,
      projectScoped: true,
    },
    { kind: "rule" as const, spaceId: null, projectBound: undefined, projectScoped: true },
  ])(
    "uses formal project applicability for $kind / $spaceId / $projectBound",
    async ({ kind, spaceId, projectBound, projectScoped }) => {
      harness.memory = harness.memory.map((entry) => {
        const { projectBound: _previous, ...base } = entry;
        return {
          ...base,
          kind,
          scope: { ...entry.scope, spaceId },
          ...(projectBound === undefined ? {} : { projectBound }),
        };
      });
      await mount();
      const scopeText = page.getByText(/^适用范围：/);
      await expect.element(scopeText).toBeVisible();
      if (projectScoped) await expect.element(scopeText).toHaveTextContent("来源项目");
      else await expect.element(scopeText).not.toHaveTextContent("来源项目");
    },
  );

  it("confirms targeted undo only after its receipt and never sends a whole-version restore", async () => {
    let release!: () => void;
    harness.revertGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect.element(page.getByText("正在撤回本次学习…", { exact: true })).toBeVisible();
    await expect.element(undo).toBeDisabled();
    release();
    await expect
      .element(page.getByText("已撤回本次学习；其他变化与历史记录保留。", { exact: true }))
      .toBeVisible();
    const request = harness.calls.find((item) => item.action === "learningRevert")!;
    expect(request).toMatchObject({ expertId: "expert", changeId: "change-2" });
    expect(request).not.toHaveProperty("expectedRevision");
    expect(
      harness.calls.some((item) => item.action === "restore" || item.action === "restoreBinding"),
    ).toBe(false);
  });
  it("shows the conflict reason directly without claiming rollback or inventing current content", async () => {
    harness.failure = "conflict";
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("同一段审核顺序后来已被修改");
    await expect.element(page.getByText(/已撤回本次学习；/)).not.toBeInTheDocument();
    expect(harness.changes[0]!.status).toBe("committed");
  });
  it("keeps the same operation identity after an unknown outcome and reopening", async () => {
    harness.failure = "unknown";
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("结果未知");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "打开变化" }).click();
    await expect.element(undo).toBeEnabled();
    await undo.click();
    const requests = harness.calls.filter((item) => item.action === "learningRevert");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
  });
  it("does not claim completion for a saved but unbound inverse", async () => {
    harness.failure = "saved_unbound";
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("绑定尚未确认");
    await expect.element(page.getByText(/已撤回本次学习；/)).not.toBeInTheDocument();
  });
  it.each(["read", "mismatch"] as const)(
    "does not substitute current content when historical reading fails: %s",
    async (failure) => {
      harness.failure = failure;
      await mount();
      await expect.element(page.getByRole("alert")).toHaveTextContent("无法读取变化详情");
      await expect
        .element(page.getByRole("button", { name: "撤回本次学习", exact: true }))
        .toBeDisabled();
      await expect
        .element(page.getByText("尚未保存这条记忆。", { exact: true }))
        .not.toBeInTheDocument();
    },
  );
  it("fits the existing dialog at narrow width and closes it", async () => {
    await page.viewport(390, 844);
    await mount();
    await expect.element(page.getByText("记忆 · 行为规则", { exact: true })).toBeVisible();
    const dialog = page.getByRole("dialog").element();
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
    await page.getByRole("button", { name: "关闭变化详情", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("recovers a persisted undo after a lost response without another write", async () => {
    harness.failure = "lost";
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect
      .element(page.getByText("已撤回本次学习；其他变化与历史记录保留。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(harness.calls.filter((item) => item.action === "learningRevert")).toHaveLength(1);
    expect(
      harness.calls.filter((item) => item.action === "learningChanges").length,
    ).toBeGreaterThan(1);
  });
  it("opens the exact source task using its existing title", async () => {
    await mount();
    await page.getByRole("button", { name: "论文阅读", exact: true }).click();
    expect(harness.opened).toEqual(["thread-1"]);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps inverse history readable without offering an undo toggle", async () => {
    harness.changes = [{ ...change(), revertsChangeId: "original-learning" }];
    await mount();
    await expect.element(page.getByText("本次撤回已记录。", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "撤回本次学习", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("先列三条结论。", { exact: true })).toBeVisible();
  });
  it("renders immutable Skill differences, mode-only changes, binary and budget omissions", async () => {
    const original = change();
    harness.changes = [
      {
        ...original,
        assetKind: "skill",
        summary: "审核顺序",
        before: {
          assetKind: "skill",
          skillId: "skill-1",
          revision: 3,
          packageId: "package-before",
        },
        after: { assetKind: "skill", skillId: "skill-1", revision: 4, packageId: "package-after" },
      },
    ];
    const side = {
      size: 20,
      sha256: "a".repeat(64),
      executable: false,
      text: "先阅读代码，再判断是否为实际缺陷。",
    };
    harness.skill = {
      changeId: original.changeId,
      files: [
        {
          path: "SKILL.md",
          before: side,
          after: { ...side, text: "先复现问题，再判断是否为实际缺陷。", sha256: "b".repeat(64) },
        },
        {
          path: "verify.sh",
          before: { ...side, text: "check" },
          after: { ...side, text: "check", executable: true },
        },
        {
          path: "reference.bin",
          before: null,
          after: { size: 42, sha256: "c".repeat(64), executable: false, omittedReason: "binary" },
        },
        {
          path: "large.md",
          before: null,
          after: {
            size: 128001,
            sha256: "d".repeat(64),
            executable: false,
            omittedReason: "budget",
          },
        },
      ],
      coverage: ["additional-file-pairs-omitted:3", "file-text-omitted-by-content-budget:1"],
    };
    const client = await mount();
    await expect
      .element(page.getByText("先阅读代码，再判断是否为实际缺陷。", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("先复现问题，再判断是否为实际缺陷。", { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText("20 字节 · 可执行", { exact: true })).toBeVisible();
    await expect.element(page.getByText("二进制文件，未展示正文。", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("超出本次展示上限，正文已省略。", { exact: true }))
      .toBeVisible();
    await expect
      .element(page.getByText("另有 3 个文件变化超出本次展示上限，未展示。", { exact: true }))
      .toBeVisible();
    expect(harness.calls.some((item) => item.action === "learningReadMemory")).toBe(false);
    expect(harness.calls.find((item) => item.action === "learningReadSkillChange")).toEqual({
      action: "learningReadSkillChange",
      expertId: "expert",
      changeId: original.changeId,
    });
    await client.invalidateQueries({ queryKey: skillEvolutionQueryKey("expert") });
    expect(harness.calls.filter((item) => item.action === "learningReadSkillChange")).toHaveLength(
      1,
    );
  });
  it("renders wide and narrow Memory details and a direct Skill undo conflict", async () => {
    harness.changes = [
      {
        ...change(),
        sourceRefs: [
          { ...source, quote: "以后给我的摘要都先列三条结论，再展开依据。", truncated: false },
        ],
      },
    ];
    await page.viewport(1180, 900);
    await mount();
    await expect.element(page.getByText("记忆 · 行为规则", { exact: true })).toBeVisible();
    await captureEvidence("phase2-learning-wide-implemented");
    await page.viewport(390, 844);
    expect(page.getByRole("dialog").element().scrollWidth).toBeLessThanOrEqual(
      page.getByRole("dialog").element().clientWidth + 1,
    );
    await captureEvidence("phase2-learning-narrow-implemented");
    await dispose?.();
    dispose = undefined;
    harness.changes = [
      {
        ...change(),
        assetKind: "skill",
        summary: "审核顺序",
        sourceRefs: [
          { ...source, quote: "审核时先复现，再判断是不是实际缺陷。", truncated: false },
        ],
        before: {
          assetKind: "skill",
          skillId: "skill-1",
          revision: 3,
          packageId: "package-before",
        },
        after: { assetKind: "skill", skillId: "skill-1", revision: 4, packageId: "package-after" },
      },
    ];
    const side = {
      size: 54,
      sha256: "a".repeat(64),
      executable: false,
      text: "先阅读代码，再判断是否为实际缺陷。",
    };
    harness.skill = {
      changeId: "change-2",
      files: [
        {
          path: "SKILL.md",
          before: side,
          after: { ...side, text: "先复现问题，再判断是否为实际缺陷。", sha256: "b".repeat(64) },
        },
      ],
      coverage: [],
    };
    harness.failure = "conflict";
    await page.viewport(1180, 900);
    await mount();
    const undo = page.getByRole("button", { name: "撤回本次学习", exact: true });
    await expect.element(undo).toBeEnabled();
    await undo.click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("同一段审核顺序后来已被修改");
    await captureEvidence("phase2-learning-conflict-implemented");
  });
});
