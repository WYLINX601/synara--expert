import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import YAML from "yaml";
import {
  FIXED_EXPERT_SKILL_POLICY,
  RunSkillAssembly,
  type ProviderExpertSession,
} from "@synara/contracts";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import { createExpertStore, expertResourceFiles } from "./ExpertStore";
import { createSkillPackageStore } from "./SkillPackageStore";
import { readSkillDefinition, resolveSkillBindings } from "./SkillLibraryStore";
import { writePrivateFileAtomically, serializeJsonWithinByteLimit } from "./ExpertMcpStorage";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle";
import { expertSnapshotSession } from "./expertSnapshotSession";

const LIMIT = 16 * 1024 * 1024;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const recordPath = (stateDir: string, rootRunId: string) =>
  path.join(stateDir, "experts", "run-skill-assemblies", `${digest(rootRunId)}.json`);

export function skillAssemblyFingerprint(session: ProviderExpertSession): string {
  return `ska_${digest(
    expertResourceFiles.stableJson({
      baseSnapshotId: session.snapshotId,
      policy: session.skillPolicy,
      entries: session.skillEntries,
      skills: session.skills,
    }),
  )}`;
}

function validateRecord(record: RunSkillAssembly, rootRunId?: string): RunSkillAssembly {
  if (
    (rootRunId !== undefined && record.rootRunId !== rootRunId) ||
    record.session.skillRootRunId !== record.rootRunId ||
    record.session.snapshotId !== record.baseSnapshotId ||
    record.session.skillAssemblyId !== record.assemblyId ||
    record.assemblyId !== skillAssemblyFingerprint(record.session)
  )
    throw new Error("Run Skill assembly identity is corrupt.");
  return record;
}

/** Pure read used by reference scans as well as recovery; it never creates a store. */
export async function readRunSkillAssembly(stateDir: string, rootRunId: string) {
  try {
    const file = recordPath(stateDir, rootRunId);
    const bytes = await expertResourceFiles.read(file);
    if (bytes.byteLength > LIMIT) throw new Error("Run Skill assembly exceeds its limit.");
    return validateRecord(
      Schema.decodeUnknownSync(RunSkillAssembly)(JSON.parse(bytes.toString("utf8"))),
      rootRunId,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function listRunSkillAssemblies(stateDir: string): Promise<RunSkillAssembly[]> {
  const directory = path.join(stateDir, "experts", "run-skill-assemblies");
  const stat = await fs.lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("Unsafe Run Skill assembly directory.");
  const records: RunSkillAssembly[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name))
      throw new Error("Unresolved Run Skill assembly record.");
    const bytes = await expertResourceFiles.read(path.join(directory, entry.name));
    const record = validateRecord(
      Schema.decodeUnknownSync(RunSkillAssembly)(JSON.parse(bytes.toString("utf8"))),
    );
    if (`${digest(record.rootRunId)}.json` !== entry.name)
      throw new Error("Run Skill record path mismatch.");
    records.push(record);
  }
  return records;
}

const pointers = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  roots: Schema.Record(Schema.String, Schema.String),
  continuations: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export function createRunSkillAssemblyStore(stateDir: string) {
  const experts = createExpertStore(stateDir);
  const packages = createSkillPackageStore(stateDir);
  const initializationHasEffects = async (session: ProviderExpertSession): Promise<boolean> => {
    const entries = session.skillEntries ?? [];
    for (const packageId of new Set(entries.map((entry) => entry.packageId))) {
      const manifest = await packages.read(packageId);
      // Native plugin resources are retained by the projection. SessionStart
      // hooks (including a custom path in plugin.json) and startup integrations
      // can run before a model prompt, independently of the selected entry's YAML.
      if (
        manifest.resources.some(
          (resource) =>
            resource.kind === "file" &&
            [
              "content/hooks/hooks.json",
              "content/.claude-plugin/plugin.json",
              "content/.mcp.json",
            ].includes(resource.path),
        )
      )
        return true;
    }
    for (const entry of entries) {
      if (entry.activation === "startup") return true;
      const bytes = await expertResourceFiles.read(entry.path);
      const block = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)/u.exec(bytes.toString("utf8"));
      const metadata: unknown = block ? YAML.parse(block[1]!, { logLevel: "error" }) : undefined;
      if (metadata && typeof metadata === "object" && Object.hasOwn(metadata, "hooks")) return true;
    }
    return false;
  };
  const pointerFile = path.join(stateDir, "experts", "run-skill-roots.json");
  const write = async (record: RunSkillAssembly) => {
    validateRecord(record);
    ensurePrivateDirectorySync(path.dirname(recordPath(stateDir, record.rootRunId)));
    await writePrivateFileAtomically(
      recordPath(stateDir, record.rootRunId),
      serializeJsonWithinByteLimit(record, LIMIT, "Run Skill assembly exceeds its limit."),
    );
  };
  const refreshInitializationEffects = async (record: RunSkillAssembly) => {
    if (record.hasInitializationEffects || !(await initializationHasEffects(record.session)))
      return record;
    const refreshed = {
      ...record,
      hasInitializationEffects: true,
      ...(record.phase === "initializing" || record.initializationError !== undefined
        ? { phase: "uncertain" as const }
        : {}),
    };
    await write(refreshed);
    return refreshed;
  };
  const readPointers = async () => {
    try {
      return Schema.decodeUnknownSync(pointers)(
        JSON.parse((await expertResourceFiles.read(pointerFile)).toString("utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1 as const, roots: {} as Record<string, string> };
      throw error;
    }
  };
  const resolveLatest = async (baseSnapshotId: string) => {
    const snapshot = await experts.readSnapshot(baseSnapshotId);
    if (snapshot.schemaVersion !== 3 || snapshot.skillPolicy?.discovery !== "fixed")
      throw new Error("This historical Expert has no supported Skill assembly identity.");
    const definition = await experts.read(snapshot.expertId);
    if (!definition || definition.archived)
      throw new Error("The Expert definition is unavailable or archived.");
    const bindings = definition.skillBindings;
    const selections =
      bindings !== undefined
        ? await resolveSkillBindings(stateDir, bindings)
        : (definition.skillSelections ?? snapshot.skillSelections ?? []);
    const managedSkills = await Promise.all(
      (bindings ?? [])
        .filter((binding) => binding.enabled)
        .map((binding) => readSkillDefinition(stateDir, binding.skillId)),
    );
    const entries = (await packages.resolveSelections(selections)).map((entry) => {
      const managed = managedSkills.find(
        (skill) => skill.packageId === entry.packageId && skill.entryPath === entry.entryPath,
      );
      return { ...entry, ...(managed ? { managedSkillId: managed.skillId } : {}) };
    });
    const session: ProviderExpertSession = {
      ...expertSnapshotSession(snapshot),
      skillPolicy: FIXED_EXPERT_SKILL_POLICY,
      skillsRoot: path.join(stateDir, "experts", "skill-packages"),
      skills: entries.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
      skillEntries: entries,
    };
    return { definition, entries, session };
  };
  const bindPointers = async (input: {
    threadId: string;
    rootRunId: string;
    continuationKey?: string;
    inheritContinuation?: boolean;
  }) => {
    const current = await readPointers();
    const next = {
      ...current,
      roots: { ...current.roots, [input.threadId]: input.rootRunId },
      ...(input.continuationKey
        ? {
            continuations: {
              ...current.continuations,
              [input.continuationKey]: input.inheritContinuation
                ? (current.continuations?.[input.continuationKey] ?? input.rootRunId)
                : input.rootRunId,
            },
          }
        : {}),
    };
    if (!isDeepStrictEqual(current, next))
      await writePrivateFileAtomically(
        pointerFile,
        serializeJsonWithinByteLimit(next, LIMIT, "Run Skill root index exceeds its limit."),
      );
  };
  const store = {
    read: (rootRunId: string) => readRunSkillAssembly(stateDir, rootRunId),
    preview: (baseSnapshotId: string) =>
      withSkillPackageLifecycle(
        stateDir,
        async () => (await resolveLatest(baseSnapshotId)).session,
      ),
    async current(threadId: string) {
      const pointer = (await readPointers()).roots[threadId];
      if (!pointer) return undefined;
      const record = await readRunSkillAssembly(stateDir, pointer);
      if (!record || record.threadId !== threadId)
        throw new Error("Current Run Skill assembly is missing or mismatched.");
      return record;
    },
    async continuation(threadId: string, key: string, allowOtherWorkerThread = false) {
      const pointer = (await readPointers()).continuations?.[key];
      if (!pointer) return undefined;
      const record = await readRunSkillAssembly(stateDir, pointer);
      if (!record || (!allowOtherWorkerThread && record.threadId !== threadId))
        throw new Error("Skill continuation assembly is missing or mismatched.");
      return record;
    },
    async prepare(input: {
      threadId: string;
      rootRunId: string;
      baseSnapshotId: string;
      createdAt: string;
      continuationKey?: string;
      inheritContinuation?: boolean;
    }) {
      return withSkillPackageLifecycle(stateDir, async () => {
        const existing = await readRunSkillAssembly(stateDir, input.rootRunId);
        if (existing) {
          if (
            existing.threadId !== input.threadId ||
            existing.baseSnapshotId !== input.baseSnapshotId
          )
            throw new Error("Run Skill assembly belongs to another task identity.");
          await bindPointers(input);
          return existing;
        }
        const continuationRoot =
          input.inheritContinuation && input.continuationKey
            ? (await readPointers()).continuations?.[input.continuationKey]
            : undefined;
        const inheritedRecord = continuationRoot
          ? await readRunSkillAssembly(stateDir, continuationRoot)
          : undefined;
        const inherited = inheritedRecord
          ? await refreshInitializationEffects(inheritedRecord)
          : undefined;
        if (continuationRoot && !inherited)
          throw new Error("Skill continuation assembly is missing.");
        if (
          inherited &&
          (inherited.phase === "uncertain" ||
            (inherited.phase === "initializing" && inherited.hasInitializationEffects))
        )
          throw new Error(
            "Skill initialization outcome is uncertain; continuation cannot replay startup side effects.",
          );
        const resolved = inherited
          ? (() => {
              const entries = inherited.session.skillEntries ?? [];
              return experts.readSnapshot(input.baseSnapshotId).then((snapshot) => {
                const base = expertSnapshotSession(snapshot);
                if (base.expertId !== inherited.session.expertId)
                  throw new Error("Skill continuation changed its assigned Expert.");
                return {
                  definition: { revision: inherited.bindingRevision },
                  entries,
                  session: {
                    ...base,
                    skillPolicy: inherited.session.skillPolicy,
                    skills: inherited.session.skills,
                    skillEntries: entries,
                  },
                };
              });
            })()
          : resolveLatest(input.baseSnapshotId);
        const { definition, entries, session: base } = await resolved;
        const session: ProviderExpertSession = {
          ...base,
          skillPolicy: FIXED_EXPERT_SKILL_POLICY,
          skillsRoot: path.join(stateDir, "experts", "skill-packages"),
          skills: entries.map(({ name, path: skillPath }) => ({ name, path: skillPath })),
          skillEntries: entries,
          skillRootRunId: input.rootRunId,
        };
        const assemblyId = skillAssemblyFingerprint(session);
        const hasInitializationEffects = await initializationHasEffects(session);
        const record: RunSkillAssembly = {
          schemaVersion: 1,
          assemblyId,
          rootRunId: input.rootRunId,
          threadId: input.threadId,
          baseSnapshotId: input.baseSnapshotId,
          bindingRevision: definition.revision,
          createdAt: input.createdAt,
          hasInitializationEffects,
          phase: "prepared",
          session: { ...session, skillAssemblyId: assemblyId },
        };
        await write(record);
        await bindPointers(input);
        return record;
      });
    },
    async verifySession(session: ProviderExpertSession): Promise<ProviderExpertSession> {
      if (!session.skillRootRunId || !session.skillAssemblyId)
        throw new Error("Run Skill assembly reference is incomplete.");
      const record = await readRunSkillAssembly(stateDir, session.skillRootRunId);
      if (!record || !isDeepStrictEqual(record.session, session))
        throw new Error("Run Skill assembly does not match its durable record.");
      const snapshot = await experts.readSnapshot(record.baseSnapshotId);
      const base = expertSnapshotSession(snapshot);
      const identity = (value: ProviderExpertSession) => ({
        snapshotId: value.snapshotId,
        expertId: value.expertId,
        revision: value.revision,
        displayName: value.displayName,
        persona: value.persona,
        references: value.references,
      });
      if (!isDeepStrictEqual(identity(base), identity(session)))
        throw new Error("Run assembly changed the pinned Expert identity.");
      const resolved = await packages.resolveSelections(
        (session.skillEntries ?? []).map(({ packageId, entryPath, activation }) => ({
          packageId,
          entryPath,
          activation,
        })),
      );
      const canonical = (session.skillEntries ?? []).map(
        ({ managedSkillId: _managedSkillId, ...entry }) => entry,
      );
      if (!isDeepStrictEqual(resolved, canonical))
        throw new Error("Run assembly entries do not match immutable packages.");
      return record.session;
    },
    async beginInitialization(rootRunId: string) {
      return withSkillPackageLifecycle(stateDir, async () => {
        let record = await readRunSkillAssembly(stateDir, rootRunId);
        if (!record) throw new Error("Run assembly must be durable before native initialization.");
        record = await refreshInitializationEffects(record);
        if (
          record.phase === "uncertain" ||
          (record.phase === "initializing" && record.hasInitializationEffects)
        )
          throw new Error(
            "Skill initialization outcome is uncertain; review this Run before replaying startup side effects.",
          );
        const { initializationError: _previousError, ...prepared } = record;
        const next = {
          ...prepared,
          phase: "initializing" as const,
          initializationAttempt: randomUUID(),
        };
        await write(next);
        return next.initializationAttempt;
      });
    },
    async finishInitialization(rootRunId: string, attempt: string, error?: unknown) {
      await withSkillPackageLifecycle(stateDir, async () => {
        const record = await readRunSkillAssembly(stateDir, rootRunId);
        if (!record || record.initializationAttempt !== attempt)
          throw new Error("Native initialization attempt changed.");
        const hasInitializationEffects =
          record.hasInitializationEffects ||
          (error !== undefined && (await initializationHasEffects(record.session)));
        await write({
          ...record,
          hasInitializationEffects,
          phase: error && hasInitializationEffects ? "uncertain" : error ? "prepared" : "ready",
          ...(error
            ? { initializationError: String(error instanceof Error ? error.message : error) }
            : {}),
        });
      });
    },
  };
  return store;
}
