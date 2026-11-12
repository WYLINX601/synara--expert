import type { ExpertSkillSelection, SkillPackage } from "@synara/contracts";

export const BMAD_PRESET_COMMIT = "61e01f82644c4bb533750cfa0d6d61ab61d2cc9b";

export const BMAD_SHARED_METHODS = [
  "bmad",
  "bmad-advanced-elicitation",
  "bmad-party-mode",
  "bmad-customize",
  "bmad-review",
  "bmad-walkthrough",
] as const;

/** Reviewed menus/recommendations from the pinned upstream version. Role
 * recommendations are deliberately excluded; no recursive dependency install.
 */
export const BMAD_ROLE_PRESETS = [
  {
    id: "bmad-analyst",
    name: "Mary",
    role: "bmad-agent-analyst",
    workflows: [
      "bmad-brainstorming",
      "bmad-deep-recon",
      "bmad-prfaq",
      "bmad-product-brief",
      "bmad-project-context",
      "bmad-forge-idea",
    ],
  },
  { id: "bmad-pm", name: "John", role: "bmad-agent-pm", workflows: ["bmad-prd"] },
  { id: "bmad-po", name: "Sofia", role: "bmad-agent-po", workflows: [] },
  {
    id: "bmad-architect",
    name: "Winston",
    role: "bmad-agent-architect",
    workflows: ["bmad-architecture"],
  },
  {
    id: "bmad-dev",
    name: "Amelia",
    role: "bmad-agent-dev",
    workflows: [
      "bmad-build",
      "bmad-build-auto",
      "bmad-code-review",
      "bmad-qa-generate-e2e-tests",
      "bmad-retrospective",
    ],
  },
  { id: "bmad-ux", name: "Sally", role: "bmad-agent-ux-designer", workflows: ["bmad-ux"] },
] as const;

export function bmadPresetSelections(
  manifest: SkillPackage,
  expertId: string,
  options: { readonly allowMissing?: boolean } = {},
): ExpertSkillSelection[] {
  const preset = BMAD_ROLE_PRESETS.find((role) => role.id === expertId);
  if (!preset) throw new Error(`Unknown BMad role: ${expertId}`);
  return [...BMAD_SHARED_METHODS, ...preset.workflows].flatMap((name) => {
    const candidates = manifest.entries.filter((entry) => entry.name === name);
    if (candidates.length === 0 && options.allowMissing) return [];
    if (candidates.length !== 1 || candidates[0]!.entryPath !== `${name}/SKILL.md`)
      throw new Error(`BMad preset requires one original entry: ${name}/SKILL.md`);
    return [
      {
        packageId: manifest.packageId,
        entryPath: candidates[0]!.entryPath,
      },
    ];
  });
}
