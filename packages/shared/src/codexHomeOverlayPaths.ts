import { createHash } from "node:crypto";
import path from "node:path";
import { homedir } from "node:os";
import { expandProviderAccountHomePath } from "./providerAccountHomePath";

export function resolveBaseCodexHomePath(
  env: NodeJS.ProcessEnv,
  explicitHomePath?: string,
): string {
  return expandProviderAccountHomePath(
    explicitHomePath?.trim() || env.CODEX_HOME?.trim() || path.join(homedir(), ".codex"),
  );
}

export const SYNARA_CODEX_HOME_OVERLAY_DIR = "codex-home-overlay";
export const SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR = "accounts";
export const SYNARA_CODEX_HOME_FIXED_EXPERT_DIR = "fixed-expert-native";

export function resolveSynaraCodexHomeOverlayPath(
  env: NodeJS.ProcessEnv,
  sourceHomePath: string,
  accountSegment?: string,
  fixedExpertNativeDiscovery = false,
): string {
  const runtimeHome = env.SYNARA_HOME?.trim();
  const overlayRoot = runtimeHome || path.join(path.dirname(sourceHomePath), ".synara", "runtime");
  const overlayHome = path.join(overlayRoot, SYNARA_CODEX_HOME_OVERLAY_DIR);
  const accountOverlay = accountSegment
    ? path.join(overlayHome, SYNARA_CODEX_HOME_ACCOUNT_OVERLAYS_DIR, accountSegment)
    : overlayHome;
  return fixedExpertNativeDiscovery
    ? path.join(accountOverlay, SYNARA_CODEX_HOME_FIXED_EXPERT_DIR)
    : accountOverlay;
}

export function resolveCodexHomeOverlayAccountSegment(input: {
  readonly accountId?: string;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
}): string | undefined {
  const accountId = input.accountId?.trim();
  const shadowHomePath = input.shadowHomePath?.trim();
  if ((!accountId || accountId === "default") && !shadowHomePath) {
    return undefined;
  }

  const label = (accountId || "shadow").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 32) || "codex";
  const digest = createHash("sha256")
    .update(accountId ?? "")
    .update("\0")
    .update(input.homePath ?? "")
    .update("\0")
    .update(shadowHomePath ?? "")
    .digest("hex")
    .slice(0, 12);
  return `${label}-${digest}`;
}
