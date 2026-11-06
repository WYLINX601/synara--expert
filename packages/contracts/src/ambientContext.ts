import { Schema } from "effect";

// Ambient data is external, untrusted task input. These schemas grant no tool,
// filesystem or application permissions, even when a resource URI is present.
export const AMBIENT_CONTEXT_MAX_OBSERVATIONS = 64;
export const AMBIENT_CONTEXT_MAX_TEXT_LENGTH = 16_384;
export const AMBIENT_CONTEXT_MAX_SNAPSHOT_LENGTH = 65_536;

const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const Label = Schema.String.check(Schema.isMaxLength(512));
const Uri = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const Text = Schema.String.check(Schema.isMaxLength(AMBIENT_CONTEXT_MAX_TEXT_LENGTH));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((value: string) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value;
  }),
);

export const AmbientContextType = Schema.Literals([
  "application.identity",
  "window.identity",
  "resource.identity",
  "selection.text",
  "selection.location",
  "element.identity",
  "resource.content",
]);
export type AmbientContextType = typeof AmbientContextType.Type;

export const AmbientContextSourceManifest = Schema.Struct({
  id: Id,
  label: Label,
  kind: Schema.Literals(["application", "system"]),
  capabilities: Schema.Array(
    Schema.Struct({
      type: AmbientContextType,
      captureMode: Schema.Literals(["event", "on-demand"]),
      requiredPermissions: Schema.Array(Id).check(Schema.isMaxLength(8)),
      precision: Schema.Literals(["exact", "approximate"]),
    }),
  ).check(Schema.isMaxLength(7)),
});
export type AmbientContextSourceManifest = typeof AmbientContextSourceManifest.Type;

export const AmbientContextSourcePolicy = Schema.Struct({
  enabled: Schema.Boolean,
  allowedTypes: Schema.Array(AmbientContextType).check(Schema.isMaxLength(7)),
});
export type AmbientContextSourcePolicy = typeof AmbientContextSourcePolicy.Type;
export const AmbientContextPolicy = Schema.Record(Id, AmbientContextSourcePolicy).check(
  Schema.isMaxProperties(32),
);
export type AmbientContextPolicy = typeof AmbientContextPolicy.Type;

const Position = Schema.Struct({ line: Index, column: Index });
const common = {
  schemaVersion: Schema.Literal(1),
  id: Id,
  // Opaque, source-local identity; never put a path, URL or window title here.
  // Cross-source correlation requires explicit resource.identity observations.
  targetKey: Id,
  capturedAt: Timestamp,
  method: Label,
  confidence: Schema.Literals(["exact", "probable", "unknown"]),
};
export const AmbientContextObservation = Schema.Union([
  Schema.Struct({
    ...common,
    type: Schema.Literal("application.identity"),
    value: Schema.Struct({ applicationId: Id, name: Label }),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("window.identity"),
    value: Schema.Struct({ windowId: Id, title: Label }),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("resource.identity"),
    value: Schema.Struct({
      uri: Uri,
      title: Label,
      kind: Schema.Literals(["file", "webpage", "document"]),
    }),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("selection.text"),
    value: Schema.Struct({ text: Text }),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("selection.location"),
    value: Schema.Struct({ start: Position, end: Position }).check(
      Schema.makeFilter(
        ({ start, end }) =>
          end.line > start.line || (end.line === start.line && end.column >= start.column),
      ),
    ),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("element.identity"),
    value: Schema.Struct({ selector: Label, role: Label, name: Label }),
  }),
  Schema.Struct({
    ...common,
    type: Schema.Literal("resource.content"),
    value: Schema.Struct({ text: Text, truncated: Schema.Boolean }),
  }),
]);
export type AmbientContextObservation = typeof AmbientContextObservation.Type;

export const AmbientContextProvenance = Schema.Struct({
  sourceId: Id,
  observationId: Id,
  capturedAt: Timestamp,
  method: Label,
  confidence: Schema.Literals(["exact", "probable", "unknown"]),
});
export const ResolvedAmbientContextItem = Schema.Struct({
  observation: AmbientContextObservation,
  provenance: Schema.Array(AmbientContextProvenance).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(32),
  ),
  ambiguous: Schema.Boolean,
});
export type ResolvedAmbientContextItem = typeof ResolvedAmbientContextItem.Type;

export const AmbientContextSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Id,
  capturedAt: Timestamp,
  items: Schema.Array(ResolvedAmbientContextItem).check(
    Schema.isMaxLength(AMBIENT_CONTEXT_MAX_OBSERVATIONS),
  ),
}).check(
  Schema.makeFilter(
    (snapshot) => JSON.stringify(snapshot).length <= AMBIENT_CONTEXT_MAX_SNAPSHOT_LENGTH,
  ),
);
export type AmbientContextSnapshot = typeof AmbientContextSnapshot.Type;

// Each publication is a complete replacement, including an empty array when
// selection/file focus is cleared. Sequence is monotonic within a connection.
export const AmbientContextPublication = Schema.Struct({
  sequence: Index,
  observations: Schema.Array(AmbientContextObservation).check(
    Schema.isMaxLength(AMBIENT_CONTEXT_MAX_OBSERVATIONS),
  ),
}).check(
  Schema.makeFilter(
    (publication) => JSON.stringify(publication).length <= AMBIENT_CONTEXT_MAX_SNAPSHOT_LENGTH,
  ),
);
export type AmbientContextPublication = typeof AmbientContextPublication.Type;

export const AmbientResourceReference = Schema.Struct({
  sourceId: Id,
  targetKey: Id,
  uri: Uri,
  title: Label,
});
export type AmbientResourceReference = typeof AmbientResourceReference.Type;

export interface AmbientContextDesktopState {
  readonly sources: readonly {
    readonly manifest: AmbientContextSourceManifest;
    readonly policy: AmbientContextSourcePolicy;
    readonly connected: boolean;
    readonly error: string | null;
  }[];
  readonly items: readonly ResolvedAmbientContextItem[];
}

export interface AmbientContextDesktopMethods {
  getState(): Promise<AmbientContextDesktopState>;
  configure(
    sourceId: string,
    policy: AmbientContextSourcePolicy,
  ): Promise<AmbientContextDesktopState>;
  /** Explicit session pairing only. Credentials must never enter messages or diagnostics. */
  getPairing(sourceId: string): Promise<{ endpoint: string; token: string }>;
  capture(): Promise<AmbientContextSnapshot>;
  searchResources(query: string): Promise<readonly AmbientResourceReference[]>;
  onChanged(listener: () => void): () => void;
}
