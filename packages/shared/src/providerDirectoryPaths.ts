// Directory-valued provider environment inputs shared by copied settings and live bindings.
const COMMON_DIRECTORY_VARIABLES: Readonly<Record<string, true>> = {
  HOME: true,
  USERPROFILE: true,
  XDG_CACHE_HOME: true,
  XDG_CONFIG_HOME: true,
  XDG_DATA_HOME: true,
  XDG_STATE_HOME: true,
};

export function isProviderDirectoryEnvironmentVariable(provider: string, name: string): boolean {
  if (Object.hasOwn(COMMON_DIRECTORY_VARIABLES, name)) return true;
  switch (provider) {
    case "codex":
      return name === "CODEX_HOME" || name === "CODEX_SQLITE_HOME";
    case "claudeAgent":
      return name === "CLAUDE_CONFIG_DIR" || name === "CLAUDE_SECURESTORAGE_CONFIG_DIR";
    case "cursor":
      return name === "CURSOR_CONFIG_DIR";
    case "grok":
      return name === "GROK_HOME";
    case "pi":
    case "omp":
      return name === "PI_CODING_AGENT_DIR" || name === "PI_CODING_AGENT_SESSION_DIR";
    default:
      return false;
  }
}
