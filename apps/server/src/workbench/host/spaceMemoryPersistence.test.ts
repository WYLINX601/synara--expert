import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { LearningSourceReference, MemoryScope } from "@synara/contracts";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { SpaceMemoryService } from "../../spaceMemory/SpaceMemoryService.ts";
import { SpaceMemoryServiceLive } from "../../spaceMemory/SpaceMemoryService.ts";
import { SpaceMemoryRepositoryLive } from "./spaceMemoryPersistence.ts";
import { vi } from "vitest";

const layer = it.layer(
  SpaceMemoryServiceLive.pipe(
    Layer.provideMerge(SpaceMemoryRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

const scope = (patch: Partial<MemoryScope> = {}): MemoryScope => ({
  ownerId: "owner-a",
  spaceId: "space-a",
  expertId: "expert-a",
  projectId: "project-a",
  ...patch,
});

const source: LearningSourceReference = {
  kind: "message",
  messageId: "message-a",
  threadId: "thread-a",
  turnId: "turn-a",
  role: "user",
  contentHash: `sha256:${"a".repeat(64)}`,
  quote: "Keep the report concise.",
};

const fragmentHash = (quote: string) =>
  `sha256:${createHash("sha256").update(quote, "utf8").digest("hex")}`;

const withFragmentHash = (sourceRef: LearningSourceReference): LearningSourceReference => {
  if (sourceRef.quote === undefined) return sourceRef;
  return { ...sourceRef, fragmentHash: fragmentHash(sourceRef.quote) } as LearningSourceReference;
};

const commitInput = (
  requestId: string,
  patch: Partial<{
    scope: MemoryScope;
    memoryId: string;
    expectedRevision: number;
    kind: "rule" | "fact" | "environment";
    key: string;
    content: string;
    projectBound: boolean;
    sources: readonly LearningSourceReference[];
    requestFingerprint: string;
    observedAt: string;
    validUntil: string;
  }> = {},
) => ({
  scope: scope(),
  expectedRevision: 0,
  kind: "rule" as const,
  key: "report.preference",
  content: "Lead with the conclusion.",
  sources: [source],
  requestId,
  requestFingerprint: `sha256:${"b".repeat(64)}`,
  observedAt: "2026-10-31T00:00:00.000Z",
  ...patch,
});

const reverseJsonKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(reverseJsonKeys)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reverseJsonKeys(child)]),
        )
      : value;

layer("Space Memory domain and SQL persistence", (test) => {
  test.effect(
    "keeps rules at the Expert-Space scope and facts and Void rules at the Project scope",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tracker = yield* sql<{ readonly max_id: number }>`
        SELECT MAX(migration_id) AS max_id FROM workbench_sql_migrations WHERE module_id = 'expert'
      `;
        assert.strictEqual(tracker[0]?.max_id, 13);
        const memoryTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `;
        assert.includeMembers(
          memoryTables.map(({ name }) => name),
          ["space_memory_sequences", "learning_change_sets"],
        );
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-scope" });
        yield* memory.commit(commitInput("space-rule", { scope: currentScope }));
        yield* memory.commit(
          commitInput("project-fact", {
            scope: currentScope,
            memoryId: "fact-a",
            kind: "fact",
            key: "test.path",
            content: "tests/integration",
            requestFingerprint: `sha256:${"c".repeat(64)}`,
          }),
        );
        yield* memory.commit(
          commitInput("void-rule", {
            scope: { ...currentScope, spaceId: null },
            memoryId: "void-rule-a",
            key: "void.preference",
            content: "Use the Void project default.",
            requestFingerprint: `sha256:${"d".repeat(64)}`,
          }),
        );

        const otherProject = yield* memory.readApplicable({
          scope: { ...currentScope, projectId: "project-b" },
        });
        assert.deepStrictEqual(
          otherProject.map(({ key }) => key),
          ["report.preference"],
        );
        const otherProjectManifest = yield* memory.prepareRunManifest({
          scope: { ...currentScope, projectId: "project-b" },
          rootRunId: "root-run-project-b",
          snapshotId: "snapshot-project-b",
        });
        const sharedRuleReceipt = yield* memory.recordRead(
          otherProjectManifest.id,
          otherProject[0]!,
          "tool-call-project-b",
        );
        assert.strictEqual(sharedRuleReceipt.memoryId, otherProject[0]?.memoryId);
        const sameProject = yield* memory.readApplicable({ scope: currentScope });
        assert.deepStrictEqual(
          sameProject.map(({ key }) => key),
          ["report.preference", "test.path"],
        );
        const otherVoidProject = yield* memory.readApplicable({
          scope: { ...currentScope, spaceId: null, projectId: "project-b" },
        });
        assert.deepStrictEqual(otherVoidProject, []);
        assert.strictEqual(yield* memory.ruleSequence("owner-empty"), 0);
      }),
  );

  test.effect("normalizes validity instants and fails closed for expired or invalid rules", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-31T12:00:00.000Z"));
      try {
        const sql = yield* SqlClient.SqlClient;
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-valid-until" });
        const pastOffset = "2026-10-31T11:50:00.000+08:00";
        const futureOffset = "2026-10-31T07:10:00.000-05:00";

        const expired = yield* memory.commit(
          commitInput("valid-until-expired", {
            scope: currentScope,
            memoryId: "valid-until-expired",
            key: "validity.same-key",
            validUntil: pastOffset,
          }),
        );
        assert.strictEqual(expired.entry.validUntil, "2026-10-31T03:50:00.000Z");
        assert.deepStrictEqual(
          yield* memory.readApplicable({ scope: currentScope, kinds: ["rule"] }),
          [],
        );

        const relearned = yield* memory.commit(
          commitInput("valid-until-relearned", {
            scope: currentScope,
            memoryId: "valid-until-relearned",
            key: "validity.same-key",
          }),
        );
        assert.strictEqual(relearned.entry.key, expired.entry.key);

        const future = yield* memory.commit(
          commitInput("valid-until-future", {
            scope: currentScope,
            memoryId: "valid-until-future",
            key: "validity.future",
            validUntil: futureOffset,
          }),
        );
        assert.strictEqual(future.entry.validUntil, "2026-10-31T12:10:00.000Z");
        const exactBoundary = yield* memory.commit(
          commitInput("valid-until-boundary", {
            scope: currentScope,
            memoryId: "valid-until-boundary",
            key: "validity.boundary",
            validUntil: "2026-10-31T07:00:00.000-05:00",
          }),
        );
        const currentRules = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
          includeShadowed: true,
        });
        assert.include(
          currentRules.map(({ memoryId }) => memoryId),
          future.entry.memoryId,
        );
        assert.notInclude(
          currentRules.map(({ memoryId }) => memoryId),
          expired.entry.memoryId,
        );
        assert.notInclude(
          currentRules.map(({ memoryId }) => memoryId),
          exactBoundary.entry.memoryId,
        );

        const invalidWrite = yield* Effect.flip(
          memory.commit(
            commitInput("valid-until-invalid-write", {
              scope: currentScope,
              memoryId: "valid-until-invalid-write",
              key: "validity.invalid-write",
              validUntil: "tomorrow",
            }),
          ),
        );
        assert.match(String(invalidWrite), /validUntil must be a parseable date-time/u);

        const expiringOverride = yield* memory.commit(
          commitInput("valid-until-override-v1", {
            scope: currentScope,
            memoryId: "valid-until-override",
            key: "validity.override",
            validUntil: pastOffset,
          }),
        );
        const currentOverrideRevision = yield* memory.commit(
          commitInput("valid-until-override-v2", {
            scope: currentScope,
            memoryId: expiringOverride.entry.memoryId,
            expectedRevision: expiringOverride.entry.revision,
            key: "validity.override",
            content: "A later still-valid revision.",
            validUntil: futureOffset,
            requestFingerprint: `sha256:${"c".repeat(64)}`,
          }),
        );
        const latestOverrideRead = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
        });
        assert.include(
          latestOverrideRead.map(({ memoryId }) => memoryId),
          currentOverrideRevision.entry.memoryId,
        );
        const expiredOverrideRead = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
          overrides: [
            {
              memoryId: expiringOverride.entry.memoryId,
              revision: expiringOverride.entry.revision,
              contentHash: expiringOverride.entry.contentHash,
            },
          ],
        });
        assert.notInclude(
          expiredOverrideRead.map(({ memoryId }) => memoryId),
          expiringOverride.entry.memoryId,
        );

        const legacyInvalid = yield* memory.commit(
          commitInput("valid-until-legacy-invalid", {
            scope: currentScope,
            memoryId: "valid-until-legacy-invalid",
            key: "validity.legacy-invalid",
            validUntil: futureOffset,
          }),
        );
        const legacyBody: Record<string, unknown> = {
          ...legacyInvalid.entry,
          validUntil: "tomorrow",
        };
        delete legacyBody.contentHash;
        const legacyHash = `sha256:${createHash("sha256")
          .update(stableJsonStringify(legacyBody))
          .digest("hex")}`;
        const legacyRecord = JSON.stringify({ ...legacyBody, contentHash: legacyHash });
        yield* sql`
          UPDATE space_memory_revisions
          SET record_json = ${legacyRecord}
          WHERE owner_id = ${currentScope.ownerId}
            AND memory_id = ${legacyInvalid.entry.memoryId}
            AND revision = ${legacyInvalid.entry.revision}
        `;
        const withoutLegacyInvalid = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
          includeShadowed: true,
        });
        assert.notInclude(
          withoutLegacyInvalid.map(({ memoryId }) => memoryId),
          legacyInvalid.entry.memoryId,
        );
        const legacyDuplicateReplacement = yield* memory.commit(
          commitInput("valid-until-legacy-relearned", {
            scope: currentScope,
            memoryId: "valid-until-legacy-relearned",
            key: "validity.legacy-invalid",
          }),
        );
        assert.strictEqual(legacyDuplicateReplacement.entry.key, legacyInvalid.entry.key);
      } finally {
        vi.useRealTimers();
      }
    }),
  );

  test.effect(
    "shadows shared rules with project rules while preserving immutable logical scope",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const projectA = scope({ ownerId: "owner-project-bound" });
        const projectB = { ...projectA, projectId: "project-b" };
        const global = yield* memory.commit(
          commitInput("global-default", {
            scope: projectA,
            memoryId: "global-default",
            key: "report.style",
            content: "Use the shared format.",
          }),
        );
        assert.strictEqual(global.entry.projectBound, false);

        const duplicateGlobal = yield* Effect.flip(
          memory.commit(
            commitInput("duplicate-global", {
              scope: projectB,
              memoryId: "duplicate-global",
              key: "report.style",
              content: "A duplicate shared format.",
            }),
          ),
        );
        assert.match(String(duplicateGlobal), /same logical scope/u);

        const movedGlobal = yield* memory.commit(
          commitInput("edit-global-from-project-b", {
            scope: projectB,
            memoryId: global.entry.memoryId,
            expectedRevision: 1,
            key: "report.style",
            content: "Use the edited shared format.",
            requestFingerprint: `sha256:${"e".repeat(64)}`,
          }),
        );
        assert.strictEqual(movedGlobal.entry.scope.projectId, projectA.projectId);
        assert.strictEqual(movedGlobal.entry.projectBound, false);
        assert.strictEqual(movedGlobal.changeSet.sourceScope.projectId, projectB.projectId);

        const local = yield* memory.commit(
          commitInput("project-local-rule", {
            scope: projectA,
            memoryId: "project-local-rule",
            key: "report.style",
            content: "Use the project format.",
            projectBound: true,
            requestFingerprint: `sha256:${"f".repeat(64)}`,
          }),
        );
        assert.strictEqual(local.entry.projectBound, true);
        const duplicateLocal = yield* Effect.flip(
          memory.commit(
            commitInput("duplicate-project-local-rule", {
              scope: projectA,
              memoryId: "duplicate-project-local-rule",
              key: "report.style",
              content: "A second project format.",
              projectBound: true,
              requestFingerprint: `sha256:${"1".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(duplicateLocal), /same logical scope/u);
        const localB = yield* memory.commit(
          commitInput("project-b-local-rule", {
            scope: projectB,
            memoryId: "project-b-local-rule",
            key: "report.style",
            content: "Use project B's format.",
            projectBound: true,
            requestFingerprint: `sha256:${"c".repeat(64)}`,
          }),
        );
        assert.strictEqual(localB.entry.projectBound, true);

        const selectedA = yield* memory.readApplicable({ scope: projectA, kinds: ["rule"] });
        assert.deepStrictEqual(
          selectedA.map(({ key, content }) => ({ key, content })),
          [{ key: "report.style", content: "Use the project format." }],
        );
        const catalogA = yield* memory.readApplicable({
          scope: projectA,
          kinds: ["rule"],
          includeShadowed: true,
        });
        assert.deepStrictEqual(
          catalogA.map(({ memoryId }) => memoryId).sort(),
          [global.entry.memoryId, local.entry.memoryId].sort(),
        );
        const selectedB = yield* memory.readApplicable({ scope: projectB, kinds: ["rule"] });
        assert.deepStrictEqual(
          selectedB.map(({ memoryId }) => memoryId),
          [localB.entry.memoryId],
        );

        const exactAfterWatermark = yield* memory.readApplicable({
          scope: projectA,
          kinds: ["rule"],
          ruleSequence: global.entry.commitSequence,
          overrides: [
            {
              memoryId: local.entry.memoryId,
              revision: local.entry.revision,
              contentHash: local.entry.contentHash,
            },
          ],
        });
        assert.deepStrictEqual(
          exactAfterWatermark.map(({ memoryId }) => memoryId),
          [local.entry.memoryId],
        );

        const widenedGlobal = yield* Effect.flip(
          memory.commit(
            commitInput("narrow-global-in-place", {
              scope: projectA,
              memoryId: global.entry.memoryId,
              expectedRevision: 2,
              key: "report.style",
              projectBound: true,
              requestFingerprint: `sha256:${"2".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(widenedGlobal), /cannot change its project boundary/u);
        const widenedLocal = yield* Effect.flip(
          memory.commit(
            commitInput("widen-local-in-place", {
              scope: projectA,
              memoryId: local.entry.memoryId,
              expectedRevision: 1,
              key: "report.style",
              projectBound: false,
              requestFingerprint: `sha256:${"3".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(widenedLocal), /cannot change its project boundary/u);
        const changedKey = yield* Effect.flip(
          memory.commit(
            commitInput("change-key-in-place", {
              scope: projectA,
              memoryId: local.entry.memoryId,
              expectedRevision: 1,
              key: "different.key",
              requestFingerprint: `sha256:${"4".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(changedKey), /cannot change its kind or key/u);
        const changedKind = yield* Effect.flip(
          memory.commit(
            commitInput("change-kind-in-place", {
              scope: projectA,
              memoryId: local.entry.memoryId,
              expectedRevision: 1,
              key: "report.style",
              kind: "fact",
              requestFingerprint: `sha256:${"9".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(changedKind), /cannot change its kind or key/u);

        const retractedLocal = yield* memory.revert({
          ownerId: projectA.ownerId,
          changeId: local.changeSet.changeId,
          requestId: "retract-project-local-rule",
          requestFingerprint: `sha256:${"5".repeat(64)}`,
        });
        const fallbackA = yield* memory.readApplicable({ scope: projectA, kinds: ["rule"] });
        assert.deepStrictEqual(
          fallbackA.map(({ memoryId }) => memoryId),
          [global.entry.memoryId],
        );
        const closedFallback = yield* memory.readApplicable({
          scope: projectA,
          kinds: ["rule"],
          ruleSequence: global.entry.commitSequence,
          overrides: [
            {
              memoryId: retractedLocal.entry.memoryId,
              revision: retractedLocal.entry.revision,
              contentHash: retractedLocal.entry.contentHash,
            },
          ],
        });
        assert.deepStrictEqual(
          closedFallback.map(({ memoryId }) => memoryId),
          [global.entry.memoryId],
        );

        const rerelearnedLocal = yield* memory.commit(
          commitInput("relearn-project-local-rule", {
            scope: projectA,
            memoryId: "relearned-project-local-rule",
            key: "report.style",
            content: "Use the newly learned project format.",
            projectBound: true,
            requestFingerprint: `sha256:${"6".repeat(64)}`,
          }),
        );
        assert.strictEqual(rerelearnedLocal.entry.projectBound, true);
        const updatedLocalWithoutBoundary = yield* memory.commit(
          commitInput("update-local-without-boundary", {
            scope: projectA,
            memoryId: rerelearnedLocal.entry.memoryId,
            expectedRevision: 1,
            key: "report.style",
            content: "Keep the project-local boundary on update.",
            requestFingerprint: `sha256:${"a".repeat(64)}`,
          }),
        );
        assert.strictEqual(updatedLocalWithoutBoundary.entry.projectBound, true);

        const incorrectlyProjectBoundFact = yield* memory.commit(
          commitInput("fact-forced-project-bound", {
            scope: projectA,
            memoryId: "fact-forced-project-bound",
            kind: "fact",
            key: "project.directory",
            content: "tests/project-a",
            projectBound: false,
            requestFingerprint: `sha256:${"7".repeat(64)}`,
          }),
        );
        assert.strictEqual(incorrectlyProjectBoundFact.entry.projectBound, true);
        const incorrectlySharedVoidRule = yield* memory.commit(
          commitInput("void-rule-forced-project-bound", {
            scope: { ...projectA, spaceId: null },
            memoryId: "void-rule-forced-project-bound",
            key: "void.local-default",
            content: "This remains local to project A.",
            projectBound: false,
            requestFingerprint: `sha256:${"8".repeat(64)}`,
          }),
        );
        assert.strictEqual(incorrectlySharedVoidRule.entry.projectBound, true);
        const onlyProjectA = yield* memory.readApplicable({
          scope: projectA,
          kinds: ["fact"],
        });
        assert.deepStrictEqual(
          onlyProjectA.map(({ memoryId }) => memoryId),
          [incorrectlyProjectBoundFact.entry.memoryId],
        );
        const projectBFact = yield* memory.readApplicable({
          scope: projectB,
          kinds: ["fact"],
        });
        assert.deepStrictEqual(projectBFact, []);
        const projectBVoid = yield* memory.readApplicable({
          scope: { ...projectA, spaceId: null, projectId: projectB.projectId },
          kinds: ["rule"],
        });
        assert.deepStrictEqual(projectBVoid, []);
      }),
  );

  test.effect("interprets legacy records without projectBound using the old rule defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const memory = yield* SpaceMemoryService;
      const legacyScope = scope({ ownerId: "owner-legacy-project-bound" });
      const committed = yield* memory.commit(
        commitInput("legacy-shared-rule", {
          scope: legacyScope,
          memoryId: "legacy-shared-rule",
          key: "legacy.shared",
          content: "This old formal Space rule remains shared.",
        }),
      );
      const legacyRecord: Record<string, unknown> = {
        ...committed.entry,
      };
      delete legacyRecord.projectBound;
      delete legacyRecord.contentHash;
      const legacyHash = `sha256:${createHash("sha256")
        .update(stableJsonStringify(legacyRecord))
        .digest("hex")}`;
      const serialized = JSON.stringify({
        ...legacyRecord,
        contentHash: legacyHash,
      });
      yield* sql`
        UPDATE space_memory_revisions
        SET record_json = ${serialized}
        WHERE owner_id = ${legacyScope.ownerId}
          AND memory_id = ${committed.entry.memoryId}
          AND revision = ${committed.entry.revision}
      `;
      yield* sql`
        UPDATE space_memory_heads
        SET record_json = ${serialized}
        WHERE owner_id = ${legacyScope.ownerId}
          AND memory_id = ${committed.entry.memoryId}
      `;
      const fromAnotherProject = yield* memory.readApplicable({
        scope: { ...legacyScope, projectId: "project-b" },
        kinds: ["rule"],
      });
      assert.deepStrictEqual(
        fromAnotherProject.map(({ memoryId }) => memoryId),
        [committed.entry.memoryId],
      );
    }),
  );

  test.effect(
    "keeps immutable revisions, idempotent retries, cutoff membership, and exact overrides",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-revisions" });
        const first = yield* memory.commit(commitInput("revision-1", { scope: currentScope }));
        const retry = yield* memory.commit(commitInput("revision-1", { scope: currentScope }));
        assert.isTrue(retry.idempotent);
        assert.strictEqual(retry.entry.revision, 1);
        assert.strictEqual(first.entry.contentHash, retry.entry.contentHash);

        const second = yield* memory.commit(
          commitInput("revision-2", {
            scope: currentScope,
            memoryId: first.entry.memoryId,
            expectedRevision: 1,
            content: "Put the decision first.",
            requestFingerprint: `sha256:${"e".repeat(64)}`,
          }),
        );
        yield* memory.commit(
          commitInput("revision-new-entry", {
            scope: currentScope,
            memoryId: "another-rule",
            key: "review.sequence",
            content: "Reproduce before judging.",
            requestFingerprint: `sha256:${"f".repeat(64)}`,
          }),
        );

        const atClose = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
          ruleSequence: first.entry.commitSequence,
        });
        assert.deepStrictEqual(
          atClose.map(({ memoryId, revision }) => [memoryId, revision]),
          [[first.entry.memoryId, 1]],
        );
        const explicitlyOverridden = yield* memory.readApplicable({
          scope: currentScope,
          kinds: ["rule"],
          ruleSequence: first.entry.commitSequence,
          overrides: [
            {
              memoryId: second.entry.memoryId,
              revision: second.entry.revision,
              contentHash: second.entry.contentHash,
            },
          ],
        });
        assert.deepStrictEqual(
          explicitlyOverridden.map(({ memoryId, revision }) => [memoryId, revision]),
          [[second.entry.memoryId, 2]],
        );

        const conflict = yield* Effect.flip(
          memory.commit(
            commitInput("stale-revision", {
              scope: currentScope,
              memoryId: first.entry.memoryId,
              expectedRevision: 1,
              content: "stale content",
              requestFingerprint: `sha256:${"1".repeat(64)}`,
            }),
          ),
        );
        assert.match(String(conflict), /revision conflict/u);
        assert.strictEqual(
          (yield* memory.readRevision(currentScope, first.entry.memoryId, 1)).content,
          first.entry.content,
        );
      }),
  );

  test.effect(
    "exposes the same SQL transaction so close-watermark writes can roll back atomically",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const sql = yield* SqlClient.SqlClient;
        const ownerId = "owner-transaction";
        const rollback = yield* Effect.flip(
          memory.withTransaction(
            Effect.gen(function* () {
              yield* sql.unsafe(
                "INSERT INTO space_memory_sequences (owner_id, sequence) VALUES (?, 99)",
                [ownerId],
              );
              return yield* Effect.fail(new Error("cancel transaction"));
            }),
          ),
        );
        assert.match(String(rollback), /cancel transaction/u);
        assert.strictEqual(yield* memory.ruleSequence(ownerId), 0);

        yield* memory.withTransaction(
          sql.unsafe("INSERT INTO space_memory_sequences (owner_id, sequence) VALUES (?, 1)", [
            ownerId,
          ]),
        );
        assert.strictEqual(yield* memory.ruleSequence(ownerId), 1);
      }),
  );

  test.effect(
    "applies only in-scope manual overrides and lets a retracted override remove a frozen rule",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const firstScope = scope({ ownerId: "owner-overrides", spaceId: "space-one" });
        const secondScope = { ...firstScope, spaceId: "space-two" };
        const first = yield* memory.commit(
          commitInput("override-first-space", {
            scope: firstScope,
            memoryId: "rule-space-one",
            key: "report.preference",
            content: "Use the first Space rule.",
          }),
        );
        const second = yield* memory.commit(
          commitInput("override-second-space", {
            scope: secondScope,
            memoryId: "rule-space-two",
            key: "report.preference",
            content: "Use the second Space rule.",
            requestFingerprint: `sha256:${"a".repeat(64)}`,
          }),
        );
        const fromBothSpaces = yield* memory.readApplicable({
          scope: firstScope,
          kinds: ["rule"],
          ruleSequence: 0,
          overrides: [
            {
              memoryId: first.entry.memoryId,
              revision: first.entry.revision,
              contentHash: first.entry.contentHash,
            },
            {
              memoryId: second.entry.memoryId,
              revision: second.entry.revision,
              contentHash: second.entry.contentHash,
            },
          ],
        });
        assert.deepStrictEqual(
          fromBothSpaces.map(({ memoryId }) => memoryId),
          [first.entry.memoryId],
        );

        const retracted = yield* memory.revert({
          ownerId: firstScope.ownerId,
          changeId: first.changeSet.changeId,
          requestId: "override-revert-first-space",
          requestFingerprint: `sha256:${"b".repeat(64)}`,
        });
        const closedWithRetraction = yield* memory.readApplicable({
          scope: firstScope,
          kinds: ["rule"],
          ruleSequence: first.entry.commitSequence,
          overrides: [
            {
              memoryId: retracted.entry.memoryId,
              revision: retracted.entry.revision,
              contentHash: retracted.entry.contentHash,
            },
          ],
        });
        assert.deepStrictEqual(closedWithRetraction, []);
      }),
  );

  test.effect(
    "reverts only an unchanged target, appends the inverse, and reports a newer-head conflict",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-revert" });
        const first = yield* memory.commit(commitInput("revert-first", { scope: currentScope }));
        const second = yield* memory.commit(
          commitInput("revert-second", {
            scope: currentScope,
            memoryId: first.entry.memoryId,
            expectedRevision: 1,
            content: "A later useful improvement.",
            requestFingerprint: `sha256:${"2".repeat(64)}`,
          }),
        );
        const staleUndo = yield* Effect.flip(
          memory.revert({
            ownerId: currentScope.ownerId,
            changeId: first.changeSet.changeId,
            requestId: "revert-stale",
            requestFingerprint: `sha256:${"3".repeat(64)}`,
          }),
        );
        assert.match(String(staleUndo), /newer revision/u);

        const undoLatest = yield* memory.revert({
          ownerId: currentScope.ownerId,
          changeId: second.changeSet.changeId,
          requestId: "revert-latest",
          requestFingerprint: `sha256:${"4".repeat(64)}`,
        });
        assert.strictEqual(undoLatest.entry.revision, 3);
        assert.strictEqual(undoLatest.entry.content, first.entry.content);
        assert.strictEqual(
          (yield* memory.getChange(currentScope.ownerId, second.changeSet.changeId))?.status,
          "reverted",
        );
        const visible = yield* memory.readApplicable({ scope: currentScope, kinds: ["rule"] });
        const visibleReverted = visible.find(({ memoryId }) => memoryId === first.entry.memoryId);
        assert.strictEqual(visibleReverted?.content, first.entry.content);
        assert.strictEqual(visibleReverted?.revision, 3);

        const createdOnly = yield* memory.commit(
          commitInput("revert-created", {
            scope: currentScope,
            memoryId: "created-only-memory",
            key: "temporary.rule",
            content: "This entry should be retracted.",
            requestFingerprint: `sha256:${"8".repeat(64)}`,
          }),
        );
        const retracted = yield* memory.revert({
          ownerId: currentScope.ownerId,
          changeId: createdOnly.changeSet.changeId,
          requestId: "revert-created-only",
          requestFingerprint: `sha256:${"9".repeat(64)}`,
        });
        assert.strictEqual(retracted.entry.status, "retracted");
        assert.deepStrictEqual(
          yield* memory.readRevision(currentScope, createdOnly.entry.memoryId, 1),
          createdOnly.entry,
        );
      }),
  );

  test.effect(
    "pins rule-only manifests, inherits exact revisions, and audits current fact reads",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-manifest" });
        const rule = yield* memory.commit(commitInput("manifest-rule", { scope: currentScope }));
        const fact = yield* memory.commit(
          commitInput("manifest-fact", {
            scope: currentScope,
            memoryId: "manifest-fact-id",
            kind: "fact",
            key: "build.command",
            content: "SECRET-FACT-DO-NOT-RENDER",
            requestFingerprint: `sha256:${"5".repeat(64)}`,
          }),
        );
        const rootRunId = "r".repeat(2_048);
        const manifest = yield* memory.prepareRunManifest({
          scope: currentScope,
          rootRunId,
          snapshotId: "snapshot-a",
          skillAssemblyId: "assembly-a",
          learningEpoch: 2,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          "UPDATE run_knowledge_manifests SET record_json = ? WHERE manifest_id = ?",
          [JSON.stringify(reverseJsonKeys(manifest)), manifest.id],
        );
        assert.deepStrictEqual(yield* memory.readManifest(currentScope, manifest.id), manifest);
        yield* sql.unsafe(
          "UPDATE space_memory_revisions SET record_json = ? WHERE owner_id = ? AND memory_id = ? AND revision = ?",
          [
            JSON.stringify(reverseJsonKeys(rule.entry)),
            currentScope.ownerId,
            rule.entry.memoryId,
            rule.entry.revision,
          ],
        );
        assert.deepStrictEqual(
          yield* memory.readRevision(currentScope, rule.entry.memoryId, rule.entry.revision),
          rule.entry,
        );
        assert.strictEqual(manifest.rules.length, 1);
        assert.include(manifest.text, rule.entry.content);
        assert.notInclude(manifest.text, fact.entry.content);

        yield* memory.commit(
          commitInput("manifest-rule-update", {
            scope: currentScope,
            memoryId: rule.entry.memoryId,
            expectedRevision: 1,
            content: "A later Run may use this rule.",
            requestFingerprint: `sha256:${"6".repeat(64)}`,
          }),
        );
        const childRootRunId = "c".repeat(2_048);
        const inherited = yield* memory.prepareRunManifest({
          scope: currentScope,
          rootRunId: childRootRunId,
          snapshotId: "snapshot-child",
          skillAssemblyId: "assembly-child",
          learningEpoch: 99,
          frozenRuleSequence: 999,
          inheritManifestId: manifest.id,
        });
        assert.notStrictEqual(inherited.id, manifest.id);
        assert.strictEqual(inherited.rootRunId, childRootRunId);
        assert.strictEqual(inherited.snapshotId, "snapshot-child");
        assert.strictEqual(inherited.skillAssemblyId, "assembly-child");
        assert.strictEqual(inherited.learningEpoch, 2);
        assert.strictEqual(inherited.frozenRuleSequence, manifest.frozenRuleSequence);
        assert.deepStrictEqual(inherited.rules, manifest.rules);
        assert.strictEqual(inherited.text, manifest.text);
        assert.notStrictEqual(inherited.hash, manifest.hash);
        assert.deepStrictEqual(yield* memory.readManifest(currentScope, manifest.id), manifest);
        assert.deepStrictEqual(yield* memory.findRunManifest(currentScope, rootRunId), manifest);
        assert.deepStrictEqual(
          yield* memory.findRunManifest(currentScope, childRootRunId),
          inherited,
        );
        const inheritedRetry = yield* memory.prepareRunManifest({
          scope: currentScope,
          rootRunId: childRootRunId,
          snapshotId: "snapshot-child",
          skillAssemblyId: "assembly-child",
          learningEpoch: 100,
          inheritManifestId: manifest.id,
        });
        assert.deepStrictEqual(inheritedRetry, inherited);
        const changedScopeInheritance = yield* Effect.flip(
          memory.prepareRunManifest({
            scope: { ...currentScope, projectId: "moved-project" },
            rootRunId: "moved-root-run",
            snapshotId: "snapshot-moved",
            skillAssemblyId: "assembly-moved",
            inheritManifestId: manifest.id,
          }),
        );
        assert.match(String(changedScopeInheritance), /different scope/u);
        assert.strictEqual(
          yield* memory.findRunManifest(
            { ...currentScope, projectId: "moved-project" },
            childRootRunId,
          ),
          undefined,
        );

        const receipt = yield* memory.recordRead(manifest.id, fact.entry, "tool-call-a");
        assert.strictEqual(receipt.memoryId, fact.entry.memoryId);
        const reads = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM space_memory_reads WHERE manifest_id = ${manifest.id}
      `;
        assert.strictEqual(reads[0]?.count, 1);
      }),
  );

  test.effect("finds source history by exact identity and returns a redacted projection", () =>
    Effect.gen(function* () {
      const memory = yield* SpaceMemoryService;
      const ownerId = "owner-source-history";
      const expertId = "expert-source-history";
      const contentHash = `sha256:${"e".repeat(64)}`;
      const longRunId = `run:${"r".repeat(1_950)}`;
      const querySources: readonly LearningSourceReference[] = [
        {
          kind: "message",
          messageId: "same-message-id",
          threadId: "target-thread",
          turnId: "turn-target",
          role: "user",
          contentHash,
          quote: "Stored quote must be removed.",
          startOffset: 0,
          endOffset: 5,
          truncated: false,
        },
        {
          kind: "runtime",
          runId: longRunId,
          eventId: "runtime-event-target",
          contentHash,
          quote: "Runtime quote.",
        },
        {
          kind: "document",
          documentId: "document-target",
          contentHash,
          quote: "Document excerpt.",
        },
        {
          kind: "attachment",
          attachmentId: "attachment-target",
          messageId: "attachment-message",
          contentHash,
          quote: "Attachment excerpt.",
          startOffset: 2,
          endOffset: 7,
          truncated: true,
        },
        {
          kind: "owner",
          requestId: "owner-request-target",
          contentHash,
          quote: "Owner request text.",
        },
      ];
      const createChange = (
        changeOwner: string,
        changeExpert: string,
        requestId: string,
        sourceRef: LearningSourceReference,
        data?: Readonly<Record<string, unknown>>,
      ) =>
        memory.prepareChange({
          requestId,
          requestFingerprint: `sha256:${"1".repeat(64)}`,
          ownerId: changeOwner,
          expertId: changeExpert,
          sourceScope: scope({ ownerId: changeOwner, expertId: changeExpert }),
          assetKind: "skill",
          sourceRefs: [sourceRef],
          summary: requestId,
          ...(data !== undefined ? { data } : {}),
        });

      const matchingChanges = [
        yield* createChange(ownerId, expertId, "source-message-target", querySources[0]!),
        yield* createChange(ownerId, expertId, "source-runtime-target", querySources[1]!),
        yield* createChange(ownerId, expertId, "source-document-target", querySources[2]!, {
          kind: "fact",
          key: "document.topic",
          private: "omit this",
        }),
        yield* createChange(ownerId, expertId, "source-attachment-target", querySources[3]!),
        yield* createChange(ownerId, expertId, "source-owner-target", querySources[4]!),
      ];
      yield* memory.stageChange({
        ownerId,
        changeId: matchingChanges[2]!.changeId,
        requestFingerprint: matchingChanges[2]!.requestFingerprint,
        operationRef: { opaque: { token: "private", payload: "x".repeat(20_000) } },
      });
      yield* createChange(ownerId, expertId, "source-message-other-thread", {
        kind: "message",
        messageId: "same-message-id",
        threadId: "other-thread",
        contentHash,
      });
      yield* createChange(
        `${ownerId}-other`,
        expertId,
        "source-message-other-owner",
        querySources[0]!,
      );
      yield* createChange(
        ownerId,
        `${expertId}-other`,
        "source-message-other-expert",
        querySources[0]!,
      );

      const found = yield* memory.findSourceChanges(ownerId, expertId, querySources);
      assert.deepStrictEqual(found.map(({ requestId }) => requestId).toSorted(), [
        "source-attachment-target",
        "source-document-target",
        "source-message-target",
        "source-owner-target",
        "source-runtime-target",
      ]);
      const documentChange = found.find(({ requestId }) => requestId === "source-document-target")!;
      assert.isUndefined(documentChange.operationRef);
      assert.deepStrictEqual(documentChange.data, { kind: "fact", key: "document.topic" });
      for (const change of found) {
        for (const sourceRef of change.sourceRefs) assert.isUndefined(sourceRef.quote);
      }
      assert.deepStrictEqual(
        found.find(({ requestId }) => requestId === "source-message-target")?.sourceRefs[0],
        {
          kind: "message",
          messageId: "same-message-id",
          threadId: "target-thread",
          turnId: "turn-target",
          role: "user",
          contentHash,
          fragmentHash: fragmentHash("Stored quote must be removed."),
          startOffset: 0,
          endOffset: 5,
          truncated: false,
        },
      );
    }),
  );

  test.effect(
    "normalizes exact quoted fragments on first write and rejects a forged fragment hash",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-fragment-hash" });
        const quote = "保留 UTF-8 来源片段：关键决策。";
        const quotedSource = { ...source, quote };
        const committed = yield* memory.commit(
          commitInput("fragment-hash-commit", {
            scope: currentScope,
            memoryId: "fragment-hash-memory",
            sources: [quotedSource],
          }),
        );
        assert.strictEqual(committed.entry.sourceRefs[0]?.fragmentHash, fragmentHash(quote));
        assert.strictEqual(committed.changeSet.sourceRefs[0]?.fragmentHash, fragmentHash(quote));

        const prepared = yield* memory.prepareChange({
          requestId: "fragment-hash-prepared",
          requestFingerprint: `sha256:${"4".repeat(64)}`,
          ownerId: currentScope.ownerId,
          expertId: currentScope.expertId,
          sourceScope: currentScope,
          assetKind: "skill",
          sourceRefs: [quotedSource],
          summary: "Keep an exact source fragment.",
        });
        assert.strictEqual(prepared.sourceRefs[0]?.fragmentHash, fragmentHash(quote));

        const callerFragmentHash = fragmentHash("caller-verified-range");
        const callerVerifiedRange = {
          kind: "message" as const,
          messageId: "message-range-fragment",
          threadId: "thread-range-fragment",
          contentHash: source.contentHash,
          fragmentHash: callerFragmentHash,
          startOffset: 10,
          endOffset: 32,
        } as LearningSourceReference;
        const rangePrepared = yield* memory.prepareChange({
          requestId: "fragment-hash-range",
          requestFingerprint: `sha256:${"5".repeat(64)}`,
          ownerId: currentScope.ownerId,
          expertId: currentScope.expertId,
          sourceScope: currentScope,
          assetKind: "skill",
          sourceRefs: [callerVerifiedRange],
          summary: "Keep a verified range hash without reconstructing quote text.",
        });
        assert.strictEqual(rangePrepared.sourceRefs[0]?.fragmentHash, callerFragmentHash);
        assert.isUndefined(rangePrepared.sourceRefs[0]?.quote);

        const forged = yield* Effect.flip(
          memory.prepareChange({
            requestId: "fragment-hash-forged",
            requestFingerprint: `sha256:${"6".repeat(64)}`,
            ownerId: currentScope.ownerId,
            expertId: currentScope.expertId,
            sourceScope: currentScope,
            assetKind: "skill",
            sourceRefs: [
              {
                ...quotedSource,
                fragmentHash: `sha256:${"f".repeat(64)}`,
              } as LearningSourceReference,
            ],
            summary: "A mismatched fragment hash must be rejected.",
          }),
        );
        assert.match(String(forged), /fragment hash does not match/u);
        const forgedMemory = yield* Effect.flip(
          memory.commit(
            commitInput("fragment-hash-forged-memory", {
              scope: currentScope,
              memoryId: "fragment-hash-forged-memory",
              sources: [
                {
                  ...quotedSource,
                  fragmentHash: `sha256:${"f".repeat(64)}`,
                } as LearningSourceReference,
              ],
            }),
          ),
        );
        assert.match(String(forgedMemory), /fragment hash does not match/u);
      }),
  );

  test.effect("finds old reverted source changes beyond the recent change-list window", () =>
    Effect.gen(function* () {
      const memory = yield* SpaceMemoryService;
      const sql = yield* SqlClient.SqlClient;
      const ownerId = "owner-source-history-window";
      const expertId = "expert-source-history-window";
      const currentScope = scope({ ownerId, expertId });
      const signal: LearningSourceReference = {
        kind: "message",
        messageId: "old-source-signal",
        threadId: "old-source-thread",
        contentHash: source.contentHash,
        quote: "Old excerpt.",
      };
      const old = yield* memory.prepareChange({
        requestId: "old-reverted-source-change",
        requestFingerprint: `sha256:${"2".repeat(64)}`,
        ownerId,
        expertId,
        sourceScope: currentScope,
        assetKind: "memory",
        sourceRefs: [signal],
        summary: "Reverted source history.",
      });
      yield* memory.completeChange({ ownerId, changeId: old.changeId, status: "reverted" });
      yield* sql`
        UPDATE learning_change_sets
        SET created_at = '2000-01-01T00:00:00.000Z'
        WHERE owner_id = ${ownerId} AND change_id = ${old.changeId}
      `;
      for (let index = 0; index < 60; index += 1) {
        yield* memory.prepareChange({
          requestId: `unrelated-source-history-${index}`,
          requestFingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
          ownerId,
          expertId,
          sourceScope: currentScope,
          assetKind: "memory",
          sourceRefs: [
            {
              kind: "message",
              messageId: `unrelated-message-${index}`,
              threadId: "unrelated-thread",
              contentHash: source.contentHash,
            },
          ],
          summary: `Unrelated change ${index}`,
        });
      }

      const recent = yield* memory.listChanges(ownerId, expertId, 50);
      assert.isFalse(recent.some(({ changeId }) => changeId === old.changeId));
      const matchingHistory = yield* memory.findSourceChanges(ownerId, expertId, [signal]);
      assert.deepStrictEqual(
        matchingHistory.map(({ changeId, status }) => ({ changeId, status })),
        [{ changeId: old.changeId, status: "reverted" }],
      );
    }),
  );

  test.effect(
    "bounds source lookup at 128 signals and reports rather than truncating 257 matches",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const ownerId = "owner-source-history-boundary";
        const expertId = "expert-source-history-boundary";
        const currentScope = scope({ ownerId, expertId });
        const signals: readonly LearningSourceReference[] = Array.from(
          { length: 128 },
          (_, index) => ({
            kind: "message" as const,
            messageId: `boundary-message-${index}`,
            threadId: "boundary-thread",
            contentHash: source.contentHash,
          }),
        );
        for (let index = 0; index < 256; index += 1) {
          yield* memory.prepareChange({
            requestId: `boundary-change-${index}`,
            requestFingerprint: `sha256:${index.toString(16).padStart(64, "0")}`,
            ownerId,
            expertId,
            sourceScope: currentScope,
            assetKind: "memory",
            sourceRefs: [signals[0]!],
            summary: `Boundary change ${index}`,
          });
        }
        assert.strictEqual(
          (yield* memory.findSourceChanges(ownerId, expertId, signals)).length,
          256,
        );

        yield* memory.prepareChange({
          requestId: "boundary-change-256",
          requestFingerprint: `sha256:${"3".repeat(64)}`,
          ownerId,
          expertId,
          sourceScope: currentScope,
          assetKind: "memory",
          sourceRefs: [signals[0]!],
          summary: "The overflow change must cause an explicit error.",
        });
        const overflow = yield* Effect.flip(memory.findSourceChanges(ownerId, expertId, signals));
        assert.match(String(overflow), /256-change limit/u);
        const tooManySignals = yield* Effect.flip(
          memory.findSourceChanges(ownerId, expertId, [...signals, signals[0]!]),
        );
        assert.isDefined(tooManySignals);
      }),
  );

  test.effect("stages a Skill operation intent write-once with owner and fingerprint checks", () =>
    Effect.gen(function* () {
      const memory = yield* SpaceMemoryService;
      const currentScope = scope({ ownerId: "owner-stage" });
      const prepared = yield* memory.prepareChange({
        requestId: "stage-request-a",
        requestFingerprint: `sha256:${"8".repeat(64)}`,
        ownerId: currentScope.ownerId,
        expertId: currentScope.expertId,
        sourceScope: currentScope,
        assetKind: "skill",
        sourceRefs: [source],
        summary: "Save the exact prepared Skill operation.",
        data: { preserve: true },
      });
      const intent = {
        operation: "save",
        skillId: "skill-stage-a",
        package: { expertRevision: 3, packageId: "package-stage-a" },
      } as const;
      const staged = yield* memory.stageChange({
        ownerId: currentScope.ownerId,
        changeId: prepared.changeId,
        requestFingerprint: prepared.requestFingerprint,
        operationRef: intent,
      });
      assert.strictEqual(staged.status, "prepared");
      assert.deepStrictEqual(staged.operationRef, intent);
      assert.deepStrictEqual(staged.sourceRefs, [withFragmentHash(source)]);
      assert.deepStrictEqual(staged.data, { preserve: true });

      const reorderedIntent = {
        package: { packageId: "package-stage-a", expertRevision: 3 },
        skillId: "skill-stage-a",
        operation: "save",
      };
      const retry = yield* memory.stageChange({
        ownerId: currentScope.ownerId,
        changeId: prepared.changeId,
        requestFingerprint: prepared.requestFingerprint,
        operationRef: reorderedIntent,
      });
      assert.deepStrictEqual(retry, staged);
      assert.strictEqual(retry.updatedAt, staged.updatedAt);

      const changedIntent = yield* Effect.flip(
        memory.stageChange({
          ownerId: currentScope.ownerId,
          changeId: prepared.changeId,
          requestFingerprint: prepared.requestFingerprint,
          operationRef: { ...intent, skillId: "skill-stage-different" },
        }),
      );
      assert.match(String(changedIntent), /write-once/u);
      const wrongOwner = yield* Effect.flip(
        memory.stageChange({
          ownerId: "owner-stage-other",
          changeId: prepared.changeId,
          requestFingerprint: prepared.requestFingerprint,
          operationRef: intent,
        }),
      );
      assert.match(String(wrongOwner), /does not exist/u);
      const wrongFingerprint = yield* Effect.flip(
        memory.stageChange({
          ownerId: currentScope.ownerId,
          changeId: prepared.changeId,
          requestFingerprint: `sha256:${"9".repeat(64)}`,
          operationRef: intent,
        }),
      );
      assert.match(String(wrongFingerprint), /fingerprint/u);

      const terminal = yield* memory.completeChange({
        ownerId: currentScope.ownerId,
        changeId: prepared.changeId,
        status: "failed",
        summary: "The durable operation did not complete.",
      });
      const terminalRetry = yield* memory.stageChange({
        ownerId: currentScope.ownerId,
        changeId: prepared.changeId,
        requestFingerprint: prepared.requestFingerprint,
        operationRef: reorderedIntent,
      });
      assert.deepStrictEqual(terminalRetry, terminal);
      assert.strictEqual(terminalRetry.updatedAt, terminal.updatedAt);
    }),
  );

  test.effect(
    "refuses to attach the first operation intent after terminal or saved-unbound status",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-stage-terminal" });
        const requestFingerprint = `sha256:${"a".repeat(64)}`;
        const terminal = yield* memory.prepareChange({
          requestId: "stage-terminal-request",
          requestFingerprint,
          ownerId: currentScope.ownerId,
          expertId: currentScope.expertId,
          sourceScope: currentScope,
          assetKind: "skill",
          summary: "Terminal before an operation was staged.",
        });
        yield* memory.completeChange({
          ownerId: currentScope.ownerId,
          changeId: terminal.changeId,
          status: "failed",
        });
        const terminalFailure = yield* Effect.flip(
          memory.stageChange({
            ownerId: currentScope.ownerId,
            changeId: terminal.changeId,
            requestFingerprint,
            operationRef: { operation: "save" },
          }),
        );
        assert.match(String(terminalFailure), /only be staged while prepared/u);

        const unbound = yield* memory.prepareChange({
          requestId: "stage-unbound-request",
          requestFingerprint,
          ownerId: currentScope.ownerId,
          expertId: currentScope.expertId,
          sourceScope: currentScope,
          assetKind: "skill",
          summary: "Saved without an exact binding.",
        });
        yield* memory.completeChange({
          ownerId: currentScope.ownerId,
          changeId: unbound.changeId,
          status: "saved_unbound",
        });
        const unboundFailure = yield* Effect.flip(
          memory.stageChange({
            ownerId: currentScope.ownerId,
            changeId: unbound.changeId,
            requestFingerprint,
            operationRef: { operation: "save" },
          }),
        );
        assert.match(String(unboundFailure), /only be staged while prepared/u);
      }),
  );

  test.effect(
    "marks a committed Skill change reverted only with its committed inverse receipt",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const ownerId = "owner-mark-reverted";
        const expertId = "expert-mark-reverted";
        const currentScope = scope({ ownerId, expertId });

        const createReceipt = (
          requestId: string,
          options: {
            readonly ownerId?: string;
            readonly expertId?: string;
            readonly assetKind?: "memory" | "skill";
            readonly data?: Readonly<Record<string, unknown>>;
            readonly status?: "prepared" | "committed" | "failed" | "saved_unbound";
          } = {},
        ) =>
          Effect.gen(function* () {
            const receiptOwner = options.ownerId ?? ownerId;
            const receiptExpert = options.expertId ?? expertId;
            const assetKind = options.assetKind ?? "skill";
            const prepared = yield* memory.prepareChange({
              requestId,
              requestFingerprint: `sha256:${createHash("sha256").update(requestId).digest("hex")}`,
              ownerId: receiptOwner,
              expertId: receiptExpert,
              sourceScope: scope({ ownerId: receiptOwner, expertId: receiptExpert }),
              assetKind,
              sourceRefs: [source],
              summary: `Receipt ${requestId}`,
              ...(options.data !== undefined ? { data: options.data } : {}),
            });
            if (options.status === undefined || options.status === "prepared") return prepared;
            return yield* memory.completeChange({
              ownerId: receiptOwner,
              changeId: prepared.changeId,
              status: options.status,
              ...(options.status === "committed"
                ? {
                    after:
                      assetKind === "skill"
                        ? {
                            assetKind: "skill" as const,
                            skillId: `skill-${requestId}`,
                            packageId: `package-${requestId}`,
                            expertRevision: 1,
                          }
                        : {
                            assetKind: "memory" as const,
                            memoryId: `memory-${requestId}`,
                            revision: 1,
                            contentHash: `sha256:${"e".repeat(64)}`,
                          },
                  }
                : {}),
            });
          });

        const originalPrepared = yield* createReceipt("mark-reverted-original");
        const original = yield* memory.completeChange({
          ownerId,
          changeId: originalPrepared.changeId,
          status: "committed",
          before: {
            assetKind: "skill",
            skillId: "skill-before",
            packageId: "package-before",
            expertRevision: 1,
          },
          after: {
            assetKind: "skill",
            skillId: "skill-after",
            packageId: "package-after",
            expertRevision: 2,
          },
          data: { durable: { operation: "save", marker: "retain" } },
          operationRef: { packageId: "package-after", operation: "save" },
          summary: "Original saved Skill revision",
        });

        const missingInverse = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: "missing-inverse",
          }),
        );
        assert.match(String(missingInverse), /inverse learning receipt/u);

        const foreignOwnerInverse = yield* createReceipt("mark-reverted-foreign-owner", {
          ownerId: "owner-not-authorized",
          data: { reverts: original.changeId },
          status: "committed",
        });
        const foreignOwnerFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: foreignOwnerInverse.changeId,
          }),
        );
        assert.match(String(foreignOwnerFailure), /inverse learning receipt/u);

        const wrongExpertInverse = yield* createReceipt("mark-reverted-wrong-expert", {
          expertId: "expert-not-authorized",
          data: { reverts: original.changeId },
          status: "committed",
        });
        const wrongExpertFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: wrongExpertInverse.changeId,
          }),
        );
        assert.match(String(wrongExpertFailure), /same Expert and asset/u);

        const wrongAssetInverse = yield* createReceipt("mark-reverted-wrong-asset", {
          assetKind: "memory",
          data: { reverts: original.changeId },
          status: "committed",
        });
        const wrongAssetFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: wrongAssetInverse.changeId,
          }),
        );
        assert.match(String(wrongAssetFailure), /same Expert and asset/u);

        const wrongProofInverse = yield* createReceipt("mark-reverted-wrong-proof", {
          data: { reverts: "some-other-change" },
          status: "committed",
        });
        const wrongProofFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: wrongProofInverse.changeId,
          }),
        );
        assert.match(String(wrongProofFailure), /does not reference/u);

        const uncommittedInverse = yield* createReceipt("mark-reverted-uncommitted", {
          data: { revertedChangeId: original.changeId },
        });
        const uncommittedFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: original.changeId,
            revertChangeId: uncommittedInverse.changeId,
          }),
        );
        assert.match(String(uncommittedFailure), /not committed/u);

        const alreadyUnbound = yield* createReceipt("mark-reverted-unbound-original", {
          status: "saved_unbound",
        });
        const unboundInverse = yield* createReceipt("mark-reverted-unbound-inverse", {
          data: { reverts: alreadyUnbound.changeId },
          status: "committed",
        });
        const unboundFailure = yield* Effect.flip(
          memory.markReverted({
            ownerId,
            changeId: alreadyUnbound.changeId,
            revertChangeId: unboundInverse.changeId,
          }),
        );
        assert.match(String(unboundFailure), /Only a committed learning change/u);

        const validInverse = yield* createReceipt("mark-reverted-valid-inverse", {
          data: { revertedChangeId: original.changeId, inverseMetadata: "preserve" },
          status: "committed",
        });
        const reverted = yield* memory.markReverted({
          ownerId,
          changeId: original.changeId,
          revertChangeId: validInverse.changeId,
        });
        assert.strictEqual(reverted.status, "reverted");
        assert.deepStrictEqual(
          { ...reverted, status: original.status, updatedAt: original.updatedAt },
          original,
        );

        const retry = yield* memory.markReverted({
          ownerId,
          changeId: original.changeId,
          revertChangeId: validInverse.changeId,
        });
        assert.deepStrictEqual(retry, reverted);
      }),
  );

  test.effect(
    "journals skill changes, supports saved-unbound recovery, and keeps owner request identity",
    () =>
      Effect.gen(function* () {
        const memory = yield* SpaceMemoryService;
        const currentScope = scope({ ownerId: "owner-skills" });
        const prepared = yield* memory.prepareChange({
          requestId: "skill-request-a",
          requestFingerprint: `sha256:${"7".repeat(64)}`,
          ownerId: currentScope.ownerId,
          expertId: "expert-a",
          sourceScope: currentScope,
          assetKind: "skill",
          summary: "Update the review method.",
          data: { operation: { kind: "save", skillId: "skill-a" } },
        });
        const retry = yield* memory.readChange(currentScope.ownerId, "expert-a", "skill-request-a");
        assert.strictEqual(retry?.changeId, prepared.changeId);
        const incompleteCommit = yield* Effect.flip(
          memory.completeChange({
            ownerId: currentScope.ownerId,
            changeId: prepared.changeId,
            status: "committed",
          }),
        );
        assert.match(String(incompleteCommit), /exact after reference/u);
        const unbound = yield* memory.completeChange({
          ownerId: currentScope.ownerId,
          changeId: prepared.changeId,
          status: "saved_unbound",
          data: { operation: { kind: "save", packageId: "package-a" } },
        });
        assert.strictEqual(unbound.status, "saved_unbound");
        const committed = yield* memory.completeChange({
          ownerId: currentScope.ownerId,
          changeId: prepared.changeId,
          status: "committed",
          after: {
            assetKind: "skill",
            skillId: "skill-a",
            packageId: "package-a",
            revision: 3,
            expertRevision: 2,
          },
        });
        assert.strictEqual(committed.status, "committed");
        assert.strictEqual(yield* memory.getChange("owner-b", prepared.changeId), undefined);
      }),
  );
});
