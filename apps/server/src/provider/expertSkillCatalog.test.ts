import { describe, expect, it } from "vitest";

import type { ResolvedExpertSkillEntry } from "@synara/contracts";

import {
  buildExpertSkillInstructions,
  createExpertSkillApplication,
  expertSkillEntryId,
  renderExpertSkillCatalog,
  sha256Utf8,
} from "./expertSkillCatalog.ts";

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

  it("wraps full startup bodies with collision-safe delimiters and hashes the submitted catalog", () => {
    const entry = entries[0]!;
    const body = "Follow the review checklist.\n";
    const result = buildExpertSkillInstructions({
      snapshotId: "snapshot-fixed",
      entries: [entry],
      bodies: new Map([[expertSkillEntryId(entry), body]]),
    });

    expect(result.text).toContain(body);
    expect(result.text).toContain(`${Buffer.byteLength(body, "utf8")} UTF-8 bytes`);
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
      startupEntryIds: [
        "pkg_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#skills/review/SKILL.md",
      ],
      lifecycleGeneration: "generation-1",
    });
  });

  it("fails closed when rendered catalog plus startup bodies exceed 128 KiB", () => {
    const entry = entries[0]!;
    expect(() =>
      buildExpertSkillInstructions({
        snapshotId: "snapshot-fixed",
        entries: [entry],
        bodies: new Map([[expertSkillEntryId(entry), "x".repeat(128 * 1024)]]),
      }),
    ).toThrow(/128 KiB/u);
  });
});
