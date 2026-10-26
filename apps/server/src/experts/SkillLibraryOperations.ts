import * as path from "node:path";

import { Schema } from "effect";
import {
  IsoDateTime,
  ExpertSkillBinding,
  ExpertDefinition,
  SkillDefinition,
  SkillLibraryBatchResult,
  SkillLibraryBindingResult,
  SkillLibraryBindingState,
  SkillLibraryResponse,
  SkillLibraryUpdateResult,
  SkillPackageId,
  TrimmedNonEmptyString,
  type SkillLibraryBatchResult as BatchResult,
  type SkillLibraryBindingResult as BindingResult,
  type SkillLibraryBindingState as BindingState,
  type SkillLibraryResponse as Response,
  type SkillLibraryUpdateResult as UpdateResult,
} from "@synara/contracts";

import { ensurePrivateDirectorySync } from "../privatePathPermissions.ts";
import {
  readPrivateJsonFile,
  serializeJsonWithinByteLimit,
  writePrivateFileAtomically,
} from "./ExpertMcpStorage.ts";

const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const BindingIntent = Schema.Struct({
  expertId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  expectedExpert: ExpertDefinition,
  bindings: Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
  addedSkillIds: Schema.optional(Schema.Array(Schema.String)),
  skippedSkillIds: Schema.optional(Schema.Array(Schema.String)),
});
const DeleteIntent = Schema.Struct({
  expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  tombstone: SkillDefinition,
  experts: Schema.Array(
    Schema.Struct({
      expertId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
      expectedRevision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
      expectedExpert: ExpertDefinition,
      expectedBindings: Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
      bindings: Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
    }),
  ).check(Schema.isMaxLength(1000)),
});
const BatchIntent = Schema.Struct({
  index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  skill: Schema.optional(SkillDefinition),
  delete: Schema.optional(DeleteIntent),
});
const OperationRecord = Schema.Struct({
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  operation: Schema.Literals([
    "create",
    "save",
    "import",
    "refresh",
    "delete",
    "batch",
    "bindings",
    "bindExperts",
    "updateFromSource",
  ]),
  fingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  updatedAt: IsoDateTime,
  response: Schema.optional(SkillLibraryResponse),
  plannedSkillId: Schema.optional(Schema.String.check(Schema.isPattern(/^skl_[a-f0-9]{32}$/u))),
  plannedSkillIds: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isPattern(/^skl_[a-f0-9]{32}$/u))),
  ),
  plannedRevision: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
  plannedSkill: Schema.optional(SkillDefinition),
  plannedSkills: Schema.optional(Schema.Array(SkillDefinition).check(Schema.isMaxLength(5_000))),
  deleteIntent: Schema.optional(DeleteIntent),
  bindingIntent: Schema.optional(BindingIntent),
  bindingIntents: Schema.optional(Schema.Array(BindingIntent).check(Schema.isMaxLength(1000))),
  batchIntents: Schema.optional(Schema.Array(BatchIntent).check(Schema.isMaxLength(1000))),
  batchResults: Schema.optional(
    Schema.Array(
      Schema.Struct({
        index: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
        result: SkillLibraryBatchResult,
      }),
    ),
  ),
  bindingResults: Schema.optional(Schema.Array(SkillLibraryBindingResult)),
  bindingResult: Schema.optional(SkillLibraryBindingState),
  updateResult: Schema.optional(SkillLibraryUpdateResult),
  plannedPackageId: Schema.optional(SkillPackageId),
});
const OperationJournal = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  requests: Schema.Array(OperationRecord),
});
type OperationRecord = typeof OperationRecord.Type;
type Operation = OperationRecord["operation"];
export type SkillLibraryDeleteIntent = typeof DeleteIntent.Type;
export type SkillLibraryBindingIntent = typeof BindingIntent.Type;

export class SkillLibraryRequestIdConflict extends Error {
  constructor() {
    super("This requestId was already used with different operation content.");
    this.name = "SkillLibraryRequestIdConflict";
  }
}

/** Durable idempotency receipts for the structured Skill binding/update operations. */
export function createSkillLibraryOperations(stateDir: string) {
  const file = path.join(stateDir, "experts", "skill-library-operations.json");
  ensurePrivateDirectorySync(path.dirname(file));

  const read = async (): Promise<OperationRecord[]> => {
    const value = await readPrivateJsonFile(
      file,
      MAX_JOURNAL_BYTES,
      "Skill library operation journal is unsafe or unreadable.",
      true,
    );
    if (value === undefined) return [];
    return [...Schema.decodeUnknownSync(OperationJournal)(value).requests];
  };
  const write = async (requests: ReadonlyArray<OperationRecord>) => {
    const contents = serializeJsonWithinByteLimit(
      { schemaVersion: 1, requests },
      MAX_JOURNAL_BYTES,
      "Skill library operation journal exceeds its 64 MiB limit.",
    );
    await writePrivateFileAtomically(file, contents);
  };

  const begin = async (
    requestId: string,
    operation: Operation,
    fingerprint: string,
  ): Promise<OperationRecord> => {
    const requests = await read(),
      existing = requests.find((entry) => entry.requestId === requestId);
    if (existing) {
      if (existing.operation !== operation || existing.fingerprint !== fingerprint)
        throw new SkillLibraryRequestIdConflict();
      return existing;
    }
    const created = Schema.decodeUnknownSync(OperationRecord)({
      requestId,
      operation,
      fingerprint,
      updatedAt: new Date().toISOString(),
    });
    await write([...requests, created]);
    return created;
  };
  const update = async (
    requestId: string,
    operation: Operation,
    fingerprint: string,
    patch: Partial<
      Pick<
        OperationRecord,
        | "response"
        | "plannedSkillId"
        | "plannedSkillIds"
        | "plannedRevision"
        | "plannedSkill"
        | "plannedSkills"
        | "deleteIntent"
        | "bindingIntent"
        | "bindingIntents"
        | "batchIntents"
        | "batchResults"
        | "bindingResults"
        | "bindingResult"
        | "updateResult"
        | "plannedPackageId"
      >
    >,
  ): Promise<OperationRecord> => {
    const requests = await read(),
      index = requests.findIndex((entry) => entry.requestId === requestId);
    if (index < 0) throw new Error("Skill library operation journal entry disappeared.");
    const previous = requests[index]!;
    if (previous.operation !== operation || previous.fingerprint !== fingerprint)
      throw new SkillLibraryRequestIdConflict();
    const next = Schema.decodeUnknownSync(OperationRecord)({
      ...previous,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    const result = [...requests];
    result[index] = next;
    await write(result);
    return next;
  };
  const recordBindingResult = async (
    requestId: string,
    operation: "bindExperts",
    fingerprint: string,
    result: BindingResult,
  ) => {
    const record = await begin(requestId, operation, fingerprint),
      results = [
        ...(record.bindingResults ?? []).filter((item) => item.expertId !== result.expertId),
        result,
      ];
    return update(requestId, operation, fingerprint, { bindingResults: results });
  };

  const recordBatchResult = async (
    requestId: string,
    fingerprint: string,
    index: number,
    result: BatchResult,
  ) => {
    const record = await begin(requestId, "batch", fingerprint),
      results = [
        ...(record.batchResults ?? []).filter((item) => item.index !== index),
        { index, result },
      ].toSorted((left, right) => left.index - right.index);
    return update(requestId, "batch", fingerprint, { batchResults: results });
  };
  const recordBatchIntent = async (
    requestId: string,
    fingerprint: string,
    intent: typeof BatchIntent.Type,
  ) => {
    const record = await begin(requestId, "batch", fingerprint),
      intents = [
        ...(record.batchIntents ?? []).filter((item) => item.index !== intent.index),
        intent,
      ].toSorted((left, right) => left.index - right.index);
    return update(requestId, "batch", fingerprint, { batchIntents: intents });
  };
  const recordBindingIntent = async (
    requestId: string,
    operation: "bindings" | "bindExperts",
    fingerprint: string,
    intent: SkillLibraryBindingIntent,
  ) => {
    const record = await begin(requestId, operation, fingerprint);
    if (operation === "bindings")
      return update(requestId, operation, fingerprint, { bindingIntent: intent });
    const intents = [
      ...(record.bindingIntents ?? []).filter((item) => item.expertId !== intent.expertId),
      intent,
    ].toSorted((left, right) => left.expertId.localeCompare(right.expertId));
    return update(requestId, operation, fingerprint, { bindingIntents: intents });
  };
  const recordDeleteIntent = async (
    requestId: string,
    operation: "delete" | "batch",
    fingerprint: string,
    intent: SkillLibraryDeleteIntent,
    index?: number,
  ) => {
    if (operation === "delete")
      return update(requestId, operation, fingerprint, { deleteIntent: intent });
    if (index === undefined) throw new Error("Batch deletion intent requires an item index.");
    return recordBatchIntent(requestId, fingerprint, { index, delete: intent });
  };

  return {
    begin,
    read: async (requestId: string) =>
      (await read()).find((entry) => entry.requestId === requestId),
    update,
    recordResponse: (
      requestId: string,
      operation: Operation,
      fingerprint: string,
      response: Response,
    ) =>
      update(requestId, operation, fingerprint, {
        response,
        plannedSkillId: undefined,
        plannedSkillIds: undefined,
        plannedRevision: undefined,
        plannedSkill: undefined,
        plannedSkills: undefined,
        deleteIntent: undefined,
        bindingIntent: undefined,
        bindingIntents: undefined,
        batchIntents: undefined,
        batchResults: undefined,
        plannedPackageId: undefined,
      }),
    recordPlan: (
      requestId: string,
      operation: Operation,
      fingerprint: string,
      plan: Pick<
        OperationRecord,
        | "plannedSkillId"
        | "plannedSkillIds"
        | "plannedRevision"
        | "plannedPackageId"
        | "plannedSkill"
        | "plannedSkills"
      >,
    ) => update(requestId, operation, fingerprint, plan),
    recordBatchResult,
    recordBatchIntent,
    recordDeleteIntent,
    recordBindingIntent,
    recordBindingResult,
    recordBindingState: (requestId: string, fingerprint: string, result: BindingState) =>
      update(requestId, "bindings", fingerprint, { bindingResult: result }),
    recordUpdateResult: (requestId: string, fingerprint: string, result: UpdateResult) =>
      update(requestId, "updateFromSource", fingerprint, { updateResult: result }),
    recordPlannedPackage: (requestId: string, fingerprint: string, packageId: string) =>
      update(requestId, "updateFromSource", fingerprint, {
        plannedPackageId: packageId as OperationRecord["plannedPackageId"],
      }),
  };
}
