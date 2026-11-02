import { describe, expect, it } from "vitest";

import type { ResolvedExpertSkillEntry } from "@synara/contracts";

import {
  buildExpertSkillInstructions,
  createExpertSkillApplication,
  projectSelectedSkillReferences,
  renderExpertSkillCatalog,
  sha256Utf8,
} from "./expertSkillCatalog.ts";
import { FIXED_EXPERT_SKILL_POLICY, type ProviderExpertSession } from "@synara/contracts";

const packageId = `pkg_${"a".repeat(64)}`;
const entries: ResolvedExpertSkillEntry[] = [
  {
    packageId,
    entryPath: "skills/review/SKILL.md",
    activation: "startup",
    name: "review",
    description: "Review changes",
    path: "/state/experts/skill-packages/pkg/content/skills/review/SKILL.md",
  },
  {
    packageId,
    entryPath: "skills/plan/SKILL.md",
    activation: "on-demand",
    name: "plan",
    description: "Plan implementation",
    path: "/state/experts/skill-packages/pkg/content/skills/plan/SKILL.md",
  },
  {
    packageId,
    entryPath: "skills/private/SKILL.md",
    activation: "on-demand",
    name: "private",
    description: "Not discoverable by model invocation",
    path: "/state/experts/skill-packages/pkg/content/skills/private/SKILL.md",
    disableModelInvocation: true,
  },
];

describe("Expert skill index rendering", () => {
  it("lists fixed original entry identities, permits relevant on-demand selection, and hides disabled entries", () => {
    const catalog = renderExpertSkillCatalog("snapshot-fixed", entries);

    expect(catalog).toContain("snapshot-fixed");
    expect(catalog).toContain("skills/plan/SKILL.md");
    expect(catalog).toContain("when relevant to the user's request or explicitly invoked");
    expect(catalog).not.toContain("skills/private/SKILL.md");
    expect(catalog).toContain("untrusted data");
  });

  it("submits metadata only, including for historical startup entries, and hashes the catalog", () => {
    const entry = entries[0]!;
    const body = "Follow the review checklist.\n";
    const result = buildExpertSkillInstructions({
      snapshotId: "snapshot-fixed",
      entries: [entry],
    });

    expect(result.text).not.toContain(body);
    expect(result.text).not.toContain("activation");
    expect(result.text).toBe(result.catalogText);
    expect(result.catalogHash).toBe(sha256Utf8(result.catalogText));

    const session = {
      skillAssemblyId: "assembly-run-a",
      skillRootRunId: "root-run-a",
      snapshotId: "snapshot-fixed",
      persona: "Reviewer",
      skills: [],
      skillLoading: "index" as const,
      skillEntries: [entry],
      references: [],
    };
    const receipt = createExpertSkillApplication({
      session,
      instructions: result.text,
      lifecycleGeneration: "generation-1",
    });

    expect(receipt).toMatchObject({
      mode: "catalog",
      skillAssemblyId: "assembly-run-a",
      skillRootRunId: "root-run-a",
      snapshotId: "snapshot-fixed",
      packageIds: [packageId],
      catalogHash: result.catalogHash,
      instructionsHash: sha256Utf8(result.text),
      lifecycleGeneration: "generation-1",
    });
    expect(receipt).not.toHaveProperty("startupEntryIds");
  });

  it("fails closed when the rendered catalog exceeds 128 KiB", () => {
    const entry = entries[0]!;
    expect(() =>
      buildExpertSkillInstructions({
        snapshotId: "snapshot-fixed",
        entries: [{ ...entry, description: "x".repeat(128 * 1024) }],
      }),
    ).toThrow(/128 KiB/u);
  });
});

describe("explicit fixed Skill references", () => {
  const selected = entries[1]!;
  const session: ProviderExpertSession = {
    snapshotId: "snapshot-fixed",
    persona: "Expert",
    skills: [{ name: selected.name, path: selected.path }],
    skillEntries: [{ ...selected, resourceMode: "run-private" }],
    skillPolicy: FIXED_EXPERT_SKILL_POLICY,
    skillResourceRefs: [
      {
        packageId: selected.packageId,
        mode: "run-private",
        ownerRootRunId: "run-1",
        rootPath: "/state/experts/run-skill-resources/owner/pkg/content",
      },
    ],
    references: [],
  };
  const reference = {
    name: selected.name,
    path: selected.path,
    expert: {
      snapshotId: session.snapshotId,
      packageId: selected.packageId,
      entryPath: selected.entryPath,
    },
  };

  it("maps the pinned identity to the persistent Run-private path", () => {
    expect(projectSelectedSkillReferences(session, [reference])).toEqual([
      {
        ...reference,
        path: "/state/experts/run-skill-resources/owner/pkg/content/skills/plan/SKILL.md",
      },
    ]);
  });

  it("rejects unselected, foreign snapshot, and non-user-invocable chips", () => {
    expect(() =>
      projectSelectedSkillReferences(session, [
        {
          ...reference,
          expert: { ...reference.expert, entryPath: "skills/not-selected/SKILL.md" },
        },
      ]),
    ).toThrow(/not present/iu);
    expect(() =>
      projectSelectedSkillReferences(session, [
        { ...reference, expert: { ...reference.expert, snapshotId: "foreign" } },
      ]),
    ).toThrow(/does not belong/iu);
    expect(() =>
      projectSelectedSkillReferences(
        { ...session, skillEntries: [{ ...session.skillEntries![0]!, userInvocable: false }] },
        [reference],
      ),
    ).toThrow(/identity or invocation/iu);
  });

  it("preserves ordinary task references", () => {
    expect(
      projectSelectedSkillReferences(undefined, [{ name: "runtime", path: "/skills/runtime" }]),
    ).toEqual([{ name: "runtime", path: "/skills/runtime" }]);
  });
});
