import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RepositoryLockError } from "./lib/workbench-sync/state.ts";
import { resolveCandidateCheckout } from "./lib/workbench-sync/sync.ts";
import {
  bindWorkbenchCandidate,
  checkWorkbenchSyncWorkflow,
  parseMainRef,
  prepareWorkbenchCandidate,
  reportExitCode,
  statusWorkbenchSync,
  verifyWorkbenchCandidate,
} from "./lib/workbench-sync/workflow.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ParsedOptions = Map<string, string>;

function printReport(report: unknown): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseOptions(
  args: readonly string[],
  allowed: readonly string[],
  required: readonly string[],
): ParsedOptions | null {
  if (args.length % 2 !== 0) return null;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !allowed.includes(key) || !value || value.startsWith("--") || options.has(key))
      return null;
    options.set(key, value);
  }
  return required.every((key) => options.has(key)) ? options : null;
}

function usageError(command: string, retryAction: string): number {
  printReport({
    command,
    status: "usage-error",
    stage: "argument-validation",
    exitCode: null,
    retryAction,
  });
  return 2;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const options = parseOptions(args, ["--main-ref"], []);
    if (!options) return usageError("check", "use-check-with-an-optional-main-ref");
    const report = await checkWorkbenchSyncWorkflow({
      repoRoot: repositoryRoot,
      mainRef: parseMainRef(options),
    });
    printReport(report);
    return report.status === "network-failure" ? 1 : report.status === "selection-blocked" ? 2 : 0;
  }

  if (command === "prepare") {
    const options = parseOptions(
      args,
      ["--checkout", "--base", "--target-tag", "--target-sha", "--main-ref"],
      ["--checkout", "--base", "--target-tag", "--target-sha"],
    );
    if (!options) {
      return usageError(
        "prepare",
        "use-prepare-with-checkout-base-target-tag-target-sha-and-optional-main-ref",
      );
    }
    const report = await prepareWorkbenchCandidate({
      repoRoot: repositoryRoot,
      checkout: resolveCandidateCheckout(options.get("--checkout")!),
      baseSha: options.get("--base")!,
      targetTag: options.get("--target-tag")!,
      targetSha: options.get("--target-sha")!,
      ...(options.has("--main-ref") ? { mainRef: options.get("--main-ref")! } : {}),
    });
    printReport(report);
    return report.status === "candidate-ready" ? 0 : report.status === "prepare-failed" ? 1 : 2;
  }

  if (command === "bind") {
    const options = parseOptions(
      args,
      ["--checkout", "--base", "--target-tag", "--target-sha", "--candidate-sha", "--main-ref"],
      ["--checkout", "--base", "--target-tag", "--target-sha", "--candidate-sha"],
    );
    if (!options) {
      return usageError(
        "bind",
        "use-bind-with-checkout-base-target-tag-target-sha-candidate-sha-and-optional-main-ref",
      );
    }
    const report = await bindWorkbenchCandidate({
      repoRoot: repositoryRoot,
      checkout: resolveCandidateCheckout(options.get("--checkout")!),
      baseSha: options.get("--base")!,
      targetTag: options.get("--target-tag")!,
      targetSha: options.get("--target-sha")!,
      candidateSha: options.get("--candidate-sha")!,
      ...(options.has("--main-ref") ? { mainRef: options.get("--main-ref")! } : {}),
    });
    printReport(report);
    return report.status === "candidate-bound" ? 0 : 2;
  }

  if (command === "verify") {
    const options = parseOptions(
      args,
      ["--candidate-sha", "--runtime-evidence"],
      ["--candidate-sha"],
    );
    if (!options) {
      return usageError(
        "verify",
        "use-verify-with-candidate-sha-and-optional-runtime-evidence-file",
      );
    }
    const report = await verifyWorkbenchCandidate({
      repoRoot: repositoryRoot,
      candidateSha: options.get("--candidate-sha")!,
      ...(options.has("--runtime-evidence")
        ? { runtimeEvidencePath: resolveCandidateCheckout(options.get("--runtime-evidence")!) }
        : {}),
    });
    printReport(report);
    return reportExitCode(report as unknown as Record<string, unknown>);
  }

  if (command === "status") {
    if (args.length !== 0) return usageError("status", "use-status-without-options");
    const report = await statusWorkbenchSync({ repoRoot: repositoryRoot });
    printReport(report);
    return 0;
  }

  return usageError(command ?? "unknown", "use-workbench-sync-check-prepare-bind-verify-or-status");
}

const requestedCommand = process.argv[2] ?? "unknown";

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    if (error instanceof RepositoryLockError) {
      printReport({
        command: requestedCommand,
        status: error.state === "busy" ? "operation-busy" : "operation-lock-owner-unknown",
        stage: "repository-lock",
        exitCode: null,
        ...(error.owner ? { operation: error.owner.operation, pid: error.owner.pid } : {}),
        retryAction:
          error.state === "busy"
            ? "wait-for-the-active-sync-operation-to-finish"
            : "inspect-or-recover-the-operation-lock-manually",
      });
      process.exitCode = 2;
      return;
    }
    printReport({
      command: requestedCommand,
      status: "unexpected-error",
      stage: "command-execution",
      exitCode: null,
      retryAction: "inspect-local-git-and-filesystem-state-before-retrying",
    });
    process.exitCode = 1;
  });
