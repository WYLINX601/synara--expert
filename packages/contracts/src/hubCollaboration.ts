import { Schema } from "effect";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const HubTeamId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const RequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const CoordinatorInstructions = Schema.String.check(Schema.isMaxLength(8_000));
const CollaborationPreferences = Schema.String.check(Schema.isMaxLength(8_000));
const ExpertIds = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(128))).check(
  Schema.isMaxLength(64),
);

export const HubTeamSource = Schema.Struct({ id: HubTeamId, revision: PositiveInt });
export type HubTeamSource = typeof HubTeamSource.Type;

/** An editable Hub copy, not a permission grant or an active plan snapshot. */
export const HubCollaborationSettings = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  mode: Schema.Literals(["standard", "expert-team"]),
  coordinatorInstructions: Schema.optional(CoordinatorInstructions),
  collaborationPreferences: Schema.optional(CollaborationPreferences),
  presetSource: Schema.optional(HubTeamSource),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubCollaborationSettings = typeof HubCollaborationSettings.Type;

const TeamFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  purpose: Schema.String.check(Schema.isMaxLength(8_000)),
  expertIds: ExpertIds,
  coordinatorInstructions: Schema.optional(CoordinatorInstructions),
  collaborationPreferences: Schema.optional(CollaborationPreferences),
};

export const HubTeamPreset = Schema.Struct({
  id: HubTeamId,
  ...TeamFields,
  revision: PositiveInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type HubTeamPreset = typeof HubTeamPreset.Type;

export const HubTeamSaveInput = Schema.Struct({
  id: HubTeamId,
  ...TeamFields,
  expectedRevision: Schema.NullOr(PositiveInt),
  requestId: RequestId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubTeamSaveInput = typeof HubTeamSaveInput.Type;

export const HubTeamReadInput = Schema.Struct({
  id: HubTeamId,
  revision: Schema.optional(PositiveInt),
});
export type HubTeamReadInput = typeof HubTeamReadInput.Type;

export const HubTeamArchiveInput = Schema.Struct({
  id: HubTeamId,
  expectedRevision: PositiveInt,
  requestId: RequestId,
  archived: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type HubTeamArchiveInput = typeof HubTeamArchiveInput.Type;

export interface HubTeamsApi {
  list: () => Promise<ReadonlyArray<HubTeamPreset>>;
  read: (input: HubTeamReadInput) => Promise<HubTeamPreset | null>;
  save: (input: HubTeamSaveInput) => Promise<HubTeamPreset>;
  setArchived: (input: HubTeamArchiveInput) => Promise<HubTeamPreset>;
}
