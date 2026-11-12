import { randomUUID } from "node:crypto";
import type {
  CapabilityBinding,
  ExecutionPurpose,
  ProjectId,
  SuiteComposition,
  SuiteRef,
  SuiteResourceUse,
} from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import { ServerConfig } from "../config";
import { createExpertStore } from "../experts/ExpertStore";
import { createExpertConnectionStore } from "../experts/ExpertConnectionStore";
import {
  SuiteCompositionStore,
  SuiteStoreError,
  capabilityBindingFingerprint,
} from "./SuiteCompositionStore";
import { canonicalSuiteJson } from "./suiteIdentity";

/** Scope is derived from the trusted execution purpose, never from the parent runtime. */
export function suiteResourcesFor(
  composition: SuiteComposition,
  purpose: ExecutionPurpose,
  expertId?: string,
): readonly SuiteResourceUse[] {
  const member =
    expertId === undefined
      ? undefined
      : composition.members.find((item) => item.expertId === expertId);
  if (purpose.kind !== "hub-coordinator" && !member)
    throw new SuiteStoreError(
      "The Expert is not a member of the selected Suite revision.",
      "permission_denied",
    );
  return composition.resources.filter(
    ({ audience }) =>
      audience === "shared" ||
      (purpose.kind === "hub-coordinator"
        ? audience === "coordinator"
        : typeof audience === "object" && audience.expertKey === member?.key),
  );
}
export interface SuiteBindingResolverShape {
  readonly prepare: (input: {
    readonly suite: SuiteRef | null;
    readonly purpose: ExecutionPurpose;
    readonly projectId: ProjectId;
    readonly projectRoot?: string;
  }) => Effect.Effect<CapabilityBinding, SuiteStoreError>;
}
export class SuiteBindingResolver extends ServiceMap.Service<
  SuiteBindingResolver,
  SuiteBindingResolverShape
>()("synara/suites/SuiteBindingResolver") {}
export const makeSuiteBindingResolver = Effect.gen(function* () {
  const store = yield* SuiteCompositionStore;
  const config = yield* ServerConfig;
  const experts = createExpertStore(config.stateDir);
  const connections = createExpertConnectionStore(config.stateDir);
  const prepare: SuiteBindingResolverShape["prepare"] = (input) =>
    Effect.gen(function* () {
      const snapshotId =
        input.purpose.kind === "hub-coordinator" ? null : input.purpose.expertSnapshotId;
      const snapshot =
        snapshotId === null
          ? null
          : yield* Effect.tryPromise({
              try: () => experts.readSnapshot(snapshotId),
              catch: (cause) =>
                new SuiteStoreError(
                  "The pinned Expert identity is unavailable.",
                  "identity_unavailable",
                  { cause },
                ),
            });
      const suite = input.suite === null ? null : yield* store.read(input.suite);
      if (input.suite !== null && suite === null)
        return yield* Effect.fail(
          new SuiteStoreError("The selected Suite revision is unavailable.", "suite_missing"),
        );
      const uses = yield* Effect.try({
        try: () => (suite ? suiteResourcesFor(suite, input.purpose, snapshot?.expertId) : []),
        catch: (cause) =>
          cause instanceof SuiteStoreError
            ? cause
            : new SuiteStoreError("Suite scope is invalid.", "permission_denied", { cause }),
      });
      const selected = new Map(
        (snapshot?.connections ?? []).map((connection) => [connection.id, connection]),
      );
      for (const use of uses) {
        if (use.ref.kind !== "connection") continue;
        const connection = use.ref.connection;
        const previous = selected.get(connection.id);
        // A conflicting selection cannot silently become a union/all-tools grant.
        if (
          previous &&
          canonicalSuiteJson({
            enabled: previous.enabled ?? true,
            mode: previous.toolMode ?? "selected",
            tools: [...previous.tools].sort(),
          }) !==
            canonicalSuiteJson({
              enabled: connection.enabled ?? true,
              mode: connection.toolMode ?? "selected",
              tools: [...connection.tools].sort(),
            })
        ) {
          selected.set(connection.id, {
            ...previous,
            enabled: false,
            tools: [],
            toolMode: "selected",
          });
        } else
          selected.set(
            connection.id,
            previous
              ? { ...connection, required: previous.required || connection.required }
              : connection,
          );
      }
      const effective = [...selected.values()];
      const servers: NonNullable<CapabilityBinding["mcpBinding"]>["servers"][number][] = [];
      for (const connection of effective) {
        if (
          connection.enabled === false ||
          (connection.toolMode !== "all" && connection.tools.length === 0)
        )
          continue;
        const pinned = snapshot?.mcpBinding?.servers.find((server) => server.id === connection.id);
        const revision = pinned
          ? pinned.configRevision
          : (yield* Effect.tryPromise({
              try: () => connections.pinRevision(connection.id),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => null)))?.revision;
        servers.push({
          id: connection.id,
          ...(revision !== undefined ? { configRevision: revision } : {}),
          required: connection.required,
          ...(connection.toolMode ? { toolMode: connection.toolMode } : {}),
          tools: connection.tools,
        });
      }
      const createdAt = new Date().toISOString();
      const binding: CapabilityBinding = {
        schemaVersion: 1,
        bindingId: `cap_${randomUUID()}`,
        bindingHash: "0".repeat(64),
        suite: input.suite,
        purpose: input.purpose,
        projectId: input.projectId,
        connections: effective,
        mcpBinding: {
          schemaVersion: 1,
          source: "snapshot",
          ...(servers.some((server) => server.toolMode === "all")
            ? { authorizationId: randomUUID() }
            : {}),
          createdAt,
          servers,
        },
        createdAt,
      };
      return yield* store.saveBinding({
        ...binding,
        bindingHash: capabilityBindingFingerprint(binding),
      });
    });
  return { prepare };
});
export const SuiteBindingResolverLive = Layer.effect(
  SuiteBindingResolver,
  makeSuiteBindingResolver,
);
