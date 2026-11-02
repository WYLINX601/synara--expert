import {
  LearningChangeSet,
  MemoryScope,
  RunKnowledgeManifest,
  SpaceMemoryEntry,
  SpaceMemoryKind,
  SpaceMemoryReadReceipt,
  SpaceMemoryRevisionRef,
  type LearningChangeReference,
  type LearningChangeStatus,
  LearningSourceReference,
} from "@synara/contracts";
import { createHash, randomUUID } from "node:crypto";
import { stableJsonStringify } from "@synara/shared/browserAutomationCatalogue";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { SpaceMemoryRepository } from "./SpaceMemoryRepository.ts";

const MAX_MANIFEST_RULES = 256;
const MAX_MANIFEST_TEXT = 24_000;
const MAX_CHANGE_LIMIT = 100;
const MAX_SOURCE_CHANGE_SIGNALS = 128;
const MAX_SOURCE_CHANGE_RESULTS = 256;
const SourceChangeLookupSources = Schema.Array(LearningSourceReference).check(
  Schema.isMaxLength(MAX_SOURCE_CHANGE_SIGNALS),
);

export interface CommitSpaceMemoryInput {
  readonly scope: MemoryScope;
  readonly memoryId?: string;
  /** Zero means create; otherwise this must match the current head exactly. */
  readonly expectedRevision: number;
  readonly kind: typeof SpaceMemoryKind.Type;
  readonly key: string;
  readonly content: string;
  /** Project-only rules narrow a Space-wide default; facts and Void entries are always local. */
  readonly projectBound?: boolean;
  readonly sources: readonly LearningSourceReference[];
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly observedAt: string;
  readonly validUntil?: string;
}

export interface CommitSpaceMemoryResult {
  readonly entry: SpaceMemoryEntry;
  readonly changeSet: LearningChangeSet;
  readonly idempotent: boolean;
}

export interface ReadApplicableInput {
  readonly scope: MemoryScope;
  readonly kinds?: readonly SpaceMemoryKind[];
  /** Applies to rules only; facts and environment remain current. */
  readonly ruleSequence?: number;
  readonly overrides?: readonly SpaceMemoryRevisionRef[];
  /** Authorized edit/catalog reads may display both a local override and its shared base rule. */
  readonly includeShadowed?: boolean;
}

export interface PrepareRunManifestInput {
  readonly scope: MemoryScope;
  readonly rootRunId: string;
  readonly snapshotId: string;
  readonly skillAssemblyId?: string;
  readonly learningEpoch?: number;
  readonly frozenRuleSequence?: number;
  readonly ruleOverrides?: readonly SpaceMemoryRevisionRef[];
  readonly inheritManifestId?: string;
}

export interface PrepareChangeInput {
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly ownerId: string;
  readonly expertId: string;
  readonly sourceScope: MemoryScope;
  readonly assetKind: "memory" | "skill";
  readonly sourceRefs?: readonly LearningSourceReference[];
  readonly summary: string;
  readonly operationRef?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface CompleteChangeInput {
  readonly ownerId: string;
  readonly changeId: string;
  readonly status: Exclude<LearningChangeStatus, "prepared">;
  readonly before?: LearningChangeReference | null;
  readonly after?: LearningChangeReference | null;
  readonly operationRef?: Readonly<Record<string, unknown>>;
  readonly data?: Readonly<Record<string, unknown>>;
  readonly summary?: string;
}

export interface StageChangeInput {
  readonly ownerId: string;
  readonly changeId: string;
  readonly requestFingerprint: string;
  readonly operationRef: Readonly<Record<string, unknown>>;
}

export interface MarkRevertedInput {
  readonly ownerId: string;
  readonly changeId: string;
  readonly revertChangeId: string;
}

export interface RevertSpaceMemoryInput {
  readonly ownerId: string;
  readonly changeId: string;
  readonly requestId: string;
  readonly requestFingerprint: string;
  readonly expectedRevision?: number;
}

export interface SpaceMemoryServiceShape {
  readonly commit: (
    input: CommitSpaceMemoryInput,
  ) => Effect.Effect<CommitSpaceMemoryResult, unknown>;
  readonly readApplicable: (
    input: ReadApplicableInput,
  ) => Effect.Effect<readonly SpaceMemoryEntry[], unknown>;
  readonly readRevision: (
    scope: MemoryScope,
    memoryId: string,
    revision: number,
  ) => Effect.Effect<SpaceMemoryEntry, unknown>;
  readonly ruleSequence: (ownerId: string) => Effect.Effect<number, unknown>;
  readonly prepareRunManifest: (
    input: PrepareRunManifestInput,
  ) => Effect.Effect<RunKnowledgeManifest, unknown>;
  readonly readManifest: (
    scope: MemoryScope,
    manifestId: string,
  ) => Effect.Effect<RunKnowledgeManifest, unknown>;
  readonly findRunManifest: (
    scope: MemoryScope,
    rootRunId: string,
  ) => Effect.Effect<RunKnowledgeManifest | undefined, unknown>;
  readonly recordRead: (
    manifestId: string,
    entry: SpaceMemoryEntry,
    toolCallId: string,
  ) => Effect.Effect<SpaceMemoryReadReceipt, unknown>;
  readonly listChanges: (
    ownerId: string,
    expertId: string,
    limit?: number,
  ) => Effect.Effect<readonly LearningChangeSet[], unknown>;
  readonly revert: (
    input: RevertSpaceMemoryInput,
  ) => Effect.Effect<CommitSpaceMemoryResult, unknown>;
  readonly prepareChange: (input: PrepareChangeInput) => Effect.Effect<LearningChangeSet, unknown>;
  readonly completeChange: (
    input: CompleteChangeInput,
  ) => Effect.Effect<LearningChangeSet, unknown>;
  /** Persist a prepared host operation intent exactly once before side effects. */
  readonly stageChange: (input: StageChangeInput) => Effect.Effect<LearningChangeSet, unknown>;
  /** Mark a committed Skill receipt reverted only with its committed inverse receipt. */
  readonly markReverted: (input: MarkRevertedInput) => Effect.Effect<LearningChangeSet, unknown>;
  readonly findSourceChanges: (
    ownerId: string,
    expertId: string,
    sources: readonly LearningSourceReference[],
  ) => Effect.Effect<readonly LearningChangeSet[], unknown>;
  /** Owner-scoped stable request lookup for retryable frontend/RPC operations. */
  readonly readChange: (
    ownerId: string,
    expertId: string,
    requestId: string,
  ) => Effect.Effect<LearningChangeSet | undefined, unknown>;
  readonly getChange: (
    ownerId: string,
    changeId: string,
  ) => Effect.Effect<LearningChangeSet | undefined, unknown>;
  /** Runs on the same SqlClient connection as repository operations. */
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
}

export class SpaceMemoryService extends ServiceMap.Service<
  SpaceMemoryService,
  SpaceMemoryServiceShape
>()("synara/SpaceMemoryService") {}

const hashJson = (value: unknown): string =>
  `sha256:${createHash("sha256")
    .update(stableJsonStringify(JSON.parse(JSON.stringify(value))))
    .digest("hex")}`;

const normalizeSourceReferences = (sources: readonly LearningSourceReference[]) =>
  sources.map((source) => {
    const value = source as LearningSourceReference & { readonly fragmentHash?: string };
    if (value.quote === undefined) {
      return Schema.decodeUnknownSync(LearningSourceReference)(value);
    }
    const fragmentHash = `sha256:${createHash("sha256").update(value.quote, "utf8").digest("hex")}`;
    if (value.fragmentHash !== undefined && value.fragmentHash !== fragmentHash) {
      throw new Error("A learning source fragment hash does not match its exact quote.");
    }
    return Schema.decodeUnknownSync(LearningSourceReference)({ ...value, fragmentHash });
  });

const entryBody = (entry: SpaceMemoryEntry) => {
  const { contentHash: _contentHash, ...body } = entry;
  return body;
};

const manifestBody = (manifest: RunKnowledgeManifest) => {
  const { hash: _hash, ...body } = manifest;
  return body;
};

const checkedEntry = (value: unknown): SpaceMemoryEntry => {
  const entry = Schema.decodeUnknownSync(SpaceMemoryEntry)(value);
  if (entry.contentHash !== hashJson(entryBody(entry))) {
    throw new Error("Space Memory revision content hash does not match its immutable contents.");
  }
  return entry;
};

const checkedManifest = (value: unknown): RunKnowledgeManifest => {
  const manifest = Schema.decodeUnknownSync(RunKnowledgeManifest)(value);
  if (manifest.hash !== hashJson(manifestBody(manifest))) {
    throw new Error("Run knowledge manifest hash does not match its immutable contents.");
  }
  return manifest;
};

const scopeEquals = (left: MemoryScope, right: MemoryScope) =>
  left.ownerId === right.ownerId &&
  left.spaceId === right.spaceId &&
  left.expertId === right.expertId &&
  left.projectId === right.projectId;

/** Old Space rules default to shared; facts, environment, and Void rules default to local. */
const isProjectBound = (entry: SpaceMemoryEntry) =>
  entry.kind !== "rule" || entry.scope.spaceId === null || (entry.projectBound ?? false);

const entryApplies = (entry: SpaceMemoryEntry, scope: MemoryScope) =>
  entry.scope.ownerId === scope.ownerId &&
  entry.scope.spaceId === scope.spaceId &&
  entry.scope.expertId === scope.expertId &&
  (!isProjectBound(entry) || entry.scope.projectId === scope.projectId);

const preferProjectBoundRules = (entries: readonly SpaceMemoryEntry[]): SpaceMemoryEntry[] => {
  const selectedByKey = new Map<string, SpaceMemoryEntry>();
  const nonRules: SpaceMemoryEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== "rule") {
      nonRules.push(entry);
      continue;
    }
    const previous = selectedByKey.get(entry.key);
    if (
      previous === undefined ||
      (isProjectBound(entry) && !isProjectBound(previous)) ||
      (isProjectBound(entry) === isProjectBound(previous) &&
        entry.commitSequence > previous.commitSequence)
    ) {
      selectedByKey.set(entry.key, entry);
    }
  }
  return [...nonRules, ...selectedByKey.values()];
};

const now = () => new Date().toISOString();

const timestampMillis = (value: string): number | undefined => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
};

/** Invalid historical expiry values fail closed; absent expiry remains permanent. */
const isValidAt = (validUntil: string | undefined, at: number | undefined) => {
  if (validUntil === undefined) return true;
  const expiry = timestampMillis(validUntil);
  return at !== undefined && expiry !== undefined && expiry > at;
};

const normalizeValidUntil = (validUntil: string): string => {
  const milliseconds = timestampMillis(validUntil);
  if (milliseconds === undefined) {
    throw new Error("Space Memory validUntil must be a parseable date-time.");
  }
  return new Date(milliseconds).toISOString();
};

const refOf = (entry: SpaceMemoryEntry): LearningChangeReference => ({
  assetKind: "memory",
  memoryId: entry.memoryId,
  revision: entry.revision,
  contentHash: entry.contentHash,
});

const revisionRefOf = (entry: SpaceMemoryEntry): SpaceMemoryRevisionRef => ({
  memoryId: entry.memoryId,
  revision: entry.revision,
  contentHash: entry.contentHash,
});

const idempotentResult = (
  changeSet: LearningChangeSet,
  entry: SpaceMemoryEntry,
): CommitSpaceMemoryResult => ({ entry, changeSet, idempotent: true });

const requestMatches = (current: LearningChangeSet, fingerprint: string) => {
  if (current.requestFingerprint !== fingerprint) {
    throw new Error("A learning request ID was reused with a different content fingerprint.");
  }
  if (current.assetKind !== "memory" || !current.after || current.after.assetKind !== "memory") {
    throw new Error(
      "The learning request already belongs to a different or incomplete asset change.",
    );
  }
};

export const makeSpaceMemoryService = Effect.gen(function* () {
  const repository = yield* SpaceMemoryRepository;

  const readRevision = (scope: MemoryScope, memoryId: string, revision: number) =>
    repository.readRevision(scope.ownerId, memoryId, revision).pipe(
      Effect.flatMap((entry) =>
        entry === undefined
          ? Effect.fail(new Error("The requested Space Memory revision does not exist."))
          : Effect.try({
              try: () => checkedEntry(entry),
              catch: (cause) => cause,
            }).pipe(
              Effect.flatMap((checked) =>
                checked.memoryId === memoryId &&
                checked.revision === revision &&
                entryApplies(checked, scope)
                  ? Effect.succeed(checked)
                  : Effect.fail(
                      new Error("The requested Space Memory revision is outside this scope."),
                    ),
              ),
            ),
      ),
    );

  const readApplicable = (input: ReadApplicableInput) =>
    Effect.gen(function* () {
      const asOf = timestampMillis(now());
      const requested = new Set(input.kinds ?? ["rule", "fact", "environment"]);
      if (requested.size === 0) return [] as const;
      if (
        input.ruleSequence !== undefined &&
        (!Number.isSafeInteger(input.ruleSequence) || input.ruleSequence < 0)
      ) {
        return yield* Effect.fail(
          new Error("The rule sequence must be a non-negative safe integer."),
        );
      }
      if (input.overrides !== undefined && input.overrides.length > MAX_MANIFEST_RULES) {
        return yield* Effect.fail(
          new Error(`Rule overrides exceed the ${MAX_MANIFEST_RULES}-entry limit.`),
        );
      }
      const latestSequence = yield* repository.sequence(input.scope.ownerId);
      const selected: SpaceMemoryEntry[] = [];
      for (const kind of ["rule", "fact", "environment"] as const) {
        if (!requested.has(kind)) continue;
        const at = kind === "rule" ? (input.ruleSequence ?? latestSequence) : latestSequence;
        const entries = yield* repository.listAtSequence(input.scope, at, [kind]);
        for (const value of entries) {
          const entry = checkedEntry(value);
          if (
            entry.kind === kind &&
            entry.status === "active" &&
            entryApplies(entry, input.scope) &&
            isValidAt(entry.validUntil, asOf)
          ) {
            selected.push(entry);
          }
        }
      }

      if (input.overrides && requested.has("rule")) {
        const seenOverrides = new Set<string>();
        for (const ref of input.overrides) {
          if (seenOverrides.has(ref.memoryId)) {
            return yield* Effect.fail(
              new Error("A rule override set contains a duplicate Memory ID."),
            );
          }
          seenOverrides.add(ref.memoryId);
          const stored = yield* repository.readRevision(
            input.scope.ownerId,
            ref.memoryId,
            ref.revision,
          );
          if (stored === undefined) {
            return yield* Effect.fail(
              new Error("A manual rule override references a missing revision."),
            );
          }
          const override = checkedEntry(stored);
          if (override.kind !== "rule" || override.contentHash !== ref.contentHash) {
            return yield* Effect.fail(
              new Error("A manual rule override has a mismatched kind or content hash."),
            );
          }
          // A single Expert may have frozen overrides for several Spaces. Their
          // exact source revisions remain valid, but only the current scope is applicable.
          if (!entryApplies(override, input.scope)) continue;
          const previousIndex = selected.findIndex((entry) => entry.memoryId === ref.memoryId);
          if (previousIndex >= 0) selected.splice(previousIndex, 1);
          if (override.status === "active" && isValidAt(override.validUntil, asOf)) {
            selected.push(override);
          }
        }
      }

      const applicable = input.includeShadowed ? selected : preferProjectBoundRules(selected);
      return applicable.toSorted(
        (left, right) =>
          left.commitSequence - right.commitSequence || left.memoryId.localeCompare(right.memoryId),
      );
    });

  const verifyManifest = (value: RunKnowledgeManifest) =>
    Effect.try({
      try: () => checkedManifest(value),
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((manifest) =>
        Effect.forEach(manifest.rules, (ref) =>
          readRevision(manifest.scope, ref.memoryId, ref.revision).pipe(
            Effect.flatMap((entry) =>
              entry.kind === "rule" &&
              entry.status === "active" &&
              entry.contentHash === ref.contentHash
                ? Effect.succeed(entry)
                : Effect.fail(
                    new Error("The Run knowledge manifest references a corrupt rule revision."),
                  ),
            ),
          ),
        ).pipe(Effect.as(manifest)),
      ),
    );

  const readManifest = (scope: MemoryScope, manifestId: string) =>
    repository
      .readManifest(manifestId)
      .pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.fail(new Error("The requested Run knowledge manifest does not exist."))
            : verifyManifest(value).pipe(
                Effect.flatMap((manifest) =>
                  scopeEquals(manifest.scope, scope)
                    ? Effect.succeed(manifest)
                    : Effect.fail(
                        new Error("The Run knowledge manifest belongs to a different scope."),
                      ),
                ),
              ),
        ),
      );

  const findRunManifest = (scope: MemoryScope, rootRunId: string) =>
    repository
      .findManifestByRoot(scope, rootRunId)
      .pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(undefined)
            : verifyManifest(value).pipe(
                Effect.flatMap((manifest) =>
                  scopeEquals(manifest.scope, scope) && manifest.rootRunId === rootRunId
                    ? Effect.succeed(manifest)
                    : Effect.fail(
                        new Error(
                          "The persisted Run knowledge manifest does not match its root identity.",
                        ),
                      ),
                ),
              ),
        ),
      );

  const getChange = (ownerId: string, changeId: string) =>
    repository.getChange(ownerId, changeId).pipe(
      Effect.flatMap((change) =>
        change === undefined
          ? Effect.succeed(undefined)
          : Effect.try({
              try: () => Schema.decodeUnknownSync(LearningChangeSet)(change),
              catch: (cause) => cause,
            }),
      ),
    );

  const commit = (input: CommitSpaceMemoryInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        const existing = yield* repository.findChangeByRequest(
          input.scope.ownerId,
          input.scope.expertId,
          input.requestId,
        );
        if (existing) {
          requestMatches(existing, input.requestFingerprint);
          const ref = existing.after;
          if (!ref || ref.assetKind !== "memory") {
            return yield* Effect.fail(new Error("The idempotent memory receipt is incomplete."));
          }
          const previous = yield* readRevision(input.scope, ref.memoryId, ref.revision);
          if (previous.contentHash !== ref.contentHash) {
            return yield* Effect.fail(
              new Error("The idempotent memory receipt points to a changed revision."),
            );
          }
          return idempotentResult(existing, previous);
        }

        const sourceRefs = yield* Effect.try({
          try: () => normalizeSourceReferences(input.sources),
          catch: (cause) => cause,
        });
        const validUntil =
          input.validUntil === undefined
            ? undefined
            : yield* Effect.try({
                try: () => normalizeValidUntil(input.validUntil!),
                catch: (cause) => cause,
              });

        const memoryId = input.memoryId ?? randomUUID();
        const head = yield* repository.readHead(input.scope.ownerId, memoryId);
        const actualRevision = head?.revision ?? 0;
        if (actualRevision !== input.expectedRevision) {
          return yield* Effect.fail(
            new Error(
              "Space Memory revision conflict; read the current version before committing.",
            ),
          );
        }
        const projectBound =
          input.kind !== "rule" || input.scope.spaceId === null
            ? true
            : (input.projectBound ?? (head ? isProjectBound(head) : false));
        if (head && !entryApplies(head, input.scope)) {
          return yield* Effect.fail(new Error("A Space Memory ID cannot move between scopes."));
        }
        if (head && (head.kind !== input.kind || head.key !== input.key)) {
          return yield* Effect.fail(
            new Error("A Space Memory ID cannot change its kind or key; create a new entry."),
          );
        }
        if (head && isProjectBound(head) !== projectBound) {
          return yield* Effect.fail(
            new Error("A Space Memory ID cannot change its project boundary; create a new entry."),
          );
        }
        if (!head) {
          const currentSequence = yield* repository.sequence(input.scope.ownerId);
          const currentHeads = yield* repository.listAtSequence(input.scope, currentSequence, [
            input.kind,
          ]);
          const asOf = timestampMillis(now());
          const duplicate = currentHeads.find((entry) => {
            if (
              entry.status !== "active" ||
              !isValidAt(entry.validUntil, asOf) ||
              entry.kind !== input.kind ||
              entry.key !== input.key ||
              entry.scope.ownerId !== input.scope.ownerId ||
              entry.scope.spaceId !== input.scope.spaceId ||
              entry.scope.expertId !== input.scope.expertId
            ) {
              return false;
            }
            const entryIsProjectBound = isProjectBound(entry);
            return (
              entryIsProjectBound === projectBound &&
              (!projectBound || entry.scope.projectId === input.scope.projectId)
            );
          });
          if (duplicate) {
            return yield* Effect.fail(
              new Error(
                "An active Space Memory entry with this key already exists in the same logical scope.",
              ),
            );
          }
        }
        const entryScope = head?.scope ?? input.scope;
        const commitSequence = yield* repository.nextSequence(input.scope.ownerId);
        const changeId = randomUUID();
        const base = {
          memoryId,
          revision: actualRevision + 1,
          kind: input.kind,
          key: input.key,
          content: input.content,
          scope: entryScope,
          projectBound,
          sourceRefs,
          changeId,
          commitSequence,
          observedAt: input.observedAt,
          ...(validUntil !== undefined ? { validUntil } : {}),
          status: "active" as const,
        };
        const entry = Schema.decodeUnknownSync(SpaceMemoryEntry)({
          ...base,
          contentHash: hashJson(base),
        });
        const timestamp = now();
        const changeSet = Schema.decodeUnknownSync(LearningChangeSet)({
          changeId,
          requestId: input.requestId,
          requestFingerprint: input.requestFingerprint,
          ownerId: input.scope.ownerId,
          expertId: input.scope.expertId,
          sourceScope: input.scope,
          assetKind: "memory",
          before: head ? refOf(head) : null,
          after: refOf(entry),
          sourceRefs,
          status: "committed",
          summary: `${input.kind}: ${input.key}`,
          data: { kind: input.kind, key: input.key },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* repository.writeRevision(entry, actualRevision);
        yield* repository.createChange(changeSet);
        return { entry, changeSet, idempotent: false };
      }),
    );

  const prepareRunManifest = (input: PrepareRunManifestInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        if (input.inheritManifestId) {
          const inherited = yield* readManifest(input.scope, input.inheritManifestId);
          if (inherited.rootRunId === input.rootRunId) {
            if (
              inherited.snapshotId !== input.snapshotId ||
              (input.skillAssemblyId !== undefined &&
                inherited.skillAssemblyId !== input.skillAssemblyId)
            ) {
              return yield* Effect.fail(
                new Error("An existing Run cannot change its pinned knowledge identity."),
              );
            }
            return inherited;
          }
          if (input.skillAssemblyId === undefined) {
            return yield* Effect.fail(
              new Error("Inherited knowledge must bind the destination Skill assembly identity."),
            );
          }
          const existing = yield* findRunManifest(input.scope, input.rootRunId);
          if (existing) {
            if (
              existing.snapshotId !== input.snapshotId ||
              existing.skillAssemblyId !== input.skillAssemblyId ||
              existing.learningEpoch !== inherited.learningEpoch ||
              existing.frozenRuleSequence !== inherited.frozenRuleSequence ||
              existing.renderVersion !== inherited.renderVersion ||
              JSON.stringify(existing.rules) !== JSON.stringify(inherited.rules) ||
              existing.text !== inherited.text
            ) {
              return yield* Effect.fail(
                new Error("The destination Run already has a different knowledge manifest."),
              );
            }
            return existing;
          }
          const inheritedBase = {
            id: randomUUID(),
            rootRunId: input.rootRunId,
            scope: input.scope,
            snapshotId: input.snapshotId,
            skillAssemblyId: input.skillAssemblyId,
            ...(inherited.learningEpoch !== undefined
              ? { learningEpoch: inherited.learningEpoch }
              : {}),
            ...(inherited.frozenRuleSequence !== undefined
              ? { frozenRuleSequence: inherited.frozenRuleSequence }
              : {}),
            rules: inherited.rules,
            renderVersion: inherited.renderVersion,
            text: inherited.text,
            createdAt: now(),
          };
          const child = Schema.decodeUnknownSync(RunKnowledgeManifest)({
            ...inheritedBase,
            hash: hashJson(inheritedBase),
          });
          yield* repository.createManifest(child);
          return child;
        }
        const sequence =
          input.frozenRuleSequence ?? (yield* repository.sequence(input.scope.ownerId));
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
          return yield* Effect.fail(
            new Error("The frozen rule sequence must be a non-negative integer."),
          );
        }
        const rules = yield* readApplicable({
          scope: input.scope,
          kinds: ["rule"],
          ruleSequence: sequence,
          ...(input.ruleOverrides !== undefined ? { overrides: input.ruleOverrides } : {}),
        });
        if (rules.length > MAX_MANIFEST_RULES) {
          return yield* Effect.fail(
            new Error(`The rule set exceeds the ${MAX_MANIFEST_RULES}-entry manifest limit.`),
          );
        }
        let text = "";
        for (const rule of rules) {
          const line = `- ${rule.key}: ${rule.content}\n`;
          if (text.length + line.length > MAX_MANIFEST_TEXT) break;
          text += line;
        }
        const manifestBase = {
          id: randomUUID(),
          rootRunId: input.rootRunId,
          scope: input.scope,
          snapshotId: input.snapshotId,
          ...(input.skillAssemblyId !== undefined
            ? { skillAssemblyId: input.skillAssemblyId }
            : {}),
          ...(input.learningEpoch !== undefined ? { learningEpoch: input.learningEpoch } : {}),
          frozenRuleSequence: sequence,
          rules: rules.map(revisionRefOf),
          renderVersion: 1 as const,
          text,
          createdAt: now(),
        };
        const manifest = Schema.decodeUnknownSync(RunKnowledgeManifest)({
          ...manifestBase,
          hash: hashJson(manifestBase),
        });
        yield* repository.createManifest(manifest);
        return manifest;
      }),
    );

  const revert = (input: RevertSpaceMemoryInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        const original = yield* getChange(input.ownerId, input.changeId);
        if (
          original === undefined ||
          original.assetKind !== "memory" ||
          original.after === undefined ||
          original.after === null ||
          original.after.assetKind !== "memory"
        ) {
          return yield* Effect.fail(
            new Error("The selected change is not a reversible Memory commit."),
          );
        }
        const retry = yield* repository.findChangeByRequest(
          input.ownerId,
          original.expertId,
          input.requestId,
        );
        if (retry) {
          requestMatches(retry, input.requestFingerprint);
          if (
            retry.after === undefined ||
            retry.after === null ||
            retry.after.assetKind !== "memory"
          ) {
            return yield* Effect.fail(
              new Error("The idempotent Memory reversion receipt is incomplete."),
            );
          }
          const entry = yield* readRevision(
            original.sourceScope,
            retry.after.memoryId,
            retry.after.revision,
          );
          return idempotentResult(retry, entry);
        }
        if (original.status !== "committed") {
          return yield* Effect.fail(
            new Error("Only a currently committed Memory change can be reverted."),
          );
        }
        const afterRef = original.after;
        const current = yield* repository.readHead(input.ownerId, afterRef.memoryId);
        if (
          current === undefined ||
          current.revision !== afterRef.revision ||
          current.contentHash !== afterRef.contentHash ||
          (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)
        ) {
          return yield* Effect.fail(
            new Error(
              "Space Memory changed after this learning; reverting would overwrite a newer revision.",
            ),
          );
        }
        const beforeRef = original.before;
        if (beforeRef !== undefined && beforeRef !== null && beforeRef.assetKind !== "memory") {
          return yield* Effect.fail(
            new Error("The original Memory change has an incompatible before reference."),
          );
        }
        let restored: SpaceMemoryEntry;
        if (beforeRef === undefined || beforeRef === null) {
          const commitSequence = yield* repository.nextSequence(input.ownerId);
          const revertChangeId = randomUUID();
          const base = {
            ...current,
            revision: current.revision + 1,
            changeId: revertChangeId,
            commitSequence,
            status: "retracted" as const,
          };
          const { contentHash: _oldHash, ...withoutOldHash } = base;
          restored = Schema.decodeUnknownSync(SpaceMemoryEntry)({
            ...withoutOldHash,
            contentHash: hashJson(withoutOldHash),
          });
        } else {
          const previous = yield* readRevision(
            original.sourceScope,
            beforeRef.memoryId,
            beforeRef.revision,
          );
          if (previous.contentHash !== beforeRef.contentHash) {
            return yield* Effect.fail(
              new Error("The original Memory baseline no longer matches its receipt."),
            );
          }
          const commitSequence = yield* repository.nextSequence(input.ownerId);
          const revertChangeId = randomUUID();
          const base = {
            ...previous,
            revision: current.revision + 1,
            changeId: revertChangeId,
            commitSequence,
          };
          const { contentHash: _oldHash, ...withoutOldHash } = base;
          restored = Schema.decodeUnknownSync(SpaceMemoryEntry)({
            ...withoutOldHash,
            contentHash: hashJson(withoutOldHash),
          });
        }

        const timestamp = now();
        const changeId = restored.changeId;
        const revertChange = Schema.decodeUnknownSync(LearningChangeSet)({
          changeId,
          requestId: input.requestId,
          requestFingerprint: input.requestFingerprint,
          ownerId: input.ownerId,
          expertId: original.expertId,
          sourceScope: original.sourceScope,
          assetKind: "memory",
          before: refOf(current),
          after: refOf(restored),
          sourceRefs: original.sourceRefs,
          status: "committed",
          summary: `Reverted ${original.summary}`.slice(0, 2_000),
          data: { revertedChangeId: original.changeId },
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* repository.writeRevision(restored, current.revision);
        yield* repository.createChange(revertChange);
        yield* repository.updateChange({ ...original, status: "reverted", updatedAt: timestamp });
        return { entry: restored, changeSet: revertChange, idempotent: false };
      }),
    );

  const prepareChange = (input: PrepareChangeInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        if (
          input.sourceScope.ownerId !== input.ownerId ||
          input.sourceScope.expertId !== input.expertId
        ) {
          return yield* Effect.fail(
            new Error(
              "A learning change cannot claim a different owner or Expert than its source scope.",
            ),
          );
        }
        const previous = yield* repository.findChangeByRequest(
          input.ownerId,
          input.expertId,
          input.requestId,
        );
        if (previous) {
          if (
            previous.requestFingerprint !== input.requestFingerprint ||
            previous.assetKind !== input.assetKind
          ) {
            return yield* Effect.fail(
              new Error("A learning request ID was reused with a different change."),
            );
          }
          return previous;
        }
        const sourceRefs = yield* Effect.try({
          try: () => normalizeSourceReferences(input.sourceRefs ?? []),
          catch: (cause) => cause,
        });
        const timestamp = now();
        const changeSet = Schema.decodeUnknownSync(LearningChangeSet)({
          changeId: randomUUID(),
          requestId: input.requestId,
          requestFingerprint: input.requestFingerprint,
          ownerId: input.ownerId,
          expertId: input.expertId,
          sourceScope: input.sourceScope,
          assetKind: input.assetKind,
          sourceRefs,
          status: "prepared",
          summary: input.summary,
          ...(input.operationRef !== undefined ? { operationRef: input.operationRef } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        yield* repository.createChange(changeSet);
        return changeSet;
      }),
    );

  const stageChange = (input: StageChangeInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        const previous = yield* getChange(input.ownerId, input.changeId);
        if (!previous) {
          return yield* Effect.fail(new Error("The prepared learning change does not exist."));
        }
        if (previous.requestFingerprint !== input.requestFingerprint) {
          return yield* Effect.fail(
            new Error("The learning change request fingerprint does not match its receipt."),
          );
        }
        if (previous.operationRef !== undefined) {
          const sameOperationRef = yield* Effect.try({
            try: () =>
              stableJsonStringify(JSON.parse(JSON.stringify(previous.operationRef))) ===
              stableJsonStringify(JSON.parse(JSON.stringify(input.operationRef))),
            catch: (cause) => cause,
          });
          if (!sameOperationRef) {
            return yield* Effect.fail(
              new Error("A staged learning operation intent is write-once."),
            );
          }
          return previous;
        }
        if (previous.status !== "prepared") {
          return yield* Effect.fail(
            new Error("A learning operation intent can only be staged while prepared."),
          );
        }

        const staged = Schema.decodeUnknownSync(LearningChangeSet)({
          ...previous,
          operationRef: input.operationRef,
          updatedAt: now(),
        });
        yield* repository.updateChange(staged);
        return staged;
      }),
    );

  const markReverted = (input: MarkRevertedInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        const original = yield* getChange(input.ownerId, input.changeId);
        if (!original) {
          return yield* Effect.fail(new Error("The original learning change does not exist."));
        }
        const inverse = yield* getChange(input.ownerId, input.revertChangeId);
        if (!inverse) {
          return yield* Effect.fail(
            new Error("The committed inverse learning receipt does not exist."),
          );
        }
        if (
          inverse.changeId === original.changeId ||
          inverse.expertId !== original.expertId ||
          inverse.assetKind !== original.assetKind
        ) {
          return yield* Effect.fail(
            new Error("The inverse receipt must belong to the same Expert and asset."),
          );
        }
        if (inverse.status !== "committed") {
          return yield* Effect.fail(new Error("The inverse learning receipt is not committed."));
        }
        if (
          inverse.data?.reverts !== original.changeId &&
          inverse.data?.revertedChangeId !== original.changeId
        ) {
          return yield* Effect.fail(
            new Error("The inverse receipt does not reference this change."),
          );
        }
        if (original.status === "reverted") return original;
        if (original.status !== "committed") {
          return yield* Effect.fail(
            new Error("Only a committed learning change can be marked reverted."),
          );
        }
        const reverted = Schema.decodeUnknownSync(LearningChangeSet)({
          ...original,
          status: "reverted",
          updatedAt: now(),
        });
        yield* repository.updateChange(reverted);
        return reverted;
      }),
    );

  const completeChange = (input: CompleteChangeInput) =>
    repository.withTransaction(
      Effect.gen(function* () {
        const previous = yield* getChange(input.ownerId, input.changeId);
        if (!previous)
          return yield* Effect.fail(new Error("The prepared learning change does not exist."));
        const after = input.after !== undefined ? input.after : previous.after;
        if (
          input.status === "committed" &&
          (after === undefined || after === null || after.assetKind !== previous.assetKind)
        ) {
          return yield* Effect.fail(
            new Error(
              "A committed learning change must include an exact after reference for its asset.",
            ),
          );
        }
        if (
          input.before !== undefined &&
          input.before !== null &&
          input.before.assetKind !== previous.assetKind
        ) {
          return yield* Effect.fail(
            new Error("A learning change before reference must match its asset kind."),
          );
        }
        if (
          input.after !== undefined &&
          input.after !== null &&
          input.after.assetKind !== previous.assetKind
        ) {
          return yield* Effect.fail(
            new Error("A learning change after reference must match its asset kind."),
          );
        }
        const requested = {
          ...previous,
          status: input.status,
          ...(input.before !== undefined ? { before: input.before } : {}),
          ...(input.after !== undefined ? { after: input.after } : {}),
          ...(input.operationRef !== undefined ? { operationRef: input.operationRef } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
          ...(input.summary !== undefined ? { summary: input.summary } : {}),
          updatedAt: now(),
        };
        if (previous.status === input.status) {
          const comparablePrevious = { ...previous, updatedAt: requested.updatedAt };
          const comparableRequested = { ...requested, updatedAt: requested.updatedAt };
          if (JSON.stringify(comparablePrevious) !== JSON.stringify(comparableRequested)) {
            return yield* Effect.fail(
              new Error("A completed learning change cannot be rewritten."),
            );
          }
          return previous;
        }
        if (previous.status !== "prepared" && previous.status !== "saved_unbound") {
          return yield* Effect.fail(
            new Error("This learning change has already reached a terminal status."),
          );
        }
        const completed = Schema.decodeUnknownSync(LearningChangeSet)(requested);
        yield* repository.updateChange(completed);
        return completed;
      }),
    );

  const recordRead = (manifestId: string, entry: SpaceMemoryEntry, toolCallId: string) =>
    Effect.gen(function* () {
      const rawManifest = yield* repository.readManifest(manifestId);
      if (rawManifest === undefined) {
        return yield* Effect.fail(
          new Error("The requested Run knowledge manifest does not exist."),
        );
      }
      const manifest = yield* verifyManifest(rawManifest);
      if (!entryApplies(entry, manifest.scope)) {
        return yield* Effect.fail(
          new Error("The Memory revision is outside the manifest's authorized scope."),
        );
      }
      const actual = yield* readRevision(manifest.scope, entry.memoryId, entry.revision);
      if (actual.contentHash !== entry.contentHash) {
        return yield* Effect.fail(
          new Error("The requested Memory read does not match its immutable revision."),
        );
      }
      if (entry.kind === "rule") {
        if (
          !manifest.rules.some(
            (ref) =>
              ref.memoryId === actual.memoryId &&
              ref.revision === actual.revision &&
              ref.contentHash === actual.contentHash,
          )
        ) {
          return yield* Effect.fail(
            new Error("A Run can only read rule revisions pinned by its knowledge manifest."),
          );
        }
      } else {
        const latest = yield* readApplicable({ scope: manifest.scope, kinds: [entry.kind] });
        if (
          !latest.some(
            (candidate) =>
              candidate.memoryId === actual.memoryId &&
              candidate.revision === actual.revision &&
              candidate.contentHash === actual.contentHash,
          )
        ) {
          return yield* Effect.fail(
            new Error("A fact or environment read must use the current applicable revision."),
          );
        }
      }
      const receipt = Schema.decodeUnknownSync(SpaceMemoryReadReceipt)({
        manifestId,
        memoryId: actual.memoryId,
        revision: actual.revision,
        contentHash: actual.contentHash,
        toolCallId,
        readAt: now(),
      });
      yield* repository.createReadReceipt(receipt);
      return receipt;
    });

  const readChange = (ownerId: string, expertId: string, requestId: string) =>
    repository.findChangeByRequest(ownerId, expertId, requestId).pipe(
      Effect.flatMap((change) =>
        change === undefined
          ? Effect.succeed(undefined)
          : Effect.try({
              try: () => Schema.decodeUnknownSync(LearningChangeSet)(change),
              catch: (cause) => cause,
            }),
      ),
    );

  const findSourceChanges = (
    ownerId: string,
    expertId: string,
    sources: readonly LearningSourceReference[],
  ) =>
    Effect.try({
      try: () => {
        Schema.decodeUnknownSync(MemoryScope)({
          ownerId,
          expertId,
          spaceId: null,
          projectId: "source-change-query",
        });
        return Schema.decodeUnknownSync(SourceChangeLookupSources)(sources);
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.flatMap((checkedSources) =>
        checkedSources.length === 0
          ? Effect.succeed([] as readonly LearningChangeSet[])
          : repository.findSourceChanges(ownerId, expertId, checkedSources).pipe(
              Effect.flatMap((changes) =>
                changes.length > MAX_SOURCE_CHANGE_RESULTS
                  ? Effect.fail(
                      new Error(
                        "Source change lookup exceeded the 256-change limit; narrow the source identities.",
                      ),
                    )
                  : Effect.try({
                      try: () =>
                        changes.map((change) =>
                          Schema.decodeUnknownSync(LearningChangeSet)(change),
                        ),
                      catch: (cause) => cause,
                    }),
              ),
            ),
      ),
    );

  return {
    commit,
    readApplicable,
    readRevision,
    ruleSequence: (ownerId: string) => repository.sequence(ownerId),
    prepareRunManifest,
    readManifest,
    findRunManifest,
    recordRead,
    listChanges: (ownerId: string, expertId: string, limit = 50) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
        return Effect.fail(
          new Error(`Change list limit must be between 1 and ${MAX_CHANGE_LIMIT}.`),
        );
      }
      return repository.listChanges(ownerId, expertId, limit);
    },
    revert,
    prepareChange,
    stageChange,
    markReverted,
    completeChange,
    readChange,
    findSourceChanges,
    getChange,
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      repository.withTransaction(effect),
  } satisfies SpaceMemoryServiceShape;
});

export const SpaceMemoryServiceLive = Layer.effect(SpaceMemoryService, makeSpaceMemoryService);
