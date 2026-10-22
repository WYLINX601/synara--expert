import type {
  ExpertSkillSelection,
  ProviderSkillReference,
  SkillPackage,
  SkillPackagePreview,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ExpertClient } from "~/workbench/host/expertClient";
import {
  choiceKey,
  choicesForExpert,
  resolveSkillChoices,
  type SkillPickerChoice,
} from "./skillPickerModel";

const packageId = (letter: string) => `pkg_${letter.repeat(64)}`;

function makeEntry(
  entryPath: string,
  name: string,
  extra: Partial<SkillPackage["entries"][number]> = {},
): SkillPackage["entries"][number] {
  return { entryPath, name, description: `${name} description`, issues: [], ...extra };
}

function makePackage(
  id: string,
  entries: SkillPackage["entries"],
  resources: SkillPackage["resources"] = [],
): SkillPackage {
  return {
    schemaVersion: 1,
    packageId: id,
    rootName: "skills",
    resources,
    entries,
    fileCount: resources.filter((resource) => resource.kind === "file").length,
    totalBytes: resources.reduce((sum, resource) => sum + resource.size, 0),
  };
}

function makePreview(
  manifest: SkillPackage,
  sourcePath: string,
  realRoot = sourcePath,
  previewId = `preview-${manifest.packageId}`,
): SkillPackagePreview {
  return {
    previewId,
    sourcePath,
    realRoot,
    expiresAt: "2026-10-22T00:00:00.000Z",
    package: manifest,
    issues: [],
  };
}

function makeClient(
  args: {
    packages?: ReadonlyArray<SkillPackage>;
    previews?: ReadonlyArray<SkillPackagePreview>;
    readSkillPackage?: (packageId: string) => Promise<SkillPackage>;
    previewSkillPackage?: (path: string) => Promise<SkillPackagePreview>;
    importSkillPackage?: (previewId: string) => Promise<SkillPackage>;
  } = {},
) {
  const packageMap = new Map(
    (args.packages ?? []).map((manifest) => [manifest.packageId, manifest]),
  );
  const previewMap = new Map((args.previews ?? []).map((preview) => [preview.previewId, preview]));
  const readSkillPackage = vi.fn(async ({ packageId: id }: { packageId: string }) => {
    if (args.readSkillPackage) return args.readSkillPackage(id);
    const manifest = packageMap.get(id);
    if (!manifest) throw new Error(`Package unavailable: ${id}`);
    return manifest;
  });
  const previewSkillPackage = vi.fn(async ({ path }: { path: string }) => {
    if (args.previewSkillPackage) return args.previewSkillPackage(path);
    const preview = (args.previews ?? []).find((item) => item.sourcePath === path);
    if (!preview) throw new Error(`No preview for path: ${path}`);
    return preview;
  });
  const importSkillPackage = vi.fn(async ({ previewId: id }: { previewId: string }) => {
    if (args.importSkillPackage)
      return { package: await args.importSkillPackage(id), source: {} as never, reused: false };
    const preview = previewMap.get(id);
    if (!preview) throw new Error(`Preview unavailable: ${id}`);
    return { package: preview.package, source: {} as never, reused: false };
  });
  const client = {
    readSkillPackage,
    previewSkillPackage,
    importSkillPackage,
  } as unknown as Pick<
    ExpertClient,
    "previewSkillPackage" | "importSkillPackage" | "readSkillPackage"
  >;
  return { client, readSkillPackage, previewSkillPackage, importSkillPackage };
}

function packageChoice(
  manifest: SkillPackage,
  entryPath: string,
  activation: ExpertSkillSelection["activation"] = "on-demand",
): SkillPickerChoice {
  return {
    kind: "package",
    selection: { packageId: manifest.packageId, entryPath, activation },
  };
}

describe("skillPickerModel", () => {
  it("prefers V2 selections including an empty array and clones the selected representation", () => {
    const legacy: ProviderSkillReference = { name: "planner", path: "/skills/planner/SKILL.md" };
    const selected: ExpertSkillSelection = {
      packageId: packageId("a"),
      entryPath: "planner/SKILL.md",
      activation: "startup",
    };

    expect(choicesForExpert({ skills: [legacy], skillSelections: [] })).toEqual([]);
    const legacyChoices = choicesForExpert({ skills: [legacy], skillSelections: undefined });
    expect(legacyChoices).toEqual([{ kind: "path", reference: legacy }]);
    expect(legacyChoices[0]).not.toBe(legacy);
    expect(choicesForExpert({ skills: [legacy], skillSelections: [selected] })).toEqual([
      { kind: "package", selection: selected },
    ]);
    expect(
      choiceKey({ kind: "path", reference: { name: "x", path: "/skills/./planner/SKILL.md" } }),
    ).toBe(
      choiceKey({ kind: "path", reference: { name: "y", path: "\\skills\\planner\\SKILL.md" } }),
    );
    expect(choiceKey(packageChoice(makePackage(packageId("a"), []), "planner/SKILL.md"))).toMatch(
      /^package:/u,
    );
  });

  it("deduplicates legacy paths after separator and dot-segment normalization", async () => {
    const manifest = makePackage(packageId("a"), [makeEntry("SKILL.md", "planner")]);
    const preview = makePreview(manifest, "/skills/planner/SKILL.md", "/skills/planner");
    const harness = makeClient({ previews: [preview] });
    const choices: SkillPickerChoice[] = [
      { kind: "path", reference: { name: "planner", path: "/skills/planner/SKILL.md" } },
      {
        kind: "path",
        reference: { name: "planner alias", path: "\\skills\\planner\\.\\SKILL.md" },
      },
    ];

    await expect(resolveSkillChoices(choices, harness.client)).resolves.toEqual([
      { packageId: manifest.packageId, entryPath: "SKILL.md", activation: "on-demand" },
    ]);
    expect(harness.previewSkillPackage).toHaveBeenCalledTimes(1);
    expect(harness.importSkillPackage).toHaveBeenCalledTimes(1);
  });

  it("imports a single SKILL.md package while retaining its shared resources", async () => {
    const resources: SkillPackage["resources"] = [
      { path: "content/SKILL.md", kind: "file", size: 20, sha256: "a".repeat(64) },
      { path: "content/scripts/run.ts", kind: "file", size: 30, sha256: "b".repeat(64) },
      { path: "content/nested/SKILL.md", kind: "file", size: 15, sha256: "c".repeat(64) },
    ];
    const manifest = makePackage(
      packageId("b"),
      [makeEntry("SKILL.md", "root skill"), makeEntry("nested/SKILL.md", "nested skill")],
      resources,
    );
    const preview = makePreview(manifest, "/skills/root/SKILL.md", "/skills/root");
    const harness = makeClient({ previews: [preview] });

    await expect(
      resolveSkillChoices(
        [{ kind: "path", reference: { name: "root skill", path: "/skills/root/SKILL.md" } }],
        harness.client,
      ),
    ).resolves.toEqual([
      { packageId: manifest.packageId, entryPath: "SKILL.md", activation: "on-demand" },
    ]);
    expect(harness.importSkillPackage).toHaveBeenCalledWith({
      previewId: preview.previewId,
      idempotencyKey: preview.previewId,
    });
    expect(manifest.resources).toHaveLength(3);
  });

  it("rejects an ambiguous directory before importing it", async () => {
    const manifest = makePackage(packageId("c"), [
      makeEntry("planner/SKILL.md", "planner"),
      makeEntry("reviewer/SKILL.md", "reviewer"),
    ]);
    const preview = makePreview(manifest, "/skills", "/skills");
    const harness = makeClient({ previews: [preview] });

    await expect(
      resolveSkillChoices(
        [{ kind: "path", reference: { name: "skills", path: "/skills" } }],
        harness.client,
      ),
    ).rejects.toThrow("该目录包含多个技能，请在路径预览中选择具体入口。");
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("reads an existing package without importing it and preserves its activation", async () => {
    const manifest = makePackage(packageId("d"), [makeEntry("planner/SKILL.md", "planner")]);
    const harness = makeClient({ packages: [manifest] });
    const selection: ExpertSkillSelection = {
      packageId: manifest.packageId,
      entryPath: "planner/SKILL.md",
      activation: "on-demand",
    };

    await expect(
      resolveSkillChoices([{ kind: "package", selection }], harness.client),
    ).resolves.toEqual([selection]);
    expect(harness.readSkillPackage).toHaveBeenCalledWith({ packageId: manifest.packageId });
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("uses prepared previews for package choices and imports each package once", async () => {
    const manifest = makePackage(packageId("e"), [
      makeEntry("planner/SKILL.md", "planner"),
      makeEntry("reviewer/SKILL.md", "reviewer"),
    ]);
    const preview = makePreview(manifest, "/skills", "/skills", "prepared-e");
    const harness = makeClient({ previews: [preview] });
    const choices = [
      packageChoice(manifest, "planner/SKILL.md"),
      packageChoice(manifest, "reviewer/SKILL.md"),
    ];

    await expect(
      resolveSkillChoices(choices, harness.client, new Map([[manifest.packageId, preview]])),
    ).resolves.toEqual([
      { packageId: manifest.packageId, entryPath: "planner/SKILL.md", activation: "on-demand" },
      { packageId: manifest.packageId, entryPath: "reviewer/SKILL.md", activation: "on-demand" },
    ]);
    expect(harness.readSkillPackage).not.toHaveBeenCalled();
    expect(harness.previewSkillPackage).not.toHaveBeenCalled();
    expect(harness.importSkillPackage).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable or incompatible entries before importing", async () => {
    const manifest = makePackage(packageId("f"), [
      makeEntry("planner/SKILL.md", "planner", { incompatibleReason: "unsupported runtime field" }),
    ]);
    const harness = makeClient({ packages: [manifest] });
    await expect(
      resolveSkillChoices([packageChoice(manifest, "missing/SKILL.md")], harness.client),
    ).rejects.toThrow(/不存在所选入口/iu);
    await expect(
      resolveSkillChoices([packageChoice(manifest, "planner/SKILL.md")], harness.client),
    ).rejects.toThrow(/技能 planner 不兼容/iu);
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("rejects normalized duplicate names across package versions", async () => {
    const oldVersion = makePackage(packageId("1"), [makeEntry("planner/SKILL.md", "Plánner")]);
    const newVersion = makePackage(packageId("2"), [
      makeEntry("planner/SKILL.md", "Pla\u0301nner"),
    ]);
    const harness = makeClient({ packages: [oldVersion, newVersion] });

    await expect(
      resolveSkillChoices(
        [
          packageChoice(oldVersion, "planner/SKILL.md"),
          packageChoice(newVersion, "planner/SKILL.md"),
        ],
        harness.client,
      ),
    ).rejects.toThrow(/名称不能重复/iu);
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("allows one eligible startup entry and rejects disabled or multiple startup entries", async () => {
    const eligible = makePackage(packageId("3"), [makeEntry("planner/SKILL.md", "planner")]);
    const disabled = makePackage(packageId("4"), [
      makeEntry("blocked/SKILL.md", "blocked", { disableModelInvocation: true }),
    ]);
    const other = makePackage(packageId("5"), [makeEntry("reviewer/SKILL.md", "reviewer")]);
    const harness = makeClient({ packages: [eligible, disabled, other] });

    await expect(
      resolveSkillChoices([packageChoice(eligible, "planner/SKILL.md", "startup")], harness.client),
    ).resolves.toEqual([
      { packageId: eligible.packageId, entryPath: "planner/SKILL.md", activation: "startup" },
    ]);
    await expect(
      resolveSkillChoices([packageChoice(disabled, "blocked/SKILL.md", "startup")], harness.client),
    ).rejects.toThrow(/不能设为启动时加载/iu);
    await expect(
      resolveSkillChoices(
        [
          packageChoice(eligible, "planner/SKILL.md", "startup"),
          packageChoice(other, "reviewer/SKILL.md", "startup"),
        ],
        harness.client,
      ),
    ).rejects.toThrow(/最多设置一个启动时加载的技能/iu);
  });

  it("stops after a preview completes for a stale selection", async () => {
    const manifest = makePackage(packageId("6"), [makeEntry("SKILL.md", "planner")]);
    const preview = makePreview(manifest, "/skills/planner/SKILL.md", "/skills/planner");
    let current = true;
    const harness = makeClient({
      previewSkillPackage: async () => {
        current = false;
        return preview;
      },
    });

    await expect(
      resolveSkillChoices(
        [{ kind: "path", reference: { name: "planner", path: "/skills/planner/SKILL.md" } }],
        harness.client,
        new Map(),
        () => current,
      ),
    ).rejects.toThrow("当前技能选择已失效，请重试。");
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("stops after a prepared import completes for a stale selection", async () => {
    const manifest = makePackage(packageId("7"), [makeEntry("planner/SKILL.md", "planner")]);
    const preview = makePreview(manifest, "/skills", "/skills", "prepared-7");
    let current = true;
    const harness = makeClient({
      previews: [preview],
      importSkillPackage: async () => {
        current = false;
        return manifest;
      },
    });

    await expect(
      resolveSkillChoices(
        [packageChoice(manifest, "planner/SKILL.md")],
        harness.client,
        new Map([[manifest.packageId, preview]]),
        () => current,
      ),
    ).rejects.toThrow("当前技能选择已失效，请重试。");
  });

  it("propagates import failures without returning a partial selection", async () => {
    const manifest = makePackage(packageId("8"), [makeEntry("SKILL.md", "planner")]);
    const preview = makePreview(manifest, "/skills/planner/SKILL.md", "/skills/planner");
    const failure = new Error("import unavailable");
    const harness = makeClient({
      previewSkillPackage: async () => preview,
      importSkillPackage: async () => {
        throw failure;
      },
    });

    await expect(
      resolveSkillChoices(
        [{ kind: "path", reference: { name: "planner", path: "/skills/planner/SKILL.md" } }],
        harness.client,
      ),
    ).rejects.toBe(failure);
  });

  it("rejects more than 100 unique choices before making RPC calls", async () => {
    const harness = makeClient();
    const choices = Array.from({ length: 101 }, (_, index) => ({
      kind: "package" as const,
      selection: {
        packageId: packageId("a"),
        entryPath: `skill-${index}/SKILL.md`,
        activation: "on-demand" as const,
      },
    }));

    await expect(resolveSkillChoices(choices, harness.client)).rejects.toThrow(
      /最多选择 100 个技能/iu,
    );
    expect(harness.readSkillPackage).not.toHaveBeenCalled();
  });

  it("rejects fixed Expert snapshot references without reading their display path", async () => {
    const harness = makeClient();
    const fixedReference: ProviderSkillReference = {
      name: "copied expert skill",
      path: "/display/path/is/not/authoritative/SKILL.md",
      expert: {
        snapshotId: "snapshot-fixed",
        packageId: packageId("9"),
        entryPath: "planner/SKILL.md",
      },
    };

    await expect(
      resolveSkillChoices([{ kind: "path", reference: fixedReference }], harness.client),
    ).rejects.toThrow(
      "固定 Expert 快照引用不能按本机路径转换为技能包，请改为选择原 Expert 或技能包。",
    );
    expect(harness.previewSkillPackage).not.toHaveBeenCalled();
    expect(harness.importSkillPackage).not.toHaveBeenCalled();
  });

  it("collapses a path and package choice for the same entry, preserving package activation", async () => {
    const manifest = makePackage(packageId("a"), [makeEntry("SKILL.md", "planner")]);
    const preview = makePreview(manifest, "/skills/planner/SKILL.md", "/skills/planner");
    const harness = makeClient({ packages: [manifest], previews: [preview] });

    await expect(
      resolveSkillChoices(
        [
          { kind: "path", reference: { name: "planner", path: "/skills/planner/SKILL.md" } },
          packageChoice(manifest, "SKILL.md", "startup"),
        ],
        harness.client,
      ),
    ).resolves.toEqual([
      { packageId: manifest.packageId, entryPath: "SKILL.md", activation: "startup" },
    ]);
    expect(harness.importSkillPackage).toHaveBeenCalledTimes(1);
  });
});
