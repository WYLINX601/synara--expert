import { describe, expect, it } from "vitest";
import { isProviderDirectoryEnvironmentVariable } from "./providerDirectoryPaths";

describe("provider directory environment relocation", () => {
  it("relocates only the driver's directory variables, never credentials or executable search paths", () => {
    for (const provider of ["codex", "claudeAgent", "pi", "omp", "cursor", "grok"]) {
      expect(isProviderDirectoryEnvironmentVariable(provider, "HOME")).toBe(true);
      expect(isProviderDirectoryEnvironmentVariable(provider, "XDG_STATE_HOME")).toBe(true);
      expect(isProviderDirectoryEnvironmentVariable(provider, "PATH")).toBe(false);
      expect(isProviderDirectoryEnvironmentVariable(provider, "API_KEY")).toBe(false);
    }
    expect(isProviderDirectoryEnvironmentVariable("codex", "CODEX_HOME")).toBe(true);
    expect(isProviderDirectoryEnvironmentVariable("claudeAgent", "CLAUDE_CONFIG_DIR")).toBe(true);
    expect(isProviderDirectoryEnvironmentVariable("claudeAgent", "CODEX_HOME")).toBe(false);
    expect(isProviderDirectoryEnvironmentVariable("omp", "PI_CODING_AGENT_SESSION_DIR")).toBe(true);
  });
});
