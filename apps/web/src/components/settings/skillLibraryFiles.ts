import type { SkillDefinition } from "@synara/contracts";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";

export const tagsFrom = (text: string) => [
  ...new Set(
    text
      .split(/[,，]/u)
      .map((tag) => tag.trim())
      .filter(Boolean),
  ),
];
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
export async function transfer(route: string, options?: RequestInit): Promise<Response> {
  const response = await fetch(resolveWsHttpUrl(route), { credentials: "include", ...options });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `HTTP ${response.status}`);
  }
  return response;
}
export const resourceParams = (skill: SkillDefinition, resourcePath: string) =>
  new URLSearchParams({
    skillId: skill.skillId,
    path: resourcePath,
    expectedRevision: String(skill.revision),
  });
