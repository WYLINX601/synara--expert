import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ThreadId,
  type HubDeliverableCollection,
  type HubExpertSummary,
} from "@synara/contracts";
import { parseHubReferenceUri } from "@synara/shared/hubReferences";
import { buildHubReferenceMenuItems } from "./hubComposerReferences.logic";

const hubId = ProjectId.makeUnsafe("hub-a");
const expert: HubExpertSummary = {
  expertId: "research",
  displayName: "Research",
  description: "Evidence",
  useCases: "Research evidence",
  preferredProvider: "codex",
  available: true,
};
const collection: HubDeliverableCollection = {
  hubId,
  workerThreadId: ThreadId.makeUnsafe("worker-a"),
  revision: 1,
  state: "active",
  commitSha: "a".repeat(40),
  updatedAt: "2026-10-19T00:00:00Z",
  provenance: {
    hubId,
    workerThreadId: ThreadId.makeUnsafe("worker-a"),
    expertBindingSnapshotId: "snapshot-a",
    publishedAt: "2026-10-19T00:00:00Z",
  },
  expertBinding: { expertId: "research", displayName: "Research at acceptance", revision: 1 },
  sourceWorkTitle: "Source review",
  files: [
    {
      path: "brief.md",
      libraryPath: "internal/worker-a/brief.md",
      name: "brief.md",
      description: "Evidence",
      libraryState: "available",
      mediaType: "text/markdown",
      sizeBytes: 20,
      sha256: "b".repeat(64),
    },
  ],
};

function items(overrides: Partial<Parameters<typeof buildHubReferenceMenuItems>[0]> = {}) {
  return buildHubReferenceMenuItems({
    hubId,
    experts: [expert],
    deliverables: [collection],
    query: "",
    isCoordinator: true,
    ...overrides,
  });
}

describe("Hub composer references", () => {
  it("offers experts only on the Coordinator and keeps unavailable entries disabled", () => {
    expect(items({ isCoordinator: false }).map((item) => item.type)).toEqual(["hub-deliverable"]);
    expect(items({ experts: [{ ...expert, available: false }] })[0]).toMatchObject({
      type: "hub-expert",
      disabled: true,
    });
  });
  it("uses the published identity and version while exposing only the file label", () => {
    const item = items()[1]!;
    expect(item).toMatchObject({
      type: "hub-deliverable",
      label: "brief.md",
      expertDisplayName: "Research at acceptance",
    });
    expect(item.description).toBe("");
    if (item.type !== "hub-deliverable") throw new Error("Expected deliverable");
    expect(parseHubReferenceUri(item.mention.path)).toEqual({
      kind: "deliverable",
      hubId,
      workerThreadId: "worker-a",
      path: "brief.md",
      revision: 1,
    });
  });
  it("keeps equal filenames in different work items distinct and rejects another Hub", () => {
    const result = items({
      deliverables: [
        collection,
        { ...collection, workerThreadId: ThreadId.makeUnsafe("worker-b") },
        { ...collection, hubId: ProjectId.makeUnsafe("other") },
      ],
    });
    const files = result.filter((item) => item.type === "hub-deliverable");
    expect(files).toHaveLength(2);
    expect(new Set(files.map((item) => item.id)).size).toBe(2);
  });
  it("keeps exact duplicate references selectable and gives each row a unique key", () => {
    const file = collection.files[0]!;
    const result = items({
      deliverables: [{ ...collection, files: [file, file] }],
    }).filter((item) => item.type === "hub-deliverable");
    expect(result).toHaveLength(2);
    expect(result[0]?.mention.path).toBe(result[1]?.mention.path);
    expect(result[0]?.id).not.toBe(result[1]?.id);
  });
  it("uses 未知专家 when a publication has no accepted identity snapshot", () => {
    const result = items({
      isCoordinator: false,
      deliverables: [{ ...collection, expertBinding: undefined }],
    }).find((item) => item.type === "hub-deliverable");
    expect(result).toMatchObject({ expertDisplayName: "未知专家" });
  });
  it("excludes withdrawn sets and identifies missing resources without replacing them", () => {
    expect(items({ deliverables: [{ ...collection, state: "withdrawn" }] })).toHaveLength(1);
    const result = items({
      deliverables: [
        { ...collection, files: [{ ...collection.files[0]!, libraryState: "missing" }] },
      ],
    });
    expect(result[1]).toMatchObject({ disabled: true, label: "brief.md" });
  });
});
