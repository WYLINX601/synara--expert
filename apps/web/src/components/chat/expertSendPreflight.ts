import type {
  ExpertPreview,
  ExpertPreviewInput,
  ProviderInstanceId,
  ProviderKind,
} from "@synara/contracts";
import { isExpertProvider } from "@synara/shared/expertProviders";

export async function expertSendBlockReason(
  previewExpert: (input: ExpertPreviewInput) => Promise<ExpertPreview>,
  expertId: string,
  provider: ProviderKind,
  providerInstanceId?: ProviderInstanceId,
  cwd?: string | null,
): Promise<string | null> {
  if (!isExpertProvider(provider)) {
    return "当前 Provider 不支持所选专家。请切换到支持专家的 Provider，或选择“通用”后再发送。";
  }

  try {
    const preview = await previewExpert({
      expertId,
      provider,
      ...(providerInstanceId ? { providerInstanceId } : {}),
      ...(cwd ? { cwd } : {}),
    });
    if (preview.status !== "blocked" && preview.status !== "incompatible") return null;
    return preview.issues.length > 0
      ? `所选专家当前无法使用：${preview.issues.join("；")}`
      : "所选专家当前无法用于此 Provider，请切换专家或选择“通用”后重试。";
  } catch (error) {
    return `无法检查所选专家：${error instanceof Error ? error.message : String(error)}`;
  }
}
