import * as path from "node:path";
import {
  WS_METHODS,
  WsRpcError,
  type EffectiveSuiteConfig,
  type SuiteCancelPreviewInput,
  type SuiteImportReceiptInput,
  type SuiteImportRequest,
  type SuitePreviewInput,
  type SuiteRef,
  type SuiteRunConfiguration,
  type SuiteRunConfigurationInput,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect } from "effect";
import { readRunSkillAssembly } from "../../experts/RunSkillAssemblyStore";
import type { SuiteCompositionStoreShape } from "../../suites/SuiteCompositionStore";
import type { SuiteImportServiceShape } from "../../suites/SuiteImportService";
import type { RpcEffect } from "./expertRpc";

const absolute = (value: string) => path.isAbsolute(value) || path.win32.isAbsolute(value);
/** Public configuration contains no filesystem roots, private evidence, or owner errors. */
function publicConfiguration(config: EffectiveSuiteConfig): EffectiveSuiteConfig {
  const output = config.outputDirectory;
  const safeOutput =
    output !== null &&
    !absolute(output) &&
    !output.includes("\\") &&
    !output.split("/").some((part) => part === "..")
      ? output
      : null;
  return {
    language: config.language !== null && !absolute(config.language) ? config.language : null,
    outputDirectory: safeOutput,
    provenance: config.provenance.filter(
      (entry) =>
        !absolute(entry.sourceId) &&
        !absolute(entry.value) &&
        (entry.field !== "outputDirectory" || entry.value === safeOutput),
    ),
    issues: config.issues.map((entry) => ({
      ...entry,
      subject: {
        ...entry.subject,
        id: absolute(entry.subject.id) ? "private-resource" : entry.subject.id,
        path: null,
      },
      evidenceRef: null,
      // Owner diagnostics may contain absolute package roots even inside sentences.
      message: `Run capability diagnostic: ${entry.code}. Recovery: ${entry.recovery}.`,
    })),
  };
}

export function readAuthorizedSuiteRunConfiguration(input: {
  readonly stateDir: string;
  readonly request: SuiteRunConfigurationInput;
  readonly thread: Pick<OrchestrationThreadShell, "id" | "projectId" | "capabilityBindingId">;
  readonly store: SuiteCompositionStoreShape;
}) {
  return Effect.gen(function* () {
    if (input.thread.id !== input.request.threadId)
      return yield* Effect.fail(
        new WsRpcError({ message: "Thread authorization does not match the request." }),
      );
    const assembly = yield* Effect.tryPromise({
      try: () => readRunSkillAssembly(input.stateDir, input.request.rootRunId),
      catch: () => new WsRpcError({ message: "Failed to read the actual Run assembly." }),
    });
    if (!assembly) return { state: "not-prepared" } satisfies SuiteRunConfiguration;
    if (assembly.threadId !== input.thread.id)
      return yield* Effect.fail(
        new WsRpcError({ message: "This Run does not belong to the requested thread." }),
      );
    if (assembly.schemaVersion === 1)
      return {
        state: "prepared",
        suite: null,
        assemblyId: assembly.assemblyId,
        effectiveConfig: {
          language: null,
          outputDirectory: null,
          provenance: [],
          issues: [
            {
              code: "unsupported_capability",
              category: "execution",
              subject: { kind: "execution", id: "legacy-run-assembly", path: null },
              action: "run",
              effect: "observe",
              message:
                "This Run has a real legacy v1 assembly; it does not record structured Suite configuration.",
              evidenceRef: null,
              checkedAt: assembly.createdAt,
              recovery: "choose-alternative",
            },
          ],
        },
      } satisfies SuiteRunConfiguration;
    const binding = yield* input.store.readBinding(assembly.bindingId);
    if (
      !binding ||
      binding.bindingHash !== assembly.bindingHash ||
      binding.projectId !== input.thread.projectId ||
      input.thread.capabilityBindingId !== binding.bindingId
    )
      return yield* Effect.fail(
        new WsRpcError({ message: "Run capability binding does not match the authorized thread." }),
      );
    return {
      state: "prepared",
      suite: binding.suite,
      assemblyId: assembly.assemblyId,
      effectiveConfig: publicConfiguration(assembly.effectiveConfig),
    } satisfies SuiteRunConfiguration;
  });
}

/** Exactly the seven C-1 methods; authorization remains at the native WS boundary. */
export function makeWorkbenchSuiteRpcHandlers<R>(input: {
  readonly service: SuiteImportServiceShape;
  readonly store: SuiteCompositionStoreShape;
  readonly stateDir: string;
  readonly requireOwner: Effect.Effect<void, WsRpcError, R>;
  readonly requireThread: (
    request: SuiteRunConfigurationInput,
  ) => Effect.Effect<OrchestrationThreadShell, WsRpcError, R>;
  readonly rpcEffect: RpcEffect;
}) {
  const { service, rpcEffect, requireOwner } = input;
  return {
    [WS_METHODS.serverPreviewSuite]: (request: SuitePreviewInput) =>
      rpcEffect(
        requireOwner.pipe(Effect.andThen(service.preview(request))),
        "Failed to preview Suite",
      ),
    [WS_METHODS.serverCancelSuitePreview]: (request: SuiteCancelPreviewInput) =>
      rpcEffect(
        requireOwner.pipe(Effect.andThen(service.cancelPreview(request.previewId))),
        "Failed to cancel Suite preview",
      ),
    [WS_METHODS.serverCommitSuiteImport]: (request: SuiteImportRequest) =>
      rpcEffect(
        requireOwner.pipe(Effect.andThen(service.commit(request))),
        "Failed to commit Suite import",
      ),
    [WS_METHODS.serverGetSuiteImportReceipt]: (request: SuiteImportReceiptInput) =>
      rpcEffect(
        requireOwner.pipe(Effect.andThen(service.getReceipt(request.operationId))),
        "Failed to read Suite import receipt",
      ),
    [WS_METHODS.serverListSuites]: () =>
      rpcEffect(requireOwner.pipe(Effect.andThen(service.list())), "Failed to list Suites"),
    [WS_METHODS.serverReadSuite]: (request: SuiteRef) =>
      rpcEffect(requireOwner.pipe(Effect.andThen(service.read(request))), "Failed to read Suite"),
    [WS_METHODS.serverReadSuiteRunConfiguration]: (request: SuiteRunConfigurationInput) =>
      rpcEffect(
        requireOwner.pipe(
          Effect.andThen(input.requireThread(request)),
          Effect.flatMap((thread) =>
            readAuthorizedSuiteRunConfiguration({
              stateDir: input.stateDir,
              request,
              thread,
              store: input.store,
            }),
          ),
        ),
        "Failed to read Suite Run configuration",
      ),
  };
}
