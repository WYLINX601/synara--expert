import type { NativeApi, ProviderSkillReference } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { bindDraftExpertSkillInvocations } from "./expertSkillInvocation";

const packageId = `pkg_${"a".repeat(64)}`;
const draft: ProviderSkillReference = {
  name: "workflow",
  path: "/untrusted/source",
  expert: { snapshotId: "pending", packageId, entryPath: "workflow/SKILL.md" },
};
const threadId = ThreadId.makeUnsafe("test");
function fixture(userInvocable = true) {
  const api = {
    orchestration: {
      getThreadDetailSnapshot: vi.fn(async () => ({
        thread: { expertBinding: { snapshotId: "accepted" } },
      })),
    },
    server: {
      readExpertSnapshot: vi.fn(async () => ({
        snapshotId: "accepted",
        skillEntries: [
          {
            packageId,
            entryPath: "workflow/SKILL.md",
            name: "workflow",
            path: "/verified/package/workflow/SKILL.md",
            userInvocable,
          },
        ],
      })),
    },
  };
  return api;
}

describe("draft Expert skill binding", () => {
  it("binds only the selected package entry to the accepted task and discards client paths", async () => {
    const api = fixture();
    const result = await bindDraftExpertSkillInvocations(api as unknown as NativeApi, threadId, [
      draft,
    ]);
    expect(result[0]).toMatchObject({
      name: "workflow",
      expert: { snapshotId: "accepted", packageId, entryPath: "workflow/SKILL.md" },
    });
    expect(result[0]?.path).not.toContain("/untrusted");
    expect(api.server.readExpertSnapshot).toHaveBeenCalledWith({ snapshotId: "accepted" });
  });
  it("rejects a changed selection or an entry that disallows explicit invocation", async () => {
    const api = fixture();
    await expect(
      bindDraftExpertSkillInvocations(api as unknown as NativeApi, threadId, [
        { ...draft, expert: { ...draft.expert!, entryPath: "other/SKILL.md" } },
      ]),
    ).rejects.toThrow("固定配置");
    await expect(
      bindDraftExpertSkillInvocations(fixture(false) as unknown as NativeApi, threadId, [draft]),
    ).rejects.toThrow("固定配置");
  });
  it("never silently rebinds a real snapshot or touches ordinary references", async () => {
    const api = fixture();
    const pinned = { ...draft, expert: { ...draft.expert!, snapshotId: "original" } };
    const normal = { name: "normal", path: "/normal/SKILL.md" };
    expect(
      await bindDraftExpertSkillInvocations(api as unknown as NativeApi, threadId, [
        pinned,
        normal,
      ]),
    ).toEqual([pinned, normal]);
    expect(api.orchestration.getThreadDetailSnapshot).not.toHaveBeenCalled();
  });
});
