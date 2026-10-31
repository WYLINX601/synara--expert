import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  type ExpertDefinition,
  type ExpertSkillBinding,
  type SkillDefinition,
  type SkillFileChange,
  type SkillLibraryRequest,
  type SkillPackage,
} from "@synara/contracts";
import YAML from "yaml";
import { expertResourceFiles, type ExpertStore } from "../ExpertStore";
import type { createSkillLibraryStore } from "../SkillLibraryStore";
import type { SkillPackageStore } from "../SkillPackageStore";
import { assertSkillScopeForExpert, effectiveSkillScope } from "../skillEvolutionPolicy";
import { withExpertLearningCommit } from "../expertLearningCommit";

type Library = ReturnType<typeof createSkillLibraryStore>;
type LibraryContext = NonNullable<Parameters<Library["execute"]>[1]>;

type PreparedSkillLibraryMutationRequest = Extract<
  SkillLibraryRequest,
  { readonly action: "create" | "derive" | "save" }
>;

type PreparedSkillRevertMutationRequest =
  | Extract<SkillLibraryRequest, { readonly action: "save" }>
  | (Extract<SkillLibraryRequest, { readonly action: "bindings" }> & {
      readonly operation: "set";
      readonly bindings: readonly ExpertSkillBinding[];
    });

type PreparedSkillChangeIntentBase = {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly expertId: string;
  readonly fingerprint: string;
  readonly mode: PreparedSkillChangeRecord["mode"];
  readonly before: PreparedSkillChangeSnapshot;
  readonly touchedPaths: readonly string[];
};

export type PreparedSkillCommitIntent = PreparedSkillChangeIntentBase & {
  readonly kind: "commit";
  readonly request: PreparedSkillChangeInput;
  /** Exact first Library mutation, including its stable request ID and revision guard. */
  readonly mutation: {
    readonly request: PreparedSkillLibraryMutationRequest;
    readonly createForExpertId?: string;
  };
};

export type PreparedSkillRevertMutation = {
  readonly request: PreparedSkillRevertMutationRequest;
  /** Skill identity expected immediately before a following bindings mutation. */
  readonly expectedSkill?: Pick<SkillDefinition, "skillId" | "packageId" | "revision">;
  /** Require the live Skill to match the preceding exact save request's result. */
  readonly mustMatchPreviousSkillMutation?: boolean;
};

export type PreparedSkillRevertIntent = PreparedSkillChangeIntentBase & {
  readonly kind: "revert";
  readonly recordOperationId: string;
  readonly recordFingerprint: string;
  /** Exact live state observed when this inverse was first planned, before any inverse write. */
  readonly currentBefore: PreparedSkillChangeSnapshot;
  /** Exact ordered mutations so a retry recovers every saved stage by request ID. */
  readonly mutations: readonly PreparedSkillRevertMutation[];
};

export type PreparedSkillChangeIntent = PreparedSkillCommitIntent | PreparedSkillRevertIntent;

export type PreparedSkillChangesContext = LibraryContext & {
  readonly actor: string;
  readonly retainForEvolution?: boolean;
  readonly beforeMutation: NonNullable<
    NonNullable<Parameters<Library["execute"]>[1]>["beforeMutation"]
  >;
  /** Persist the full opaque operation intent before the first formal mutation. */
  readonly onPrepared?: (intent: PreparedSkillChangeIntent) => Promise<void>;
};

type MutationContext = PreparedSkillChangesContext;

export type PreparedSkillChangeInput = {
  readonly operationId: string;
  readonly expertId: string;
  readonly expectedExpertRevision: number;
  readonly targetSkillId?: string;
  readonly expectedSkillRevision?: number;
  readonly basePackageId?: string;
  readonly name?: string;
  readonly description?: string;
  readonly changes: readonly SkillFileChange[];
  /** The source references are fixed and authenticated by the host before this call. */
  readonly evidenceRefs?: readonly unknown[];
};

export type PreparedSkillChangeSnapshot = {
  readonly skill?: SkillDefinition;
  readonly packageId?: string;
  readonly bindings: readonly ExpertSkillBinding[];
  readonly expertRevision: number;
};

export type PreparedSkillChangeRecord = {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly fingerprint: string;
  readonly expertId: string;
  readonly targetSkillId?: string;
  readonly mode: "create" | "derive" | "update";
  readonly status: "saved_unbound" | "committed";
  readonly touchedPaths: readonly string[];
  readonly before: PreparedSkillChangeSnapshot;
  readonly after: PreparedSkillChangeSnapshot & {
    readonly skill: SkillDefinition;
    readonly packageId: string;
  };
  readonly changes: readonly SkillFileChange[];
  readonly evidenceRefs: readonly unknown[];
};

export type PreparedSkillChangeConflict = {
  readonly status: "conflict";
  readonly operationId: string;
  readonly conflicts: readonly { readonly path?: string; readonly reason: string }[];
};

export type PreparedSkillRevertResult =
  | {
      readonly status: "committed" | "saved_unbound";
      readonly operationId: string;
      readonly record: PreparedSkillChangeRecord;
      readonly skill?: SkillDefinition;
      readonly packageId?: string;
      readonly bindings: readonly ExpertSkillBinding[];
      readonly expertRevision: number;
    }
  | PreparedSkillChangeConflict;

type PackageFiles = {
  readonly files: ReadonlyMap<string, { readonly bytes: Buffer; readonly executable: boolean }>;
};

const sortStable = (item: unknown): unknown =>
  Array.isArray(item)
    ? item.map(sortStable)
    : item !== null && typeof item === "object"
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sortStable(child)]),
        )
      : item;
const stable = (value: unknown): string => JSON.stringify(sortStable(value));
const fingerprint = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const requestId = (kind: string, operationId: string) =>
  `learning-skill:${kind}:${createHash("sha256").update(operationId).digest("hex")}`;
const copyBindings = (bindings: readonly ExpertSkillBinding[]) =>
  bindings.map((binding) => ({ ...binding }));
const clone = <T>(value: T): T => structuredClone(value);
function libraryContext(context: MutationContext): LibraryContext {
  const result = { ...context };
  delete result.onPrepared;
  return result;
}

async function assertLiveEditableBinding(
  library: Library,
  experts: Pick<ExpertStore, "read">,
  context: MutationContext,
  expertId: string,
  skillId: string,
): Promise<void> {
  const expert = await experts.read(expertId);
  if (!expert || expert.archived) throw new Error("Expert is missing or archived.");
  const skill = (await library.execute({ action: "read", skillId }, libraryContext(context))).skill;
  if (!skill) throw new Error("Target Skill is no longer available.");
  assertSkillScopeForExpert(skill, expert.id);
  const binding = expert.skillBindings?.find((item) => item.skillId === skill.skillId);
  if (!binding) throw new Error("Target Skill is no longer bound to this Expert.");
  if (binding.allowEvolution !== true)
    throw new Error("Skill learning is read-only for this Expert binding.");
}

function libraryMutationContext(
  library: Library,
  experts: Pick<ExpertStore, "read">,
  context: MutationContext,
  expertId: string,
  targetSkillId?: string,
): LibraryContext {
  let beforeMutationCalls = 0;
  return {
    ...libraryContext(context),
    retainForEvolution: true,
    beforeMutation: async (effect) => {
      await context.beforeMutation(effect);
      beforeMutationCalls += 1;
      // SkillLibrary invokes this once before checking its idempotency receipt, then
      // again only when it is about to perform a new formal write. That second hook
      // closes the permission race without blocking read-only receipt recovery.
      if (beforeMutationCalls >= 2 && targetSkillId)
        await assertLiveEditableBinding(library, experts, context, expertId, targetSkillId);
    },
  };
}
const conflict = (
  operationId: string,
  reason: string,
  filePath?: string,
): PreparedSkillChangeConflict => ({
  status: "conflict",
  operationId,
  conflicts: [{ ...(filePath ? { path: filePath } : {}), reason }],
});

function assertBoundAndEditable(expert: ExpertDefinition, skill: SkillDefinition) {
  assertSkillScopeForExpert(skill, expert.id);
  const binding = expert.skillBindings?.find((item) => item.skillId === skill.skillId);
  if (!binding) throw new Error("Target Skill is not bound to this Expert.");
  if (binding.allowEvolution !== true)
    throw new Error("Skill learning is read-only for this Expert binding.");
  return binding;
}

function assertInputBounded(input: PreparedSkillChangeInput) {
  if (!input.operationId.trim() || input.operationId.length > 180)
    throw new Error("Skill learning operationId must be 1 to 180 characters.");
  if (!input.expertId.trim() || input.expertId.length > 200)
    throw new Error("Invalid Skill learning Expert ID.");
  if (!Number.isSafeInteger(input.expectedExpertRevision) || input.expectedExpertRevision < 1)
    throw new Error("Skill learning requires an expected Expert revision.");
  if (input.changes.length > 100)
    throw new Error("A Skill learning commit may change at most 100 files.");
  if (input.name !== undefined && (!input.name.trim() || input.name.length > 200))
    throw new Error("Skill learning name must be 1 to 200 characters.");
  if (input.description !== undefined && input.description.length > 16_000)
    throw new Error("Skill learning description is too long.");
  let totalBytes = 0;
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (!change.path || change.path.length > 4_096)
      throw new Error("Skill learning contains an invalid resource path.");
    const key = change.path.normalize("NFC").toLowerCase();
    if (seen.has(key)) throw new Error("Skill learning contains duplicate resource paths.");
    seen.add(key);
    if (change.content !== undefined) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(change.content))
        throw new Error(`Invalid base64 in Skill resource ${change.path}.`);
      totalBytes += Buffer.byteLength(change.content, "utf8");
    }
  }
  if (totalBytes > 1_000_000)
    throw new Error("A Skill learning commit may contain at most 1 MB of encoded file content.");
  if ((input.evidenceRefs?.length ?? 0) > 20)
    throw new Error("A Skill learning commit may cite at most 20 evidence references.");
}

function setFrontmatterField(body: string, field: "description" | "name", value: string): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)(\r?\n|$)/u.exec(body);
  if (!match) throw new Error(`A Skill ${field} requires YAML frontmatter in SKILL.md.`);
  const document = YAML.parseDocument(match[2]!);
  if (document.errors.length) throw new Error("SKILL.md has invalid YAML frontmatter.");
  document.set(field, value);
  return `${match[1]}${document.toString().trimEnd()}${match[3]}${match[4]}${body.slice(match[0].length)}`;
}

function setFrontmatterDescription(body: string, description: string): string {
  return setFrontmatterField(body, "description", description);
}

function setFrontmatterName(body: string, name: string): string {
  return setFrontmatterField(body, "name", name);
}

function filesInPackageManifest(pkg: SkillPackage) {
  return pkg.resources.filter((resource) => resource.kind === "file");
}

async function readPackageFiles(
  stateDir: string,
  packages: Pick<SkillPackageStore, "read">,
  readResource: typeof expertResourceFiles.read,
  packageId: string,
  selectedPaths: ReadonlySet<string>,
): Promise<PackageFiles> {
  const pkg = await packages.read(packageId);
  const files = new Map<string, { bytes: Buffer; executable: boolean }>();
  for (const resource of filesInPackageManifest(pkg)) {
    const relative = resource.path.startsWith("content/")
      ? resource.path.slice("content/".length)
      : resource.path;
    if (!relative || !selectedPaths.has(relative)) continue;
    const bytes = await readResource(
      path.join(
        stateDir,
        "experts",
        "skill-packages",
        packageId,
        "content",
        ...relative.split("/"),
      ),
    );
    files.set(relative, { bytes, executable: resource.executable ?? false });
  }
  return { files };
}

function decodeText(bytes: Buffer): string | undefined {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) && !text.includes("\0") ? text : undefined;
}

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
}

type LineHunk = {
  readonly before: readonly string[];
  readonly after: readonly string[];
};
function lineHunks(before: readonly string[], after: readonly string[]): LineHunk[] | undefined {
  if (before.length * after.length > 1_000_000) return undefined;
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);

  const hunks: LineHunk[] = [];
  let i = 0;
  let j = 0;
  let oldRun: string[] = [];
  let newRun: string[] = [];
  const flush = () => {
    if (oldRun.length || newRun.length) hunks.push({ before: oldRun, after: newRun });
    oldRun = [];
    newRun = [];
  };
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      flush();
      i++;
      j++;
    } else if (j >= after.length || (i < before.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      oldRun.push(before[i++]!);
    } else {
      newRun.push(after[j++]!);
    }
  }
  flush();
  return hunks;
}

function allSequenceOffsets(haystack: readonly string[], needle: readonly string[]): number[] {
  if (!needle.length || haystack.length * needle.length > 1_000_000) return [];
  const offsets: number[] = [];
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    if (needle.every((line, offset) => haystack[i + offset] === line)) offsets.push(i);
  }
  return offsets;
}

function codePointBefore(value: string, offset: number): string | undefined {
  if (offset <= 0) return undefined;
  const last = value.charCodeAt(offset - 1);
  if (last >= 0xdc00 && last <= 0xdfff && offset > 1) return value.slice(offset - 2, offset);
  return value.slice(offset - 1, offset);
}

function codePointAt(value: string, offset: number): string | undefined {
  const point = value.codePointAt(offset);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{M}\p{N}_]/u.test(value);
}

function restoreSingleLineChange(
  before: string,
  after: string,
  current: string,
): string | undefined {
  if (before === after) return current;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const oldPart = before.slice(prefix, before.length - suffix);
  const newPart = after.slice(prefix, after.length - suffix);
  if (prefix === 0 && suffix === 0) return undefined;
  const candidates: number[] = [];
  for (let offset = 0; offset <= current.length - newPart.length; offset++) {
    if (current.slice(offset, offset + newPart.length) !== newPart) continue;
    const previousCharacter = codePointBefore(current, offset);
    const nextCharacter = codePointAt(current, offset + newPart.length);
    if (
      (isWordCharacter(codePointAt(newPart, 0)) && isWordCharacter(previousCharacter)) ||
      (isWordCharacter(codePointBefore(newPart, newPart.length)) && isWordCharacter(nextCharacter))
    )
      continue;
    const leftContext = after.slice(Math.max(0, prefix - 32), prefix);
    const rightContext = after.slice(
      after.length - suffix,
      Math.min(after.length, after.length - suffix + 32),
    );
    const leftMatches =
      leftContext.length >= 4 &&
      current.slice(Math.max(0, offset - leftContext.length), offset) === leftContext;
    const rightMatches =
      rightContext.length >= 4 &&
      current.slice(offset + newPart.length, offset + newPart.length + rightContext.length) ===
        rightContext;
    if (leftMatches || rightMatches) candidates.push(offset);
  }
  if (candidates.length !== 1) return undefined;
  const offset = candidates[0]!;
  return current.slice(0, offset) + oldPart + current.slice(offset + newPart.length);
}

function inverseText(beforeText: string, afterText: string, currentText: string) {
  if (currentText === afterText) return { text: beforeText } as const;
  if (currentText === beforeText) return { text: currentText } as const;
  const before = splitLines(beforeText);
  const after = splitLines(afterText);
  const current = splitLines(currentText);
  if (beforeText.length + afterText.length + currentText.length > 1_000_000)
    return { conflict: "Text resource is too large to merge with later edits safely." } as const;
  const hunks = lineHunks(before, after);
  if (!hunks) return { conflict: "Text change is too large to locate safely." } as const;
  let result = [...current];
  for (const hunk of hunks) {
    if (hunk.before.length === 1 && hunk.after.length === 1) {
      const matching = allSequenceOffsets(result, hunk.after);
      if (matching.length === 1) {
        result.splice(matching[0]!, 1, ...hunk.before);
        continue;
      }
      if (matching.length > 1)
        return { conflict: "Changed text is repeated in the current package." } as const;
      if (matching.length === 0 && allSequenceOffsets(result, hunk.before).length === 1) continue;
      let candidate = -1;
      let restoredText: string | undefined;
      if (candidate < 0) {
        const anchored = result.flatMap((line, index) => {
          const restored = restoreSingleLineChange(hunk.before[0]!, hunk.after[0]!, line);
          return restored === undefined ? [] : [{ index, restored }];
        });
        if (anchored.length === 1) {
          candidate = anchored[0]!.index;
          restoredText = anchored[0]!.restored;
        }
      }
      const currentLine = candidate < 0 ? undefined : result[candidate];
      const restored =
        restoredText ??
        (currentLine
          ? restoreSingleLineChange(hunk.before[0]!, hunk.after[0]!, currentLine)
          : undefined);
      if (restored !== undefined) {
        result[candidate] = restored;
        continue;
      }
      return { conflict: "Changed text is missing, repeated, or overlaps a later edit." } as const;
    }

    if (hunk.after.length) {
      const matching = allSequenceOffsets(result, hunk.after);
      if (matching.length === 1) {
        result.splice(matching[0]!, hunk.after.length, ...hunk.before);
        continue;
      }
      if (
        matching.length === 0 &&
        hunk.before.length &&
        allSequenceOffsets(result, hunk.before).length === 1
      )
        continue;
      return { conflict: "Changed text is missing, repeated, or overlaps a later edit." } as const;
    }

    const oldOffsets = allSequenceOffsets(before, hunk.before);
    if (oldOffsets.length !== 1)
      return { conflict: "Deleted text is repeated in its source package." } as const;
    const oldAt = oldOffsets[0]!;
    const previous = before[oldAt - 1];
    const next = before[oldAt + hunk.before.length];
    const slots: number[] = [];
    for (let index = 0; index <= result.length; index++) {
      if (
        (previous === undefined ? index === 0 : result[index - 1] === previous) &&
        (next === undefined ? index === result.length : result[index] === next)
      )
        slots.push(index);
    }
    if (slots.length !== 1)
      return { conflict: "Deleted text cannot be restored at a unique position." } as const;
    result.splice(slots[0]!, 0, ...hunk.before);
  }
  return { text: result.join("") } as const;
}

function inverseChanges(
  before: PackageFiles,
  after: PackageFiles,
  current: PackageFiles,
  paths: readonly string[],
) {
  const changes: SkillFileChange[] = [];
  const conflicts: { path: string; reason: string }[] = [];
  for (const filePath of paths) {
    const oldFile = before.files.get(filePath);
    const afterFile = after.files.get(filePath);
    const currentFile = current.files.get(filePath);
    if (!oldFile && !afterFile) continue;
    if (!oldFile) {
      if (!afterFile) continue;
      if (!currentFile) continue;
      if (
        currentFile.bytes.equals(afterFile.bytes) &&
        currentFile.executable === afterFile.executable
      ) {
        changes.push({ path: filePath });
      } else {
        conflicts.push({
          path: filePath,
          reason: "A file created by this change has a later modification.",
        });
      }
      continue;
    }
    if (!afterFile) {
      if (!currentFile) {
        changes.push({
          path: filePath,
          content: oldFile.bytes.toString("base64"),
          executable: oldFile.executable,
        });
      } else if (
        !currentFile.bytes.equals(oldFile.bytes) ||
        currentFile.executable !== oldFile.executable
      ) {
        conflicts.push({
          path: filePath,
          reason: "A later file overlaps the resource deleted by this change.",
        });
      }
      continue;
    }
    if (!currentFile) {
      conflicts.push({
        path: filePath,
        reason: "A changed resource is missing from the current package.",
      });
      continue;
    }
    let nextBytes: Buffer | undefined;
    if (!oldFile.bytes.equals(afterFile.bytes)) {
      const beforeText = decodeText(oldFile.bytes);
      const afterText = decodeText(afterFile.bytes);
      const currentText = decodeText(currentFile.bytes);
      if (beforeText === undefined || afterText === undefined || currentText === undefined) {
        if (currentFile.bytes.equals(afterFile.bytes)) nextBytes = oldFile.bytes;
        else if (!currentFile.bytes.equals(oldFile.bytes)) {
          conflicts.push({
            path: filePath,
            reason: "A later binary change overlaps this resource.",
          });
          continue;
        }
      } else {
        const merged = inverseText(beforeText, afterText, currentText);
        if ("conflict" in merged) {
          conflicts.push({ path: filePath, reason: merged.conflict });
          continue;
        }
        nextBytes = Buffer.from(merged.text, "utf8");
      }
    }
    let executable = currentFile.executable;
    if (oldFile.executable !== afterFile.executable) {
      if (currentFile.executable === afterFile.executable) executable = oldFile.executable;
      else if (currentFile.executable !== oldFile.executable) {
        conflicts.push({ path: filePath, reason: "Executable mode overlaps a later change." });
        continue;
      }
    }
    if (
      (nextBytes && !nextBytes.equals(currentFile.bytes)) ||
      executable !== currentFile.executable
    ) {
      changes.push({
        path: filePath,
        content: (nextBytes ?? currentFile.bytes).toString("base64"),
        executable,
      });
    }
  }
  return { changes, conflicts };
}

function touchedPathsFor(
  mode: PreparedSkillChangeRecord["mode"],
  target: SkillDefinition | undefined,
  request: PreparedSkillChangeInput,
): string[] {
  const paths = new Set(request.changes.map((change) => change.path));
  if (
    target &&
    (mode === "derive" ||
      (mode === "update" &&
        ((request.name !== undefined && request.name !== target.name) ||
          request.description !== undefined)))
  )
    paths.add(target.entryPath);
  return [...paths];
}

const normalizeSkillName = (name: string) => name.normalize("NFC").toLowerCase();

function truncateUtf16AtCodePoint(value: string, maxCodeUnits: number): string {
  let result = "";
  for (const codePoint of value) {
    if (result.length + codePoint.length > maxCodeUnits) break;
    result += codePoint;
  }
  return result;
}

function derivedSkillName(targetName: string, expertName: string, collisionNumber: number): string {
  const numberSuffix = collisionNumber === 1 ? "" : ` (${collisionNumber})`;
  const completeSuffix = ` (${expertName})${numberSuffix}`;
  if (targetName.length + completeSuffix.length <= 200) return `${targetName}${completeSuffix}`;

  const targetPart = truncateUtf16AtCodePoint(targetName, 200 - completeSuffix.length);
  if (targetPart) return `${targetPart}${completeSuffix}`;

  // Preserve a readable target prefix and the suffix/sequence even when both
  // metadata names are individually near the Library's UTF-16 limit.
  const targetPrefix = truncateUtf16AtCodePoint(targetName, 2) || "S";
  const expertBudget = Math.max(1, 200 - targetPrefix.length - 3 - numberSuffix.length);
  const expertPart = truncateUtf16AtCodePoint(expertName, expertBudget);
  return `${targetPrefix} (${expertPart})${numberSuffix}`;
}

async function chooseDerivedSkillName(
  library: Library,
  context: MutationContext,
  request: PreparedSkillChangeInput,
  expert: ExpertDefinition,
  target: SkillDefinition,
): Promise<string> {
  // Match SkillLibraryStore's active-name uniqueness rule exactly.
  const listed = await library.execute({ action: "list" }, libraryContext(context));
  const activeNames = new Set(
    (listed.skills ?? [])
      .filter((skill) => !skill.deleted)
      .map((skill) => normalizeSkillName(skill.name)),
  );
  const requestedName = request.name ?? target.name;
  if (
    normalizeSkillName(requestedName) !== normalizeSkillName(target.name) &&
    !activeNames.has(normalizeSkillName(requestedName))
  )
    return requestedName;

  for (let collisionNumber = 1; collisionNumber <= activeNames.size + 2; collisionNumber += 1) {
    const candidate = derivedSkillName(target.name, expert.name, collisionNumber);
    if (!activeNames.has(normalizeSkillName(candidate))) return candidate;
  }
  throw new Error("Could not choose a unique derived Skill name.");
}

function makeCommitLibraryMutation(
  mode: PreparedSkillChangeRecord["mode"],
  request: PreparedSkillChangeInput,
  expert: ExpertDefinition,
  target: SkillDefinition | undefined,
  derivedName?: string,
): PreparedSkillCommitIntent["mutation"] {
  if (mode === "derive" && target) {
    return {
      request: {
        action: "derive",
        requestId: requestId("commit", request.operationId),
        sourceSkillId: target.skillId,
        expectedRevision: target.revision,
        expertId: expert.id,
        name: derivedName ?? request.name ?? `${target.name} (${expert.name})`,
        changes: clone([...request.changes]),
      },
    };
  }
  if (mode === "update" && target) {
    return {
      request: {
        action: "save",
        requestId: requestId("commit", request.operationId),
        skillId: target.skillId,
        expectedRevision: target.revision,
        name: request.name ?? target.name,
        ...(request.description !== undefined ? { description: request.description } : {}),
        tags: clone(target.tags),
        changes: clone([...request.changes]),
      },
    };
  }
  if (!request.name) throw new Error("Creating a Skill requires a name.");
  const entry = request.changes.find((change) => change.path === "SKILL.md");
  if (entry?.content === undefined) throw new Error("Creating a Skill requires SKILL.md.");
  const bodyBytes = Buffer.from(entry.content, "base64");
  if (bodyBytes.toString("base64") !== entry.content)
    throw new Error("SKILL.md must contain valid UTF-8 text.");
  let body = bodyBytes.toString("utf8");
  if (!Buffer.from(body, "utf8").equals(bodyBytes) || body.includes("\0"))
    throw new Error("SKILL.md must contain valid UTF-8 text.");
  if (request.description !== undefined)
    body = setFrontmatterDescription(body, request.description);
  return {
    request: {
      action: "create",
      requestId: requestId("commit", request.operationId),
      name: request.name,
      body,
      tags: [],
      changes: clone(request.changes.filter((change) => change.path !== "SKILL.md")),
    },
    createForExpertId: expert.id,
  };
}

function bindingsAfterCommit(
  before: readonly ExpertSkillBinding[],
  mode: PreparedSkillChangeRecord["mode"],
  targetSkillId: string | undefined,
  afterSkill: SkillDefinition,
): ExpertSkillBinding[] {
  if (mode === "create")
    return [
      ...copyBindings(before),
      { skillId: afterSkill.skillId, enabled: true, allowEvolution: true },
    ];
  if (mode === "derive" && targetSkillId)
    return copyBindings(before).map((binding) =>
      binding.skillId === targetSkillId ? { ...binding, skillId: afterSkill.skillId } : binding,
    );
  return copyBindings(before);
}

function makePreparedCommitIntent(input: {
  readonly request: PreparedSkillChangeInput;
  readonly fingerprint: string;
  readonly mode: PreparedSkillChangeRecord["mode"];
  readonly before: PreparedSkillChangeSnapshot;
  readonly touchedPaths: readonly string[];
  readonly expert: ExpertDefinition;
  readonly target?: SkillDefinition;
  readonly derivedName?: string;
}): PreparedSkillCommitIntent {
  return clone({
    schemaVersion: 1,
    kind: "commit",
    operationId: input.request.operationId,
    expertId: input.request.expertId,
    fingerprint: input.fingerprint,
    mode: input.mode,
    before: input.before,
    touchedPaths: [...input.touchedPaths],
    request: input.request,
    mutation: makeCommitLibraryMutation(
      input.mode,
      input.request,
      input.expert,
      input.target,
      input.derivedName,
    ),
  });
}

function preparedRevertFingerprint(operationId: string, record: PreparedSkillChangeRecord): string {
  return fingerprint({
    operationId,
    recordOperationId: record.operationId,
    recordFingerprint: record.fingerprint,
  });
}

function makePreparedRevertIntent(input: {
  readonly operationId: string;
  readonly record: PreparedSkillChangeRecord;
  readonly currentBefore: PreparedSkillChangeSnapshot;
  readonly mutations: readonly PreparedSkillRevertMutation[];
}): PreparedSkillRevertIntent {
  return clone({
    schemaVersion: 1,
    kind: "revert",
    operationId: input.operationId,
    expertId: input.record.expertId,
    fingerprint: preparedRevertFingerprint(input.operationId, input.record),
    mode: input.record.mode,
    before: input.record.before,
    currentBefore: input.currentBefore,
    touchedPaths: [...input.record.touchedPaths],
    recordOperationId: input.record.operationId,
    recordFingerprint: input.record.fingerprint,
    mutations: [...input.mutations],
  });
}

export function createPreparedSkillChanges(input: {
  readonly stateDir: string;
  readonly experts: Pick<ExpertStore, "read">;
  readonly library: Library;
  readonly packages: Pick<SkillPackageStore, "read">;
  readonly readResource?: typeof expertResourceFiles.read;
}) {
  const readResource = input.readResource ?? ((filePath) => expertResourceFiles.read(filePath));

  const commit = async (
    request: PreparedSkillChangeInput,
    context: MutationContext,
    resumeRecord?: PreparedSkillChangeRecord,
    resumeIntent?: PreparedSkillChangeIntent,
  ): Promise<PreparedSkillChangeRecord> => {
    assertInputBounded(request);
    const inputFingerprint = fingerprint({
      expertId: request.expertId,
      expectedExpertRevision: request.expectedExpertRevision,
      targetSkillId: request.targetSkillId,
      expectedSkillRevision: request.expectedSkillRevision,
      basePackageId: request.basePackageId,
      name: request.name,
      description: request.description,
      changes: request.changes,
      evidenceRefs: request.evidenceRefs ?? [],
    });
    if (
      resumeRecord &&
      (resumeRecord.operationId !== request.operationId ||
        resumeRecord.expertId !== request.expertId ||
        resumeRecord.fingerprint !== inputFingerprint)
    )
      throw new Error("Prepared Skill operation ID was reused with different commit input.");
    if (
      resumeIntent &&
      (resumeIntent.kind !== "commit" ||
        resumeIntent.operationId !== request.operationId ||
        resumeIntent.expertId !== request.expertId ||
        resumeIntent.fingerprint !== inputFingerprint ||
        stable(resumeIntent.request) !== stable(request) ||
        resumeIntent.mutation.request.requestId !== requestId("commit", request.operationId))
    )
      throw new Error("Prepared Skill operation ID was reused with a different saved intent.");
    if (
      resumeRecord &&
      resumeIntent &&
      (resumeRecord.mode !== resumeIntent.mode ||
        stable(resumeRecord.before) !== stable(resumeIntent.before) ||
        stable(resumeRecord.touchedPaths) !== stable(resumeIntent.touchedPaths))
    )
      throw new Error("Prepared Skill record does not match its saved mutation intent.");

    return withExpertLearningCommit(
      input.stateDir,
      async () => {
        let expert = await input.experts.read(request.expertId);
        if (!expert || expert.archived) throw new Error("Expert is missing or archived.");
        const initialBindings = expert.skillBindings ?? [];
        if (resumeRecord?.status === "committed") return resumeRecord;
        const initialTarget = request.targetSkillId
          ? await input.library
              .execute({ action: "read", skillId: request.targetSkillId }, libraryContext(context))
              .then((result) => result.skill)
          : undefined;
        if (initialTarget) {
          assertSkillScopeForExpert(initialTarget, expert.id);
          const targetBinding = expert.skillBindings?.find(
            (binding) => binding.skillId === initialTarget.skillId,
          );
          if (!resumeIntent && !resumeRecord) assertBoundAndEditable(expert, initialTarget);
          else if (targetBinding && targetBinding.allowEvolution !== true)
            throw new Error("Skill learning is read-only for this Expert binding.");
        }

        if (!resumeRecord && !resumeIntent && expert.revision !== request.expectedExpertRevision)
          throw new Error("Expert revision changed before the Skill learning commit.");
        if (initialTarget && !resumeRecord && !resumeIntent) {
          if (initialTarget.revision !== request.expectedSkillRevision)
            throw new Error("Target Skill revision changed before the Skill learning commit.");
          if (initialTarget.packageId !== request.basePackageId)
            throw new Error("Target Skill package changed before the Skill learning commit.");
        } else if (request.targetSkillId && !initialTarget) {
          throw new Error("Target Skill could not be read.");
        }

        const mode =
          resumeRecord?.mode ??
          resumeIntent?.mode ??
          (!initialTarget
            ? "create"
            : effectiveSkillScope(initialTarget).kind === "shared"
              ? "derive"
              : "update");
        const before = resumeRecord?.before ??
          resumeIntent?.before ?? {
            ...(initialTarget ? { skill: initialTarget, packageId: initialTarget.packageId } : {}),
            bindings: copyBindings(initialBindings),
            expertRevision: expert.revision,
          };
        let afterSkill = resumeRecord?.after.skill;

        if (!afterSkill) {
          const derivedName =
            !resumeRecord && !resumeIntent && mode === "derive" && initialTarget
              ? await chooseDerivedSkillName(input.library, context, request, expert, initialTarget)
              : undefined;
          const preparedIntent =
            resumeIntent ??
            makePreparedCommitIntent({
              request,
              fingerprint: inputFingerprint,
              mode,
              before,
              touchedPaths: touchedPathsFor(mode, initialTarget, request),
              expert,
              ...(initialTarget ? { target: initialTarget } : {}),
              ...(derivedName ? { derivedName } : {}),
            });
          if (!resumeIntent) await context.onPrepared?.(preparedIntent);
          const mutationRequest = preparedIntent.mutation.request;
          const permissionSkillId =
            mutationRequest.action === "derive"
              ? mutationRequest.sourceSkillId
              : mutationRequest.action === "save"
                ? mutationRequest.skillId
                : undefined;
          const response = await input.library.execute(mutationRequest, {
            ...libraryMutationContext(
              input.library,
              input.experts,
              context,
              expert.id,
              permissionSkillId,
            ),
            ...(preparedIntent.mutation.createForExpertId
              ? { createForExpertId: preparedIntent.mutation.createForExpertId }
              : {}),
          });
          afterSkill = response.skill;
        }
        if (!afterSkill) throw new Error("Skill Library did not return a committed Skill.");
        assertSkillScopeForExpert(afterSkill, expert.id);

        const touchedPaths =
          resumeRecord?.touchedPaths ??
          resumeIntent?.touchedPaths ??
          touchedPathsFor(mode, initialTarget, request);
        const exactAfterBindings = bindingsAfterCommit(
          before.bindings,
          mode,
          request.targetSkillId,
          afterSkill,
        );
        const bindingRequest =
          mode === "update"
            ? undefined
            : {
                action: "bindings" as const,
                operation: "set" as const,
                expertId: expert.id,
                expectedRevision: before.expertRevision,
                requestId: requestId("bind", request.operationId),
                bindings: exactAfterBindings,
              };
        let bindingResult: Awaited<ReturnType<Library["execute"]>>["bindingResult"];
        let beforeMutationRejected = false;
        if (bindingRequest) {
          try {
            const checkedContext: MutationContext = {
              ...context,
              beforeMutation: async (effect) => {
                try {
                  await context.beforeMutation(effect);
                } catch (error) {
                  beforeMutationRejected = true;
                  throw error;
                }
              },
            };
            const response = await input.library.execute(bindingRequest, {
              ...libraryMutationContext(
                input.library,
                input.experts,
                checkedContext,
                expert.id,
                mode === "derive" ? request.targetSkillId : undefined,
              ),
            });
            bindingResult = response.bindingResult;
          } catch (error) {
            if (beforeMutationRejected) throw error;
          }
        }
        const finalExpert = (await input.experts.read(expert.id))!;
        const liveBindings = copyBindings(finalExpert.skillBindings ?? []);
        const bindingCommitted =
          mode === "update" ||
          bindingResult?.status === "applied" ||
          bindingResult?.status === "unchanged" ||
          (bindingResult === undefined &&
            finalExpert.revision === before.expertRevision + 1 &&
            stable(liveBindings) === stable(exactAfterBindings));
        const afterBindings = bindingCommitted
          ? copyBindings(bindingResult?.bindings ?? exactAfterBindings)
          : liveBindings;
        const afterExpertRevision = bindingCommitted
          ? (bindingResult?.revision ??
            (mode === "update" ? before.expertRevision : before.expertRevision + 1))
          : finalExpert.revision;
        if (!bindingRequest || bindingCommitted) {
          return {
            schemaVersion: 1,
            operationId: request.operationId,
            fingerprint: inputFingerprint,
            expertId: expert.id,
            ...(request.targetSkillId ? { targetSkillId: request.targetSkillId } : {}),
            mode,
            status: bindingCommitted ? "committed" : "saved_unbound",
            touchedPaths,
            before,
            after: {
              skill: afterSkill,
              packageId: afterSkill.packageId,
              bindings: afterBindings,
              expertRevision: afterExpertRevision,
            },
            changes: clone([...request.changes]),
            evidenceRefs: clone([...(request.evidenceRefs ?? [])]),
          };
        }
        return {
          schemaVersion: 1,
          operationId: request.operationId,
          fingerprint: inputFingerprint,
          expertId: expert.id,
          ...(request.targetSkillId ? { targetSkillId: request.targetSkillId } : {}),
          mode,
          status: "saved_unbound",
          touchedPaths,
          before,
          after: {
            skill: afterSkill,
            packageId: afterSkill.packageId,
            bindings: afterBindings,
            expertRevision: finalExpert.revision,
          },
          changes: clone([...request.changes]),
          evidenceRefs: clone([...(request.evidenceRefs ?? [])]),
        };
      },
      {
        expertIds: [request.expertId],
        ...(request.targetSkillId ? { skillIds: [request.targetSkillId] } : {}),
      },
      "automatic",
    );
  };

  const revert = async (
    request: {
      readonly operationId: string;
      readonly resumeResult?: PreparedSkillRevertResult;
      readonly resumeIntent?: PreparedSkillChangeIntent;
    },
    record: PreparedSkillChangeRecord,
    context: MutationContext,
  ): Promise<PreparedSkillRevertResult> => {
    if (!request.operationId.trim() || request.operationId.length > 180)
      throw new Error("Skill revert operationId must be 1 to 180 characters.");
    if (
      request.resumeResult &&
      (request.resumeResult.operationId !== request.operationId ||
        (request.resumeResult.status !== "conflict" &&
          (request.resumeResult.record.operationId !== record.operationId ||
            request.resumeResult.record.fingerprint !== record.fingerprint)))
    )
      return conflict(
        request.operationId,
        "The saved Skill revert receipt does not match this operation.",
      );
    const resumeIntent = request.resumeIntent;
    const revertFingerprint = preparedRevertFingerprint(request.operationId, record);
    if (
      resumeIntent &&
      (resumeIntent.kind !== "revert" ||
        resumeIntent.operationId !== request.operationId ||
        resumeIntent.expertId !== record.expertId ||
        resumeIntent.fingerprint !== revertFingerprint ||
        resumeIntent.recordOperationId !== record.operationId ||
        resumeIntent.recordFingerprint !== record.fingerprint ||
        resumeIntent.mode !== record.mode ||
        stable(resumeIntent.before) !== stable(record.before) ||
        stable(resumeIntent.touchedPaths) !== stable(record.touchedPaths))
    )
      return conflict(
        request.operationId,
        "The saved Skill inverse intent does not match its operation.",
      );
    if (record.status === "saved_unbound")
      return conflict(
        request.operationId,
        "The original Skill change is still saved but unbound; complete or resolve it before reverting.",
      );

    return withExpertLearningCommit(
      input.stateDir,
      async () => {
        const readLive = async (status: "committed" | "saved_unbound") => {
          const liveExpert = await input.experts.read(record.expertId);
          if (!liveExpert || liveExpert.archived)
            return conflict(request.operationId, "Expert is missing or archived.");
          let liveSkill: SkillDefinition | undefined;
          try {
            liveSkill = (
              await input.library.execute(
                { action: "read", skillId: record.after.skill.skillId },
                libraryContext(context),
              )
            ).skill;
          } catch {
            return conflict(request.operationId, "The learned Skill is no longer available.");
          }
          if (!liveSkill)
            return conflict(request.operationId, "The learned Skill is no longer available.");
          assertSkillScopeForExpert(liveSkill, liveExpert.id);
          return {
            status,
            operationId: request.operationId,
            record,
            skill: liveSkill,
            packageId: liveSkill.packageId,
            bindings: copyBindings(liveExpert.skillBindings ?? []),
            expertRevision: liveExpert.revision,
          } as const;
        };

        // A stored terminal receipt is a read-only historical acknowledgement. Return live
        // references so a later C2 edit or binding change is never hidden by stale data.
        if (request.resumeResult?.status === "committed") return readLive("committed");

        const expert = await input.experts.read(record.expertId);
        if (!expert || expert.archived) throw new Error("Expert is missing or archived.");
        const currentSkill = (
          await input.library.execute(
            { action: "read", skillId: record.after.skill.skillId },
            libraryContext(context),
          )
        ).skill;
        if (!currentSkill)
          return conflict(request.operationId, "The learned Skill is no longer available.");
        assertSkillScopeForExpert(currentSkill, expert.id);
        let intent: PreparedSkillRevertIntent | undefined =
          resumeIntent?.kind === "revert" ? resumeIntent : undefined;

        if (!intent) {
          const currentBindings = copyBindings(expert.skillBindings ?? []);
          const currentBinding = currentBindings.find(
            (binding) => binding.skillId === currentSkill.skillId,
          );
          if (!currentBinding)
            return conflict(
              request.operationId,
              "The learned Skill is no longer bound to this Expert.",
            );
          if (currentBinding.allowEvolution !== true)
            throw new Error("Skill learning is read-only for this Expert binding.");

          const mutations: PreparedSkillRevertMutation[] = [];
          if (record.mode === "create") {
            const recordedBinding = record.after.bindings.find(
              (binding) => binding.skillId === currentSkill.skillId,
            );
            if (
              currentSkill.packageId !== record.after.packageId ||
              currentSkill.revision !== record.after.skill.revision ||
              !recordedBinding ||
              stable(currentBinding) !== stable(recordedBinding)
            )
              return conflict(
                request.operationId,
                "The created Skill or its binding has later effective changes; it remains bound.",
              );
            mutations.push({
              request: {
                action: "bindings",
                operation: "set",
                expertId: expert.id,
                expectedRevision: expert.revision,
                requestId: requestId("revert-bind", request.operationId),
                bindings: currentBindings.filter(
                  (binding) => binding.skillId !== currentSkill.skillId,
                ),
              },
              expectedSkill: {
                skillId: currentSkill.skillId,
                packageId: currentSkill.packageId,
                revision: currentSkill.revision,
              },
            });
          } else {
            if (!record.before.skill || !record.before.packageId)
              return conflict(
                request.operationId,
                "The original Skill package reference is missing.",
              );
            assertBoundAndEditable(expert, currentSkill);
            let beforePackage: PackageFiles;
            let afterPackage: PackageFiles;
            let currentPackage: PackageFiles;
            const touchedPaths = new Set(record.touchedPaths);
            try {
              beforePackage = await readPackageFiles(
                input.stateDir,
                input.packages,
                readResource,
                record.before.packageId,
                touchedPaths,
              );
              afterPackage = await readPackageFiles(
                input.stateDir,
                input.packages,
                readResource,
                record.after.packageId,
                touchedPaths,
              );
              currentPackage = await readPackageFiles(
                input.stateDir,
                input.packages,
                readResource,
                currentSkill.packageId,
                touchedPaths,
              );
            } catch (error) {
              return conflict(
                request.operationId,
                `A package resource required for inverse learning is unavailable: ${error instanceof Error ? error.message : "unknown read error"}`,
              );
            }
            const inverse = inverseChanges(
              beforePackage,
              afterPackage,
              currentPackage,
              record.touchedPaths,
            );
            if (inverse.conflicts.length)
              return {
                status: "conflict",
                operationId: request.operationId,
                conflicts: inverse.conflicts,
              };

            if (record.mode === "derive") {
              const entryIndex = inverse.changes.findIndex(
                (change) => change.path === currentSkill.entryPath && change.content !== undefined,
              );
              if (entryIndex < 0)
                return conflict(
                  request.operationId,
                  "The derived Skill entry was not included in the inverse package changes.",
                  currentSkill.entryPath,
                );
              const entryChange = inverse.changes[entryIndex]!;
              const entryText = decodeText(Buffer.from(entryChange.content!, "base64"));
              if (entryText === undefined)
                return conflict(
                  request.operationId,
                  "The derived Skill entry is not valid UTF-8 text.",
                  currentSkill.entryPath,
                );
              try {
                inverse.changes[entryIndex] = {
                  ...entryChange,
                  content: Buffer.from(
                    setFrontmatterName(entryText, currentSkill.name),
                    "utf8",
                  ).toString("base64"),
                };
              } catch {
                return conflict(
                  request.operationId,
                  "The derived Skill entry metadata could not be restored safely.",
                  currentSkill.entryPath,
                );
              }
            }

            if (inverse.changes.length)
              mutations.push({
                request: {
                  action: "save",
                  requestId: requestId("revert", request.operationId),
                  skillId: currentSkill.skillId,
                  expectedRevision: currentSkill.revision,
                  name: currentSkill.name,
                  tags: currentSkill.tags,
                  changes: inverse.changes,
                },
              });
          }

          intent = makePreparedRevertIntent({
            operationId: request.operationId,
            record,
            currentBefore: {
              skill: currentSkill,
              packageId: currentSkill.packageId,
              bindings: currentBindings,
              expertRevision: expert.revision,
            },
            mutations,
          });
          await context.onPrepared?.(intent);
        }

        let savedSkill: SkillDefinition | undefined;
        for (const mutation of intent.mutations) {
          let gateRejected = false;
          const checkedContext: MutationContext = {
            ...context,
            beforeMutation: async (effect) => {
              try {
                await context.beforeMutation(effect);
              } catch (error) {
                gateRejected = true;
                throw error;
              }
            },
          };
          const permissionSkillId =
            mutation.request.action === "save"
              ? mutation.request.skillId
              : (mutation.expectedSkill?.skillId ??
                savedSkill?.skillId ??
                record.after.skill.skillId);
          const mutationContext = libraryMutationContext(
            input.library,
            input.experts,
            checkedContext,
            record.expertId,
            permissionSkillId,
          );
          if (mutation.request.action === "save") {
            const liveExpert = await input.experts.read(record.expertId);
            const liveSkill = (
              await input.library.execute(
                { action: "read", skillId: mutation.request.skillId },
                libraryContext(context),
              )
            ).skill;
            if (!liveExpert || !liveSkill)
              return conflict(
                request.operationId,
                "The inverse Skill target is no longer available.",
              );
            assertSkillScopeForExpert(liveSkill, liveExpert.id);
            if (liveSkill.revision === mutation.request.expectedRevision) {
              const binding = liveExpert.skillBindings?.find(
                (item) => item.skillId === liveSkill.skillId,
              );
              if (!binding)
                return conflict(
                  request.operationId,
                  "The learned Skill is no longer bound to this Expert.",
                );
              if (binding.allowEvolution !== true)
                throw new Error("Skill learning is read-only for this Expert binding.");
            }
            try {
              const response = await input.library.execute(mutation.request, mutationContext);
              if (!response.skill)
                return conflict(request.operationId, "The inverse Skill revision was not saved.");
              savedSkill = response.skill;
            } catch (error) {
              if (gateRejected) throw error;
              if (
                error instanceof Error &&
                /revision changed|conflict|request id/iu.test(error.message)
              )
                return conflict(
                  request.operationId,
                  `The inverse Skill write conflicted: ${error.message}`,
                );
              throw error;
            }
            continue;
          }

          const liveExpert = await input.experts.read(record.expertId);
          if (!liveExpert || liveExpert.archived)
            return conflict(request.operationId, "Expert is missing or archived.");
          const targetSkillId =
            mutation.expectedSkill?.skillId ?? savedSkill?.skillId ?? record.after.skill.skillId;
          const liveSkill = (
            await input.library.execute(
              { action: "read", skillId: targetSkillId },
              libraryContext(context),
            )
          ).skill;
          if (!liveSkill)
            return conflict(request.operationId, "The binding target Skill is unavailable.");
          assertSkillScopeForExpert(liveSkill, liveExpert.id);
          const wantedBindings = mutation.request.bindings;
          const bindingsAlreadyMatch =
            stable(liveExpert.skillBindings ?? []) === stable(wantedBindings);
          const skillExpectation = mutation.expectedSkill ?? savedSkill;
          const skillMatches =
            !mutation.mustMatchPreviousSkillMutation && !mutation.expectedSkill
              ? true
              : skillExpectation !== undefined &&
                liveSkill.skillId === skillExpectation.skillId &&
                liveSkill.packageId === skillExpectation.packageId &&
                liveSkill.revision === skillExpectation.revision;
          if (!skillMatches && !bindingsAlreadyMatch)
            return conflict(
              request.operationId,
              "The Skill changed after this inverse was prepared; its binding was left untouched.",
            );
          if (!bindingsAlreadyMatch) {
            const boundTarget = (liveExpert.skillBindings ?? []).find(
              (binding) => binding.skillId === targetSkillId,
            );
            if (boundTarget && boundTarget.allowEvolution !== true)
              throw new Error("Skill learning is read-only for this Expert binding.");
          }
          let response: Awaited<ReturnType<Library["execute"]>>;
          try {
            response = await input.library.execute(mutation.request, mutationContext);
          } catch (error) {
            if (gateRejected) throw error;
            if (
              error instanceof Error &&
              /revision changed|conflict|request id/iu.test(error.message)
            )
              return conflict(
                request.operationId,
                `The inverse binding write conflicted: ${error.message}`,
              );
            throw error;
          }
          const status = response.bindingResult?.status;
          if (status !== "applied" && status !== "unchanged") {
            if (savedSkill)
              return {
                status: "saved_unbound",
                operationId: request.operationId,
                record,
                skill: savedSkill,
                packageId: savedSkill.packageId,
                bindings: copyBindings(liveExpert.skillBindings ?? []),
                expertRevision: liveExpert.revision,
              };
            return conflict(
              request.operationId,
              response.bindingResult?.error ?? "The inverse binding write was not applied.",
            );
          }
        }

        const liveResult = await readLive("committed");
        if (liveResult.status === "conflict") return liveResult;
        if (
          record.mode === "create" &&
          liveResult.bindings.some((binding) => binding.skillId === record.after.skill.skillId)
        )
          return conflict(
            request.operationId,
            "The created Skill was rebound after the inverse; the later binding was preserved.",
          );
        return liveResult;
      },
      { expertIds: [record.expertId], skillIds: [record.after.skill.skillId] },
      "manual",
    );
  };

  return { commit, revert };
}
