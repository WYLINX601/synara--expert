import {
  ProjectId,
  ThreadId,
  type HubDeliverableReadResult,
  type HubDeliverableReferenceMetadata,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectAgentServiceShape } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProjectAgentServiceError } from "../../projectAgent/Errors.ts";
import type { ProjectAgentPrincipal } from "../../projectAgent/principal.ts";
import { makeHubPlanDeliverableValidator } from "./hubPlanService.ts";

const HUB_ID = ProjectId.makeUnsafe("hub-plan-deliverable-validation");
const OTHER_HUB_ID = ProjectId.makeUnsafe("other-hub-plan-deliverable-validation");
const AUTHOR_THREAD_ID = ThreadId.makeUnsafe("hub-plan-deliverable-author");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("hub-plan-deliverable-other-worker");

const workerPrincipal: ProjectAgentPrincipal = {
  kind: "worker",
  projectId: HUB_ID,
  threadId: AUTHOR_THREAD_ID,
  taskId: null,
};

function reference(
  overrides: Partial<HubDeliverableReferenceMetadata> = {},
): HubDeliverableReferenceMetadata {
  return {
    hubId: HUB_ID,
    workerThreadId: AUTHOR_THREAD_ID,
    revision: 7,
    commitSha: "a".repeat(40),
    provenance: {
      hubId: HUB_ID,
      workerThreadId: AUTHOR_THREAD_ID,
      expertBindingSnapshotId: "binding-snapshot-7",
      publishedAt: "2026-10-23T00:00:00.000Z",
    },
    file: {
      path: "reports/final.md",
      libraryPath: "Hub Deliverables/hub-plan-deliverable-author/7/reports/final.md",
      name: "Final report",
      description: "Reviewed plan result",
      mediaType: "text/markdown",
      sizeBytes: 32,
      sha256: "b".repeat(64),
    },
    ...overrides,
  };
}

function readResult(metadata: HubDeliverableReferenceMetadata): HubDeliverableReadResult {
  return { ...metadata, content: { encoding: "utf-8", text: "fixed publication body" } };
}

type Deliverables = NonNullable<ProjectAgentServiceShape["deliverables"]>;
type ResolveReferenceInput = Parameters<Deliverables["resolveReference"]>[0];
type ReadInput = Parameters<Deliverables["read"]>[0];

function harness(
  options: {
    readonly principal?: ProjectAgentPrincipal;
    readonly actualReference?: HubDeliverableReferenceMetadata;
    readonly readError?: string;
  } = {},
) {
  const resolvedPrincipal = options.principal ?? workerPrincipal;
  const actualReference = options.actualReference ?? reference();
  const resolvePrincipalForThread = vi.fn(
    (_threadId: ThreadId): Effect.Effect<ProjectAgentPrincipal, ProjectAgentServiceError> =>
      Effect.succeed(resolvedPrincipal),
  );
  const resolveReference = vi.fn(
    (
      _input: ResolveReferenceInput,
      _principal: ProjectAgentPrincipal,
    ): Effect.Effect<HubDeliverableReferenceMetadata, ProjectAgentServiceError> =>
      Effect.succeed(actualReference),
  );
  const read = vi.fn(
    (
      _input: ReadInput,
      _principal: ProjectAgentPrincipal,
    ): Effect.Effect<HubDeliverableReadResult, ProjectAgentServiceError> =>
      options.readError
        ? Effect.fail(new ProjectAgentServiceError({ message: options.readError }))
        : Effect.succeed(readResult(actualReference)),
  );
  const projectAgent = {
    resolvePrincipalForThread,
    deliverables: { resolveReference, read },
  } as unknown as Pick<ProjectAgentServiceShape, "deliverables" | "resolvePrincipalForThread">;

  return {
    validate: makeHubPlanDeliverableValidator(projectAgent),
    resolvePrincipalForThread,
    resolveReference,
    read,
  };
}

describe("Hub plan deliverable validation host adapter", () => {
  it("forwards the resolved Worker principal and reads the exact fixed publication revision", async () => {
    const item = reference();
    const service = harness({ principal: workerPrincipal, actualReference: item });

    await expect(
      Effect.runPromise(service.validate(HUB_ID, [item], AUTHOR_THREAD_ID)),
    ).resolves.toBeUndefined();

    const exactReadInput = {
      projectId: HUB_ID,
      ownerThreadId: AUTHOR_THREAD_ID,
      path: item.file.path,
      revision: item.revision,
    };
    expect(service.resolvePrincipalForThread).toHaveBeenCalledExactlyOnceWith(AUTHOR_THREAD_ID);
    expect(service.resolveReference).toHaveBeenCalledExactlyOnceWith(
      exactReadInput,
      workerPrincipal,
    );
    expect(service.read).toHaveBeenCalledExactlyOnceWith(exactReadInput, workerPrincipal);
  });

  it.each([
    ["user", { kind: "user" }],
    [
      "cross-Hub Worker",
      { kind: "worker", projectId: OTHER_HUB_ID, threadId: AUTHOR_THREAD_ID, taskId: null },
    ],
    ["group member", { kind: "group-member", projectId: HUB_ID, threadId: AUTHOR_THREAD_ID }],
    [
      "wrong-thread Worker",
      { kind: "worker", projectId: HUB_ID, threadId: OTHER_THREAD_ID, taskId: null },
    ],
  ] as const)(
    "rejects a resolved %s before opening deliverable files",
    async (_label, principal) => {
      const service = harness({ principal });

      await expect(
        Effect.runPromise(service.validate(HUB_ID, [reference()], AUTHOR_THREAD_ID)),
      ).rejects.toThrow("The candidate author is not a Worker in this Hub.");
      expect(service.resolveReference).not.toHaveBeenCalled();
      expect(service.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["Hub", reference({ hubId: OTHER_HUB_ID })],
    ["Worker thread", reference({ workerThreadId: OTHER_THREAD_ID })],
    [
      "provenance Worker thread",
      reference({
        provenance: { ...reference().provenance, workerThreadId: OTHER_THREAD_ID },
      }),
    ],
  ] as const)(
    "rejects a reference with a mismatched %s before file access",
    async (_label, item) => {
      const service = harness();

      await expect(
        Effect.runPromise(service.validate(HUB_ID, [item], AUTHOR_THREAD_ID)),
      ).rejects.toThrow("Candidate outputs must belong to this Hub's author attempt.");
      expect(service.resolveReference).not.toHaveBeenCalled();
      expect(service.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "file digest",
      (item: HubDeliverableReferenceMetadata) => ({ ...item.file, sha256: "c".repeat(64) }),
    ],
    ["commit", (item: HubDeliverableReferenceMetadata) => ({ ...item, commitSha: "c".repeat(40) })],
    [
      "Expert snapshot",
      (item: HubDeliverableReferenceMetadata) => ({
        ...item.provenance,
        expertBindingSnapshotId: "different-binding-snapshot",
      }),
    ],
  ] as const)("rejects changed %s metadata before reading the file", async (label, mutate) => {
    const item = reference();
    const changed =
      label === "file digest"
        ? { ...item, file: mutate(item) }
        : label === "commit"
          ? mutate(item)
          : { ...item, provenance: mutate(item) };
    const service = harness({ actualReference: changed });

    await expect(
      Effect.runPromise(service.validate(HUB_ID, [item], AUTHOR_THREAD_ID)),
    ).rejects.toThrow("The fixed candidate publication no longer matches its recorded digest.");
    expect(service.resolveReference).toHaveBeenCalledOnce();
    expect(service.read).not.toHaveBeenCalled();
  });

  it("fails closed when the fixed publication body is missing", async () => {
    const item = reference();
    const service = harness({ actualReference: item, readError: "Published content is missing." });

    await expect(
      Effect.runPromise(service.validate(HUB_ID, [item], AUTHOR_THREAD_ID)),
    ).rejects.toThrow("Published content is missing.");
    expect(service.resolveReference).toHaveBeenCalledOnce();
    expect(service.read).toHaveBeenCalledWith(
      {
        projectId: HUB_ID,
        ownerThreadId: AUTHOR_THREAD_ID,
        path: item.file.path,
        revision: item.revision,
      },
      workerPrincipal,
    );
  });
});
