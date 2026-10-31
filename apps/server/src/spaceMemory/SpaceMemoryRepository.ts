import { Effect, ServiceMap } from "effect";
import type {
  LearningChangeSet,
  MemoryScope,
  RunKnowledgeManifest,
  SpaceMemoryEntry,
  SpaceMemoryReadReceipt,
  LearningSourceReference,
} from "@synara/contracts";

export interface SpaceMemoryRepositoryShape {
  readonly withTransaction: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, unknown, R>;
  readonly sequence: (ownerId: string) => Effect.Effect<number, unknown>;
  readonly nextSequence: (ownerId: string) => Effect.Effect<number, unknown>;
  readonly readHead: (
    ownerId: string,
    memoryId: string,
  ) => Effect.Effect<SpaceMemoryEntry | undefined, unknown>;
  readonly readRevision: (
    ownerId: string,
    memoryId: string,
    revision: number,
  ) => Effect.Effect<SpaceMemoryEntry | undefined, unknown>;
  readonly listAtSequence: (
    scope: MemoryScope,
    sequence: number,
    kinds: readonly string[],
  ) => Effect.Effect<readonly SpaceMemoryEntry[], unknown>;
  readonly writeRevision: (
    entry: SpaceMemoryEntry,
    expectedRevision: number,
  ) => Effect.Effect<void, unknown>;
  readonly findChangeByRequest: (
    ownerId: string,
    expertId: string,
    requestId: string,
  ) => Effect.Effect<LearningChangeSet | undefined, unknown>;
  readonly getChange: (
    ownerId: string,
    changeId: string,
  ) => Effect.Effect<LearningChangeSet | undefined, unknown>;
  readonly createChange: (change: LearningChangeSet) => Effect.Effect<void, unknown>;
  readonly updateChange: (change: LearningChangeSet) => Effect.Effect<void, unknown>;
  readonly listChanges: (
    ownerId: string,
    expertId: string,
    limit: number,
  ) => Effect.Effect<readonly LearningChangeSet[], unknown>;
  readonly findSourceChanges: (
    ownerId: string,
    expertId: string,
    sources: readonly LearningSourceReference[],
  ) => Effect.Effect<readonly LearningChangeSet[], unknown>;
  readonly readManifest: (
    manifestId: string,
  ) => Effect.Effect<RunKnowledgeManifest | undefined, unknown>;
  readonly findManifestByRoot: (
    scope: MemoryScope,
    rootRunId: string,
  ) => Effect.Effect<RunKnowledgeManifest | undefined, unknown>;
  readonly createManifest: (manifest: RunKnowledgeManifest) => Effect.Effect<void, unknown>;
  readonly createReadReceipt: (receipt: SpaceMemoryReadReceipt) => Effect.Effect<void, unknown>;
}

export class SpaceMemoryRepository extends ServiceMap.Service<
  SpaceMemoryRepository,
  SpaceMemoryRepositoryShape
>()("synara/SpaceMemoryRepository") {}
