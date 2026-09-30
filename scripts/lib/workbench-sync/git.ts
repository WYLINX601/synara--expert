import { spawnProcessSync } from "@synara/shared/processRuntime";

export type GitResult = {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
};

export function runGit(cwd: string, args: readonly string[], timeout = 30_000): GitResult {
  const result = spawnProcessSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout,
  });

  return {
    ok: result.status === 0 && result.error === undefined,
    exitCode: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export function requireGitOutput(
  cwd: string,
  args: readonly string[],
  timeout?: number,
): string | null {
  const result = runGit(cwd, args, timeout);
  return result.ok ? result.stdout.trim() : null;
}
