import type { HubDeliverableCollection } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildHubDeliverableGroups } from "./hubDeliverablePresentation";

const collection = (options: {
  worker: string;
  snapshot: string;
  expertId?: string;
  expertName?: string;
  workTitle?: string;
  libraryPath: string;
  name: string;
  libraryState?: "available" | "missing";
  state?: "active" | "withdrawn";
}) =>
  ({
    hubId: "hub-1",
    workerThreadId: options.worker,
    revision: 2,
    state: options.state ?? "active",
    commitSha: "a".repeat(40),
    provenance: {
      hubId: "hub-1",
      workerThreadId: options.worker,
      expertBindingSnapshotId: options.snapshot,
      publishedAt: "2026-10-18T12:00:00Z",
    },
    expertBinding: {
      expertId: options.expertId ?? "expert-1",
      displayName: options.expertName ?? "Research Expert",
      revision: 1,
    },
    sourceWorkTitle: options.workTitle ?? "Research summary",
    files: [
      {
        path: `out/${options.name}`,
        libraryPath: options.libraryPath,
        currentLibraryPath: options.libraryPath,
        libraryState: options.libraryState ?? "available",
        name: options.name,
        description: null,
        mediaType: "text/markdown",
        sizeBytes: 12,
        sha256: "b".repeat(64),
      },
    ],
    updatedAt: "2026-10-18T12:00:00Z",
  }) as unknown as HubDeliverableCollection;

describe("buildHubDeliverableGroups", () => {
  it("groups active files by immutable Expert snapshot and source work with stable labels", () => {
    const groups = buildHubDeliverableGroups([
      collection({
        worker: "worker-b",
        snapshot: "snapshot-b",
        expertName: "Zeta Expert",
        workTitle: "Second task",
        libraryPath: "Artifacts/zeta.md",
        name: "zeta.md",
      }),
      collection({
        worker: "worker-a",
        snapshot: "snapshot-a",
        expertName: "Alpha Expert",
        workTitle: "Review",
        libraryPath: "Artifacts/beta.md",
        name: "beta.md",
      }),
      collection({
        worker: "worker-c",
        snapshot: "snapshot-a",
        expertName: "Alpha Expert",
        workTitle: "Draft",
        libraryPath: "Artifacts/alpha.md",
        name: "alpha.md",
      }),
      collection({
        worker: "worker-d",
        snapshot: "snapshot-different-accepted-snapshot",
        expertName: "Alpha Expert",
        workTitle: "Review",
        // Presentation must keep both workers even when their physical Library
        // path collides; the composer reference is worker and source-file based.
        libraryPath: "Artifacts/beta.md",
        name: "alpha-review.md",
      }),
    ]);

    expect(groups.map(({ key, name }) => [key, name])).toEqual([
      ['binding:["expert-1",1,"Alpha Expert"]', "Alpha Expert"],
      ['binding:["expert-1",1,"Zeta Expert"]', "Zeta Expert"],
    ]);
    expect(groups[0]?.works.map(({ key }) => key)).toEqual(["worker-c", "worker-a", "worker-d"]);
    expect(
      groups[0]?.works.map(({ title, key, items }) => [title, key, items[0]?.file.name]),
    ).toEqual([
      ["Draft", "worker-c", "alpha.md"],
      ["Review", "worker-a", "beta.md"],
      ["Review", "worker-d", "alpha-review.md"],
    ]);
  });

  it("keeps missing files marked while excluding withdrawn collections", () => {
    const groups = buildHubDeliverableGroups([
      collection({
        worker: "worker-missing",
        snapshot: "snapshot-a",
        libraryPath: "Artifacts/missing.md",
        name: "missing.md",
        libraryState: "missing",
      }),
      collection({
        worker: "worker-withdrawn",
        snapshot: "snapshot-a",
        libraryPath: "Artifacts/withdrawn.md",
        name: "withdrawn.md",
        state: "withdrawn",
      }),
    ]);

    expect(groups.flatMap((expert) => expert.works.flatMap((work) => work.items))).toMatchObject([
      { file: { name: "missing.md", libraryState: "missing" } },
    ]);
  });

  it("keeps older identity-less publications distinct by worker", () => {
    const old = collection({
      worker: "worker-old",
      snapshot: "snapshot-old",
      libraryPath: "Artifacts/old.md",
      name: "old.md",
    });
    const withoutProvenance = {
      ...old,
      provenance: null,
      expertBinding: undefined,
    } as unknown as HubDeliverableCollection;

    expect(buildHubDeliverableGroups([withoutProvenance]).map(({ key }) => key)).toEqual([
      "legacy-worker:worker-old",
    ]);
  });
});
