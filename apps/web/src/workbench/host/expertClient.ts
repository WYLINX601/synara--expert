import type { NativeApi } from "@synara/contracts";

import { ensureNativeApi } from "~/nativeApi";

/** The existing wire API, limited to capabilities owned by Expert, Suite and MCP modules. */
export type ExpertClient = Pick<
  NativeApi["server"],
  | "previewSuite"
  | "cancelSuitePreview"
  | "commitSuiteImport"
  | "getSuiteImportReceipt"
  | "listSuites"
  | "readSuite"
  | "readSuiteRunConfiguration"
  | "listExperts"
  | "readExpert"
  | "saveExpert"
  | "archiveExpert"
  | "restoreExpert"
  | "deleteExpert"
  | "previewExpert"
  | "skillLibrary"
  | "skillEvolution"
  | "readSkillManagementAccess"
  | "createSkillManagementPairing"
  | "listSkillManagementCredentials"
  | "revokeSkillManagementCredential"
  | "listSkillPackages"
  | "listSkillPackageSources"
  | "readSkillPackage"
  | "previewSkillPackage"
  | "previewSkillPackageUpdate"
  | "previewSkillPackageRemoval"
  | "importSkillPackage"
  | "removeSkillPackage"
  | "readExpertSnapshot"
  | "readExpertAppliedRuntime"
  | "listExpertConnections"
  | "saveExpertConnection"
  | "removeExpertConnection"
  | "testExpertConnection"
  | "getExpertConnectionState"
  | "setExpertConnectionState"
  | "readExpertConnectionReferences"
  | "discoverMcpConnections"
  | "importMcpConnections"
>;

// Resolve on each call so reconnects and desktop/browser selection retain native ownership.
// This is a compile-time capability boundary, not runtime sandboxing or a second client.
export function ensureExpertClient(): ExpertClient {
  return ensureNativeApi().server;
}
