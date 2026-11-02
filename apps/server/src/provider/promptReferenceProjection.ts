// FILE: promptReferenceProjection.ts
// Purpose: Projects structured composer references for providers without native mention input items.
// Layer: Provider prompt compatibility
// Exports: appendProviderReferencesPromptBlock.

import type { ProviderMentionReference, ProviderSkillReference } from "@synara/contracts";

function referenceLine(reference: ProviderMentionReference): string {
  const kind = reference.path.startsWith("plugin://") ? "Factory plugin" : "local path";
  return `- ${kind}: ${JSON.stringify({ name: reference.name, path: reference.path })}`;
}

/** Keeps selected plugin/path chips meaningful when ACP accepts text and images only. */
export function appendProviderReferencesPromptBlock(input: {
  readonly text: string | undefined;
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
}): string | undefined {
  if (!input.mentions || input.mentions.length === 0) {
    return input.text;
  }
  const block = [
    "<selected_provider_references>",
    "The user explicitly selected these references. Droid manages enabled Factory plugin components natively; prefer the selected plugin's skills, commands, agents, or tools when they are available and relevant. Read local paths with your filesystem tools as needed.",
    ...input.mentions.map(referenceLine),
    "</selected_provider_references>",
  ].join("\n");
  return input.text ? `${input.text}\n\n${block}` : block;
}

/** Preserve explicit Skill chips for text-only prompts without injecting their contents. */
export function appendProviderSkillReferencesPromptBlock(input: {
  readonly text: string | undefined;
  readonly skills: ReadonlyArray<ProviderSkillReference> | undefined;
}): string | undefined {
  if (!input.skills || input.skills.length === 0) return input.text;
  const block = [
    "<selected_skill_references>",
    "The user explicitly selected these Skills. Use the matching Skills from the active native catalog when relevant. Their files and relative resources remain at the listed paths.",
    ...input.skills.map(({ name, path }) => `- ${JSON.stringify({ name, path })}`),
    "</selected_skill_references>",
  ].join("\n");
  return input.text ? `${input.text}\n\n${block}` : block;
}
