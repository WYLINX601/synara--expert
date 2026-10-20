// FILE: composerMentions.ts
// Purpose: Share parsing/formatting helpers for `@...` composer mentions, including quoted paths.
// Layer: Web composer helper
// Exports: mention token formatters plus regex helpers used by composer parsing and prompt sync.

import type { ProviderMentionReference, ProviderSkillReference } from "@synara/contracts";
import {
  isHubReferenceUri,
  parseHubReferenceUri,
  type HubReference,
} from "@synara/shared/hubReferences";
import { isMcpConnectorMentionPath } from "@synara/shared/mcpConnectors";
import { isThreadMentionPath, threadIdFromThreadMentionPath } from "@synara/shared/threadMentions";

export function skillMentionPrefix(provider: string): string {
  return provider === "pi" ? "/skill:" : "/";
}

// The alternation must be unambiguous — a backslash may only match the escape
// branch — or unclosed `@"` + a backslash run backtracks exponentially on the
// per-keystroke composer parse (ReDoS).
const QUOTED_MENTION_PATH_SOURCE = String.raw`((?:\\.|[^"\\])*)`;

export function createComposerMentionTokenRegex(options: {
  includeTrailingTokenAtEnd: boolean;
  global?: boolean;
}): RegExp {
  const suffix = options.includeTrailingTokenAtEnd ? "(?=\\s|$)" : "(?=\\s)";
  return new RegExp(
    `(^|\\s)@(?:"${QUOTED_MENTION_PATH_SOURCE}"|([^\\s@]+))${suffix}`,
    options.global === false ? "" : "g",
  );
}

export function decodeComposerMentionQuotedPath(path: string): string {
  return path.replace(/\\(["\\])/g, "$1");
}

export function extractComposerMentionPath(match: RegExpExecArray | RegExpMatchArray): string {
  return match[2] === undefined ? (match[3] ?? "") : decodeComposerMentionQuotedPath(match[2]);
}

export function composerMentionQuotedPathHasClosingQuote(path: string): boolean {
  let precedingBackslashes = 0;
  for (const character of path) {
    if (character === "\\") {
      precedingBackslashes += 1;
      continue;
    }
    if (character === '"' && precedingBackslashes % 2 === 0) {
      return true;
    }
    precedingBackslashes = 0;
  }
  return false;
}

function encodeComposerMentionQuotedPath(path: string): string {
  return path.replace(/["\\]/g, "\\$&");
}

/**
 * Paths that need quoting so spaces, parentheses, and shell-ish characters
 * stay a single mention token (#351). Prefer quoting over relying on the
 * unquoted `[^()\s@]+` trigger form.
 */
export function composerMentionPathNeedsQuoting(path: string): boolean {
  return /[\s()@"'`$\\]/.test(path);
}

export function formatComposerMentionToken(path: string): string {
  const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
  return composerMentionPathNeedsQuoting(normalizedPath)
    ? `@"${encodeComposerMentionQuotedPath(normalizedPath)}"`
    : `@${normalizedPath}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function promptIncludesSkillMention(
  prompt: string,
  skillName: string,
  provider: string,
): boolean {
  const escapedSkillName = escapeRegExp(skillName);
  const prefixes =
    provider === "pi" ? [skillMentionPrefix(provider)] : [skillMentionPrefix(provider), "$"];
  return prefixes.some((prefix) => {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(prefix)}${escapedSkillName}(?=\\s|$)`, "i");
    return pattern.test(prompt);
  });
}

export function filterPromptSkillReferences(
  prompt: string,
  skills: ReadonlyArray<ProviderSkillReference>,
  provider: string,
): ProviderSkillReference[] {
  return skills.filter((skill) => promptIncludesSkillMention(prompt, skill.name, provider));
}

export function providerSkillReferencesEqual(
  left: ReadonlyArray<ProviderSkillReference>,
  right: ReadonlyArray<ProviderSkillReference>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (skill, index) =>
        skill.name === right[index]?.name &&
        skill.path === right[index]?.path &&
        skill.expert?.snapshotId === right[index]?.expert?.snapshotId &&
        skill.expert?.packageId === right[index]?.expert?.packageId &&
        skill.expert?.entryPath === right[index]?.expert?.entryPath,
    )
  );
}

function normalizeMentionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function collectProviderMentionTokenKeys(mention: ProviderMentionReference): Set<string> {
  const keys = new Set<string>();
  // Workbench references are identities, not aliases. Their canonical URI is
  // the only token that can select a published revision or expert.
  if (isHubReferenceUri(mention.path)) {
    keys.add(mention.path);
    return keys;
  }

  const normalizedName = normalizeMentionNameKey(mention.name);
  if (normalizedName.length > 0) {
    keys.add(normalizedName);
  }

  const normalizedPath = normalizeMentionNameKey(mention.path);
  if (normalizedPath.length > 0) {
    keys.add(normalizedPath);
  }

  if (normalizedPath.startsWith("plugin://")) {
    const pluginSpecifier = normalizedPath.slice("plugin://".length);
    if (pluginSpecifier.length > 0) {
      keys.add(pluginSpecifier);
      const pluginName = pluginSpecifier.split("@")[0] ?? "";
      if (pluginName.length > 0) {
        keys.add(pluginName);
      }
    }
  }

  return keys;
}

export function providerMentionMatchesToken(
  mention: ProviderMentionReference,
  token: string,
): boolean {
  if (isHubReferenceUri(mention.path)) {
    return mention.path === token;
  }
  const normalizedToken = normalizeMentionNameKey(token);
  return (
    normalizedToken.length > 0 && collectProviderMentionTokenKeys(mention).has(normalizedToken)
  );
}

export type MentionChipKind = "path" | "plugin" | "thread" | "connector" | "expert" | "deliverable";

export function findHubReferenceMentionForToken(
  token: string,
  mentions: ReadonlyArray<ProviderMentionReference> | undefined,
): { mention: ProviderMentionReference; reference: HubReference } | undefined {
  const mention = mentions?.find((candidate) => candidate.path === token);
  if (!mention || !isHubReferenceUri(mention.path)) return undefined;
  const reference = parseHubReferenceUri(mention.path);
  return reference ? { mention, reference } : undefined;
}

/** Returns a safe user-facing label for reserved Hub URIs, including stale references. */
export function hubReferenceMentionLabel(
  path: string,
  mentions: ReadonlyArray<ProviderMentionReference> | undefined,
): string | null {
  if (!isHubReferenceUri(path)) return null;
  const mention = mentions?.find((candidate) => candidate.path === path);
  return mention?.name.trim() || "Reference";
}

export function isPluginProviderMentionReference(mention: ProviderMentionReference): boolean {
  return mention.path.startsWith("plugin://");
}

export function isThreadProviderMentionReference(mention: ProviderMentionReference): boolean {
  return isThreadMentionPath(mention.path);
}

export function isConnectorProviderMentionReference(mention: ProviderMentionReference): boolean {
  return isMcpConnectorMentionPath(mention.path);
}

export function findConnectorProviderMentionReferenceForToken(
  token: string,
  mentions: ReadonlyArray<ProviderMentionReference> | undefined,
): ProviderMentionReference | undefined {
  return mentions?.find(
    (mention) =>
      isConnectorProviderMentionReference(mention) && providerMentionMatchesToken(mention, token),
  );
}

export function threadIdFromProviderMentionReference(
  mention: ProviderMentionReference,
): string | null {
  return threadIdFromThreadMentionPath(mention.path);
}

export function findThreadProviderMentionReferenceForToken(
  token: string,
  mentions: ReadonlyArray<ProviderMentionReference> | undefined,
): ProviderMentionReference | undefined {
  return mentions?.find(
    (mention) =>
      isThreadProviderMentionReference(mention) && providerMentionMatchesToken(mention, token),
  );
}

export function resolveMentionChipKind(
  path: string,
  options?: {
    kind?: MentionChipKind;
    mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  },
): MentionChipKind {
  const hubReference = parseHubReferenceUri(path);
  if (hubReference) return hubReference.kind;
  // Keep malformed or stale values in Synara's reserved namespace inert as
  // app references instead of letting them fall through to filesystem logic.
  if (isHubReferenceUri(path)) return "deliverable";
  if (options?.kind === "thread" || isThreadMentionPath(path)) {
    return "thread";
  }
  if (options?.kind === "connector" || isMcpConnectorMentionPath(path)) {
    return "connector";
  }
  if (options?.kind === "plugin" || path.startsWith("plugin://")) {
    return "plugin";
  }
  if (findThreadProviderMentionReferenceForToken(path, options?.mentionReferences)) {
    return "thread";
  }
  if (findConnectorProviderMentionReferenceForToken(path, options?.mentionReferences)) {
    return "connector";
  }
  if (
    options?.mentionReferences?.some(
      (mention) =>
        isPluginProviderMentionReference(mention) && providerMentionMatchesToken(mention, path),
    )
  ) {
    return "plugin";
  }
  return "path";
}

const PROMPT_MENTION_NAME_REGEX = createComposerMentionTokenRegex({
  includeTrailingTokenAtEnd: true,
});

function collectPromptMentionNameKeys(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const match of prompt.matchAll(PROMPT_MENTION_NAME_REGEX)) {
    const mentionName = extractComposerMentionPath(match);
    if (mentionName.length > 0) {
      names.add(normalizeMentionNameKey(mentionName));
    }
  }
  return names;
}

function collectPromptMentionTokens(prompt: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of prompt.matchAll(PROMPT_MENTION_NAME_REGEX)) {
    const token = extractComposerMentionPath(match);
    if (token.length > 0) tokens.add(token);
  }
  return tokens;
}

export function filterPromptProviderMentionReferences(
  prompt: string,
  mentions: ReadonlyArray<ProviderMentionReference>,
): ProviderMentionReference[] {
  const promptMentionNames = collectPromptMentionNameKeys(prompt);
  const promptMentionTokens = collectPromptMentionTokens(prompt);
  if (promptMentionNames.size === 0 && promptMentionTokens.size === 0) {
    return [];
  }

  const seenPaths = new Set<string>();
  const matchedMentions: ProviderMentionReference[] = [];
  for (const mention of mentions) {
    if (isHubReferenceUri(mention.path)) {
      if (!promptMentionTokens.has(mention.path) || seenPaths.has(mention.path)) continue;
      seenPaths.add(mention.path);
      matchedMentions.push(mention);
      continue;
    }

    const mentionKeys = collectProviderMentionTokenKeys(mention);
    if (!Array.from(mentionKeys).some((key) => promptMentionNames.has(key))) {
      continue;
    }
    if (seenPaths.has(mention.path)) {
      continue;
    }
    seenPaths.add(mention.path);
    matchedMentions.push(mention);
  }
  return matchedMentions;
}

export function providerMentionReferencesEqual(
  left: ReadonlyArray<ProviderMentionReference>,
  right: ReadonlyArray<ProviderMentionReference>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (mention, index) =>
        mention.path === right[index]?.path && mention.name === right[index]?.name,
    )
  );
}
