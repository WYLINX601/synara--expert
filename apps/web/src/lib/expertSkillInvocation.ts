import type { NativeApi, ProviderSkillReference, ThreadId } from "@synara/contracts";

/** Draft-only marker; never sent to the provider or accepted by the server. */
export const PENDING_EXPERT_SKILL_SNAPSHOT = "pending";

export async function bindDraftExpertSkillInvocations(
  api: Pick<NativeApi, "orchestration" | "server">,
  threadId: ThreadId,
  skills: ReadonlyArray<ProviderSkillReference>,
): Promise<ProviderSkillReference[]> {
  if (!skills.some((skill) => skill.expert?.snapshotId === PENDING_EXPERT_SKILL_SNAPSHOT))
    return [...skills];
  const detail = await api.orchestration.getThreadDetailSnapshot({ threadId });
  const binding = detail?.thread.expertBinding;
  if (!binding) throw new Error("专家任务尚未固定版本，请重试。");
  const snapshot = await api.server.readExpertSnapshot({ snapshotId: binding.snapshotId });
  return skills.map((skill) => {
    if (skill.expert?.snapshotId !== PENDING_EXPERT_SKILL_SNAPSHOT) return skill;
    const selected = snapshot.skillEntries?.find(
      (entry) =>
        entry.packageId === skill.expert?.packageId && entry.entryPath === skill.expert.entryPath,
    );
    if (!selected || selected.userInvocable === false)
      throw new Error(`技能 ${skill.name} 不在本任务的固定配置中，请重新选择。`);
    return {
      name: selected.name,
      path: `synara-expert-skill:${selected.packageId}#${selected.entryPath}`,
      expert: {
        snapshotId: snapshot.snapshotId,
        packageId: selected.packageId,
        entryPath: selected.entryPath,
      },
    };
  });
}
