import { Layer } from "effect";

import { ExpertDelegationArtifactsLive } from "../workbench/host/expertDelegationArtifacts";
import { ExpertDelegationStoreLive } from "../workbench/host/expertDelegationStore";
import { NativeExpertReexecutionGateLive } from "../workbench/host/nativeExpertReexecutionGate";
import { GitHubCliLive } from "../git/Layers/GitHubCli";
import { ExpertAppliedRuntimeRepositoryLive } from "../persistence/Layers/ExpertAppliedRuntimeRecords";
import { ProjectionPendingInteractionRepositoryLive } from "../persistence/Layers/ProjectionPendingInteractions";
import { WorkbenchExpertRuntimeLive } from "../workbench/runtimeLayer";
import { SuiteBindingResolverLive } from "./SuiteBindingResolver";
import { SuiteCompositionStoreLive } from "./SuiteCompositionStore";
import { SuiteImportServiceLive } from "./SuiteImportService";

const workbenchRuntimeLayer = WorkbenchExpertRuntimeLive.pipe(
  Layer.provideMerge(ExpertAppliedRuntimeRepositoryLive),
);
const suiteBindingLayer = SuiteBindingResolverLive.pipe(
  Layer.provideMerge(SuiteCompositionStoreLive),
);
const delegationArtifactsLayer = ExpertDelegationArtifactsLive.pipe(
  Layer.provideMerge(ExpertDelegationStoreLive),
);
const suiteImportLayer = SuiteImportServiceLive.pipe(
  Layer.provideMerge(suiteBindingLayer),
  Layer.provideMerge(workbenchRuntimeLayer),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(delegationArtifactsLayer),
);
const reexecutionGateLayer = NativeExpertReexecutionGateLive.pipe(
  Layer.provideMerge(ExpertDelegationStoreLive),
  Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
);

// Reuse this layer object at every application boundary. In particular, the
// publication host and the live consent gate must not be independently rebuilt.
export const SuiteRuntimeLayerLive = Layer.mergeAll(
  suiteImportLayer,
  reexecutionGateLayer,
  delegationArtifactsLayer,
);
