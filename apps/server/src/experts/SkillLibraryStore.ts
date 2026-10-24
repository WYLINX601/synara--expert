import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  ExpertSkillBinding,
  SkillDefinition,
  SkillId,
  SkillLibraryRequest,
  type ExpertSkillSelection,
  type SkillLibraryPreview,
  type SkillLibraryResponse,
  type SkillPackage,
  type SkillSource,
} from "@synara/contracts";
import { Schema } from "effect";
import YAML from "yaml";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import { writePrivateFileAtomically } from "./ExpertMcpStorage";
import { createExpertStore, expertResourceFiles } from "./ExpertStore";
import { createSkillPackageStore } from "./SkillPackageStore";
import { withSkillPackageLifecycle } from "./skillPackageLifecycle";
import {
  assertSkillResourcePath,
  downloadSkillSource,
  extractSkillArchive,
  SKILL_FILE_LIMIT,
  SKILL_PACKAGE_LIMIT,
} from "./skillLibraryArchive";

const Registry = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  skills: Schema.Array(SkillDefinition),
});
const pendingWrites = new Map<string, Promise<unknown>>();
const registryPath = (stateDir: string) => path.join(stateDir, "experts", "skill-library.json");
export async function readSkillLibraryDefinitions(stateDir: string): Promise<SkillDefinition[]> {
  try {
    return [
      ...Schema.decodeUnknownSync(Registry)(
        JSON.parse((await expertResourceFiles.read(registryPath(stateDir))).toString("utf8")),
      ).skills,
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
export async function readSkillDefinition(
  stateDir: string,
  skillId: string,
): Promise<SkillDefinition> {
  Schema.decodeUnknownSync(SkillId)(skillId);
  const definition = (await readSkillLibraryDefinitions(stateDir)).find(
    (item) => item.skillId === skillId && !item.deleted,
  );
  if (!definition) throw new Error(`Skill not found or deleted: ${skillId}`);
  return definition;
}
export async function resolveSkillBindings(
  stateDir: string,
  rawBindings: ReadonlyArray<ExpertSkillBinding>,
): Promise<ExpertSkillSelection[]> {
  const bindings = Schema.decodeUnknownSync(
    Schema.Array(ExpertSkillBinding).check(Schema.isMaxLength(100)),
  )(rawBindings);
  if (new Set(bindings.map((binding) => binding.skillId)).size !== bindings.length)
    throw new Error("Duplicate Skill binding.");
  if (bindings.filter((binding) => binding.enabled && binding.activation === "startup").length > 1)
    throw new Error("An Expert can enable at most one startup Skill.");
  const skills = await Promise.all(
    bindings.map((binding) => readSkillDefinition(stateDir, binding.skillId)),
  );
  return bindings.flatMap((binding, index) =>
    binding.enabled
      ? [
          {
            packageId: skills[index]!.packageId,
            entryPath: skills[index]!.entryPath,
            activation: binding.activation,
          },
        ]
      : [],
  );
}

async function renameEntry(file: string, name: string): Promise<void> {
  const text = (await fs.readFile(file)).toString("utf8"),
    match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const parsed: unknown = match ? YAML.parse(match[1]!, { logLevel: "error" }) : {};
  if (parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed)))
    throw new Error("Skill frontmatter must be a mapping before renaming.");
  await fs.writeFile(
    file,
    `---\n${YAML.stringify({ ...((parsed as object) ?? {}), name })}---\n${match ? text.slice(match[0].length) : text}`,
  );
}

const libraryInstances = new Map<string, ReturnType<typeof makeSkillLibraryStore>>();
export function createSkillLibraryStore(stateDir: string) {
  if (!path.isAbsolute(stateDir))
    throw new Error("Skill library state directory must be absolute.");
  const key = path.resolve(stateDir),
    existing = libraryInstances.get(key);
  if (existing) return existing;
  const store = makeSkillLibraryStore(stateDir);
  libraryInstances.set(key, store);
  return store;
}
function makeSkillLibraryStore(stateDir: string) {
  if (!path.isAbsolute(stateDir))
    throw new Error("Skill library state directory must be absolute.");
  const packages = createSkillPackageStore(stateDir),
    staging = path.join(stateDir, "experts", "skill-library-staging");
  ensurePrivateDirectorySync(staging);
  type Pending = {
    preview: SkillLibraryPreview;
    packagePreviewId: string;
    ownedRoot?: string;
    skillId?: string;
    revision?: number;
  };
  const previews = new Map<string, Pending>();
  const activePreviews = new Map<string, AbortController>();
  let disposal: Promise<void> | undefined;
  const lock = <T>(operation: () => Promise<T>): Promise<T> => {
    const key = path.resolve(stateDir),
      result = (pendingWrites.get(key) ?? Promise.resolve()).then(operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    pendingWrites.set(key, settled);
    void settled.then(() => {
      if (pendingWrites.get(key) === settled) pendingWrites.delete(key);
    });
    return result;
  };
  const writeRegistry = (skills: SkillDefinition[], lifecycleHeld = false) => {
    const serialized = `${JSON.stringify({ schemaVersion: 1, skills }, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > SKILL_FILE_LIMIT)
      throw new Error("Skill library registry exceeds the 16 MiB read limit.");
    const write = () => writePrivateFileAtomically(registryPath(stateDir), serialized);
    return lifecycleHeld ? write() : withSkillPackageLifecycle(stateDir, write);
  };
  const rootPath = (packageId: string) =>
    path.join(stateDir, "experts", "skill-packages", packageId, "content");
  const cleanup = async (id: string) => {
    const pending = previews.get(id);
    previews.delete(id);
    if (pending) packages.cancelPreview(pending.packagePreviewId);
    if (pending?.ownedRoot) await fs.rm(pending.ownedRoot, { recursive: true, force: true });
  };
  const expire = async () => {
    for (const [id, pending] of previews)
      if (Date.parse(pending.preview.expiresAt) <= Date.now()) await cleanup(id);
  };
  const revision = async (skillId: string, expected: number) => {
    const item = await readSkillDefinition(stateDir, skillId);
    if (item.revision !== expected)
      throw new Error("Skill revision changed; reload before saving.");
    return item;
  };
  const commit = async (items: SkillDefinition[], lifecycleHeld = false) => {
    const current = await readSkillLibraryDefinitions(stateDir),
      ids = new Set(items.map((item) => item.skillId));
    await writeRegistry(
      [...current.filter((item) => !ids.has(item.skillId)), ...items],
      lifecycleHeld,
    );
  };
  const makeItem = (input: {
    pkg: SkillPackage;
    entryPath: string;
    source: SkillSource;
    name?: string;
    tags?: ReadonlyArray<string>;
    previous?: SkillDefinition;
    modified?: boolean;
  }): SkillDefinition => {
    const entry = input.pkg.entries.find((entry) => entry.entryPath === input.entryPath);
    if (!entry) throw new Error("Selected Skill entry disappeared or is ambiguous.");
    return Schema.decodeUnknownSync(SkillDefinition)({
      skillId: input.previous?.skillId ?? `skl_${randomUUID().replaceAll("-", "")}`,
      name: input.name ?? entry.name,
      description: entry.description,
      tags: [...new Set(input.tags ?? input.previous?.tags ?? [])],
      packageId: input.pkg.packageId,
      entryPath: input.entryPath,
      source: input.source,
      locallyModified: input.modified ?? false,
      revision: (input.previous?.revision ?? 0) + 1,
      deleted: false,
      updatedAt: new Date().toISOString(),
    });
  };
  const previewSource = async (
    location: string,
    kind: "local" | "url" | "runtime",
    current?: SkillDefinition,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<SkillLibraryPreview> => {
    if (signal?.aborted) throw new Error("Skill preview cancelled.");
    await expire();
    if (previews.size >= 100) throw new Error("Too many pending Skill previews.");
    let packagePreviewId: string | undefined;
    let sourcePath = location,
      ownedRoot: string | undefined,
      sourceKind: SkillSource["kind"] = kind;
    let remote: Awaited<ReturnType<typeof downloadSkillSource>> | undefined;
    try {
      if (kind === "url") {
        ownedRoot = await fs.mkdtemp(path.join(staging, "import-"));
        remote = await downloadSkillSource(location, ownedRoot, signal);
        sourcePath = remote.root;
        location = remote.canonicalLocation;
      } else if (/\.(?:zip|skill)$/iu.test(location)) {
        const stat = await fs.lstat(location);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SKILL_PACKAGE_LIMIT)
          throw new Error("Unsafe or oversized Skill archive.");
        const bytes = await fs.readFile(location);
        if (bytes.length > SKILL_PACKAGE_LIMIT) throw new Error("Oversized Skill archive.");
        ownedRoot = await fs.mkdtemp(path.join(staging, "import-"));
        sourcePath = path.join(ownedRoot, "package");
        await fs.mkdir(sourcePath, { mode: 0o700 });
        await extractSkillArchive(bytes, sourcePath);
        sourceKind = "archive";
      }
      const result = await packages.preview({ path: sourcePath });
      packagePreviewId = result.previewId;
      if (signal?.aborted) throw new Error("Skill preview cancelled.");
      const remoteMatches = remote?.skillName
        ? result.package.entries.filter(
            (entry) =>
              entry.name === remote!.skillName ||
              path.posix.basename(path.posix.dirname(entry.entryPath)) === remote!.skillName ||
              (entry.entryPath === "SKILL.md" && path.basename(sourcePath) === remote!.skillName),
          )
        : undefined;
      if (remoteMatches && remoteMatches.length !== 1)
        throw new Error(
          "Skills.sh source entry disappeared or is ambiguous; use an exact GitHub Skill directory URL.",
        );
      if (current && remoteMatches && remoteMatches[0]!.entryPath !== current.source.entryPath)
        throw new Error("Source Skill entry identity changed; review a replacement explicitly.");
      if (
        current &&
        !result.package.entries.some((entry) => entry.entryPath === current.source.entryPath)
      )
        throw new Error(
          "Source Skill entry disappeared; select and review the replacement explicitly.",
        );
      const previous = current ? await packages.read(current.packageId) : undefined;
      const before = new Map(
          previous?.resources.map((resource) => [resource.path, resource.sha256]) ?? [],
        ),
        after = new Map(
          result.package.resources.map((resource) => [resource.path, resource.sha256]),
        );
      const preview: SkillLibraryPreview = {
        previewId: requestId ?? randomUUID(),
        package: result.package,
        expiresAt: result.expiresAt,
        source: {
          kind: sourceKind,
          location,
          ...(remote ? { resolvedRevision: remote.resolvedRevision } : {}),
          packageId: result.package.packageId,
          entryPath:
            current?.source.entryPath ??
            remoteMatches?.[0]?.entryPath ??
            result.package.entries[0]!.entryPath,
        },
        ...(remoteMatches
          ? { selectedEntryPaths: remoteMatches.map((entry) => entry.entryPath) }
          : {}),
        resourceChanges: [...new Set([...before.keys(), ...after.keys()])].filter(
          (name) => before.get(name) !== after.get(name),
        ),
        overwritesLocalEdits: current?.locallyModified ?? false,
      };
      previews.set(preview.previewId, {
        preview,
        packagePreviewId: result.previewId,
        ...(ownedRoot ? { ownedRoot } : {}),
        ...(current ? { skillId: current.skillId, revision: current.revision } : {}),
      });
      return preview;
    } catch (error) {
      if (packagePreviewId) packages.cancelPreview(packagePreviewId);
      if (ownedRoot) await fs.rm(ownedRoot, { recursive: true, force: true });
      throw error;
    }
  };
  const pendingPreview = async (id: string) => {
    await expire();
    const item = previews.get(id);
    if (!item) throw new Error("Skill preview expired or was cancelled; preview again.");
    return item;
  };
  const edit = async (request: Extract<SkillLibraryRequest, { action: "save" }>) => {
    const current = await revision(request.skillId, request.expectedRevision),
      pkg = await packages.read(current.packageId);
    const owned = await fs.mkdtemp(path.join(staging, "edit-")),
      directory = path.join(owned, pkg.rootName);
    await fs.mkdir(directory, { mode: 0o700 });
    try {
      for (const resource of pkg.resources) {
        const relative = resource.path.slice("content/".length);
        if (!relative) continue;
        const target = path.join(directory, ...relative.split("/"));
        if (resource.kind === "directory") await fs.mkdir(target, { recursive: true, mode: 0o700 });
        else {
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(
            target,
            await expertResourceFiles.read(
              path.join(rootPath(pkg.packageId), ...relative.split("/")),
            ),
            { mode: resource.executable ? 0o700 : 0o600 },
          );
        }
      }
      const changed = new Set<string>();
      for (const change of request.changes) {
        assertSkillResourcePath(change.path);
        const key = change.path.normalize("NFC").toLowerCase();
        if (changed.has(key)) throw new Error("Duplicate file change.");
        changed.add(key);
        const target = path.join(directory, ...change.path.split("/"));
        if (change.content === undefined) {
          await fs.rm(target, { force: true });
          continue;
        }
        const bytes = Buffer.from(change.content, "base64");
        if (bytes.toString("base64") !== change.content || bytes.length > SKILL_FILE_LIMIT)
          throw new Error("Invalid base64 or resource exceeds 16 MiB.");
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.writeFile(target, bytes, { mode: change.executable ? 0o700 : 0o600 });
        const prior = pkg.resources.find((resource) => resource.path === `content/${change.path}`);
        await fs.chmod(target, (change.executable ?? prior?.executable) ? 0o700 : 0o600);
      }
      if (request.name !== current.name)
        await renameEntry(path.join(directory, ...current.entryPath.split("/")), request.name);
      let item!: SkillDefinition;
      await packages.publishDirectory(directory, async (next) => {
        item = makeItem({
          pkg: next,
          entryPath: current.entryPath,
          source: current.source,
          tags: request.tags,
          previous: current,
          modified: current.locallyModified || next.packageId !== current.source.packageId,
        });
        await commit([item], true);
      });
      return item;
    } finally {
      await fs.rm(owned, { recursive: true, force: true });
    }
  };
  const expertIds = async (skillId: string) =>
    (await createExpertStore(stateDir).list())
      .filter((expert) => expert.skillBindings?.some((binding) => binding.skillId === skillId))
      .map((expert) => expert.id)
      .toSorted();
  const remove = async (skillId: string, expected: number, confirmed: ReadonlyArray<string>) => {
    const current = await revision(skillId, expected),
      affected = await expertIds(skillId);
    if (JSON.stringify(affected) !== JSON.stringify([...new Set(confirmed)].toSorted()))
      throw new Error("Affected Expert bindings changed; review and confirm deletion again.");
    const experts = createExpertStore(stateDir);
    for (const id of affected) {
      const expert = await experts.read(id);
      if (!expert) throw new Error("Expert changed during deletion.");
      await experts.save({
        ...expert,
        expectedRevision: expert.revision,
        skillBindings: expert.skillBindings?.filter((binding) => binding.skillId !== skillId) ?? [],
      });
    }
    await withSkillPackageLifecycle(stateDir, async () => {
      if ((await expertIds(skillId)).length)
        throw new Error("Skill was rebound during deletion; review again.");
      await commit(
        [
          {
            ...current,
            deleted: true,
            revision: current.revision + 1,
            updatedAt: new Date().toISOString(),
          },
        ],
        true,
      );
    });
  };
  const execute = async (raw: SkillLibraryRequest): Promise<SkillLibraryResponse> => {
    if (disposal) throw new Error("Skill library is closing; reconnect before continuing.");
    const request = Schema.decodeUnknownSync(SkillLibraryRequest)(raw);
    if (request.action === "cancel") activePreviews.get(request.previewId)?.abort();
    const requestId =
      request.action === "previewImport" ? (request.requestId ?? randomUUID()) : undefined;
    const controller = requestId ? new AbortController() : undefined;
    if (requestId && (activePreviews.has(requestId) || previews.has(requestId)))
      throw new Error("Skill preview request ID is already in use.");
    if (requestId) activePreviews.set(requestId, controller!);
    return lock(async () => {
      switch (request.action) {
        case "list":
          return {
            skills: (await readSkillLibraryDefinitions(stateDir)).filter((skill) => !skill.deleted),
          };
        case "read": {
          const skill = await readSkillDefinition(stateDir, request.skillId);
          return { skill, resources: (await packages.read(skill.packageId)).resources };
        }
        case "create": {
          const owned = await fs.mkdtemp(path.join(staging, "create-")),
            directory = path.join(owned, "skill");
          await fs.mkdir(directory, { mode: 0o700 });
          try {
            await fs.writeFile(path.join(directory, "SKILL.md"), request.body, { mode: 0o600 });
            await renameEntry(path.join(directory, "SKILL.md"), request.name);
            let skill!: SkillDefinition;
            await packages.publishDirectory(directory, async (pkg) => {
              const entryPath = "SKILL.md";
              skill = makeItem({
                pkg,
                entryPath,
                tags: request.tags,
                source: { kind: "manual", location: "", packageId: pkg.packageId, entryPath },
              });
              await commit([skill], true);
            });
            return { skill };
          } finally {
            await fs.rm(owned, { recursive: true, force: true });
          }
        }
        case "save":
          return { skill: await edit(request) };
        case "previewImport":
          return {
            preview: await previewSource(
              request.location,
              request.kind,
              undefined,
              controller?.signal,
              requestId,
            ),
          };
        case "cancel":
          await cleanup(request.previewId);
          return {};
        case "import": {
          const pending = await pendingPreview(request.previewId);
          if (pending.skillId) throw new Error("Refresh previews cannot import new identities.");
          if (
            !request.choices.length ||
            new Set(request.choices.map((choice) => choice.entryPath)).size !==
              request.choices.length
          )
            throw new Error("Select distinct Skill entries to import.");
          const existing = (await readSkillLibraryDefinitions(stateDir)).filter(
              (item) => !item.deleted,
            ),
            items: SkillDefinition[] = [];
          for (const choice of request.choices) {
            if (
              pending.preview.selectedEntryPaths &&
              !pending.preview.selectedEntryPaths.includes(choice.entryPath)
            )
              throw new Error("Selected entry does not match this source URL.");
            const entry = pending.preview.package.entries.find(
              (entry) => entry.entryPath === choice.entryPath,
            );
            if (!entry) throw new Error("Skill entry is absent from preview.");
            const name = choice.name ?? entry.name,
              duplicates = existing.filter(
                (item) =>
                  item.name.normalize("NFC").toLowerCase() === name.normalize("NFC").toLowerCase(),
              );
            if (choice.duplicate === "skip" && duplicates.length) continue;
            let previous: SkillDefinition | undefined;
            if (choice.duplicate === "replace") {
              if (!choice.replaceSkillId || !choice.expectedRevision)
                throw new Error("Replacement requires a stable Skill identity and revision.");
              previous = await revision(choice.replaceSkillId, choice.expectedRevision);
              if (items.some((item) => item.skillId === previous?.skillId))
                throw new Error("Duplicate replacement target.");
            } else if (duplicates.length || items.some((item) => item.name === name))
              throw new Error(
                "Duplicate Skill name; skip, choose a new name, or replace an existing Skill.",
              );
            items.push(
              makeItem({
                pkg: pending.preview.package,
                entryPath: choice.entryPath,
                source: { ...pending.preview.source, entryPath: choice.entryPath },
                name,
                ...(previous ? { previous } : {}),
              }),
            );
          }
          if (items.length) {
            const renames = request.choices.filter(
              (choice) =>
                choice.name &&
                pending.preview.package.entries.find(
                  (entry) => entry.entryPath === choice.entryPath,
                )?.name !== choice.name &&
                items.some((item) => item.entryPath === choice.entryPath),
            );
            if (renames.length) {
              const owned = await fs.mkdtemp(path.join(staging, "rename-"));
              try {
                const original = await packages.materializePreview(pending.packagePreviewId, owned),
                  directory = path.join(owned, original.rootName);
                await fs.rename(path.join(owned, "content"), directory);
                for (const choice of renames)
                  await renameEntry(
                    path.join(directory, ...choice.entryPath.split("/")),
                    choice.name!,
                  );
                await packages.publishDirectory(directory, async (pkg) => {
                  await commit(
                    items.map((item) => ({
                      ...item,
                      packageId: pkg.packageId,
                      locallyModified: true,
                    })),
                    true,
                  );
                });
                const ids = new Set(items.map((item) => item.skillId));
                const stored = (await readSkillLibraryDefinitions(stateDir)).filter((item) =>
                  ids.has(item.skillId),
                );
                items.splice(0, items.length, ...stored);
              } finally {
                await fs.rm(owned, { recursive: true, force: true });
              }
            } else
              await packages.publishPreview(pending.packagePreviewId, async () =>
                commit(items, true),
              );
          }
          await cleanup(request.previewId);
          return { skills: items };
        }
        case "previewRefresh": {
          const skill = await revision(request.skillId, request.expectedRevision);
          if (
            skill.source.kind === "manual" ||
            (skill.source.kind === "archive" && !path.isAbsolute(skill.source.location))
          )
            throw new Error(
              "This Skill has no accessible refresh source; upload and replace its archive explicitly.",
            );
          return {
            preview: await previewSource(
              skill.source.location,
              skill.source.kind === "url"
                ? "url"
                : skill.source.kind === "runtime"
                  ? "runtime"
                  : "local",
              skill,
            ),
          };
        }
        case "refresh": {
          const current = await revision(request.skillId, request.expectedRevision),
            pending = await pendingPreview(request.previewId);
          if (pending.skillId !== current.skillId || pending.revision !== current.revision)
            throw new Error("Refresh preview belongs to a different Skill revision.");
          let skill!: SkillDefinition;
          await packages.publishPreview(pending.packagePreviewId, async (pkg) => {
            skill = makeItem({
              pkg,
              entryPath: current.source.entryPath,
              source: { ...pending.preview.source, entryPath: current.source.entryPath },
              previous: current,
            });
            await commit([skill], true);
          });
          await cleanup(request.previewId);
          return { skill };
        }
        case "readFile": {
          assertSkillResourcePath(request.path);
          const skill =
              request.expectedRevision === undefined
                ? await readSkillDefinition(stateDir, request.skillId)
                : await revision(request.skillId, request.expectedRevision),
            pkg = await packages.read(skill.packageId);
          if (
            !pkg.resources.some(
              (resource) => resource.kind === "file" && resource.path === `content/${request.path}`,
            )
          )
            throw new Error("File is not in the managed package.");
          const bytes = await expertResourceFiles.read(
              path.join(rootPath(skill.packageId), ...request.path.split("/")),
            ),
            text = bytes.toString("utf8");
          return {
            file: {
              path: request.path,
              content: bytes.toString("base64"),
              ...(Buffer.from(text).equals(bytes) && !text.includes("\0") ? { text } : {}),
            },
          };
        }
        case "previewDelete":
          await readSkillDefinition(stateDir, request.skillId);
          return { expertIds: await expertIds(request.skillId) };
        case "delete":
          await remove(request.skillId, request.expectedRevision, request.confirmExpertIds);
          return {};
        case "batch": {
          const results: NonNullable<SkillLibraryResponse["results"]>[number][] = [];
          for (const item of request.items) {
            try {
              if (item.operation === "delete")
                await remove(item.skillId, item.expectedRevision, item.confirmExpertIds ?? []);
              else if (item.operation === "previewRefresh") {
                const current = await revision(item.skillId, item.expectedRevision);
                if (
                  current.source.kind === "manual" ||
                  (current.source.kind === "archive" && !path.isAbsolute(current.source.location))
                )
                  throw new Error("This Skill requires an explicit replacement upload.");
                const preview = await previewSource(
                  current.source.location,
                  current.source.kind === "url"
                    ? "url"
                    : current.source.kind === "runtime"
                      ? "runtime"
                      : "local",
                  current,
                );
                results.push({
                  skillId: item.skillId,
                  success: true,
                  message: "Review the source replacement before confirming.",
                  preview,
                });
                continue;
              } else if (item.operation === "refresh") {
                const current = await revision(item.skillId, item.expectedRevision),
                  pending = await pendingPreview(item.previewId ?? "");
                if (pending.skillId !== current.skillId || pending.revision !== current.revision)
                  throw new Error("Refresh preview does not match this Skill revision.");
                await packages.publishPreview(pending.packagePreviewId, async (pkg) =>
                  commit(
                    [
                      makeItem({
                        pkg,
                        entryPath: current.source.entryPath,
                        source: { ...pending.preview.source, entryPath: current.source.entryPath },
                        previous: current,
                      }),
                    ],
                    true,
                  ),
                );
                await cleanup(pending.preview.previewId);
              } else {
                const current = await revision(item.skillId, item.expectedRevision);
                await commit([
                  Schema.decodeUnknownSync(SkillDefinition)({
                    ...current,
                    tags: item.tags ?? [],
                    revision: current.revision + 1,
                    updatedAt: new Date().toISOString(),
                  }),
                ]);
              }
              results.push({ skillId: item.skillId, success: true, message: "Completed" });
            } catch (error) {
              results.push({
                skillId: item.skillId,
                success: false,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          return { results };
        }
      }
    }).finally(() => {
      if (requestId) activePreviews.delete(requestId);
    });
  };
  return {
    execute,
    /** HTTP upload uses the same preview/commit flow and authenticated host ownership. */
    previewArchive: (bytes: Buffer, fileName: string): Promise<SkillLibraryResponse> =>
      lock(async () => {
        if (disposal) throw new Error("Skill library is closing; reconnect before continuing.");
        assertSkillResourcePath(fileName);
        if (fileName.includes("/")) throw new Error("Archive upload requires a file name.");
        await expire();
        if (previews.size >= 100) throw new Error("Too many pending Skill previews.");
        const owned = await fs.mkdtemp(path.join(staging, "upload-"));
        try {
          const directory = path.join(owned, "package");
          await fs.mkdir(directory, { mode: 0o700 });
          await extractSkillArchive(bytes, directory);
          const result = await packages.preview({ path: directory });
          const preview: SkillLibraryPreview = {
            previewId: randomUUID(),
            package: result.package,
            expiresAt: result.expiresAt,
            source: {
              kind: "archive",
              location: fileName,
              entryPath: result.package.entries[0]!.entryPath,
              packageId: result.package.packageId,
            },
            resourceChanges: [],
            overwritesLocalEdits: false,
          };
          previews.set(preview.previewId, {
            preview,
            packagePreviewId: result.previewId,
            ownedRoot: owned,
          });
          return { preview };
        } catch (error) {
          await fs.rm(owned, { recursive: true, force: true });
          throw error;
        }
      }),
    dispose: () => {
      if (disposal) return disposal;
      for (const controller of activePreviews.values()) controller.abort();
      disposal = lock(async () => {
        for (const id of [...previews.keys()]) await cleanup(id);
        libraryInstances.delete(path.resolve(stateDir));
      });
      return disposal;
    },
  };
}
