import type { SuiteRuntimeContext } from "../experts/SuiteRunMaterialization";
export function renderSuiteRuntimeInstructions(context: SuiteRuntimeContext): string {
  return [
    "# Fixed Suite Run context",
    `Assembly: ${context.assemblyId}`,
    "The language and output-directory values below are the host-fixed effective configuration for this logical Run, including project/team/personal overrides. Do not silently replace these two values with later native defaults or rereads of _bmad/config.toml, _bmad/custom/config.toml, or config.user.toml during methods, continuation, or reconnect. If a native resolver reports different values, retain this fixed view and report the mismatch; do not edit project configuration merely to align it. A null field supplies no configured override or output authorization; never recover a rejected value from its source. Explicit current user instructions remain authoritative, subject to the existing workspace and approval boundaries. Natural-language instructions and other BMAD fields, including active_initiative, retain their existing separate channels.",
    `Fixed language: ${context.effectiveConfig.language ?? "null"}`,
    `Fixed output directory (configuration only, not additional filesystem permission): ${context.effectiveConfig.outputDirectory ?? "null"}`,
    "Configuration provenance, low to high (the fixed values above remain the adopted result):",
    ...context.effectiveConfig.provenance.map(
      (item) => `${item.field}: ${item.layer}:${item.sourceId} = ${item.value}`,
    ),
    ...context.contextFiles.map(
      (file) => `## Instructions from ${file.path} (${file.contentHash})\n${file.content}`,
    ),
    "## Resource catalog",
    ...context.resourceRoots.map((root) => `${root.mode}: ${root.path} (${root.contentHash})`),
    ...context.effectiveConfig.issues.map(
      (issue) => `Unavailable capability ${issue.subject.id}: ${issue.message}`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}
