import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWorkbenchSync,
  prepareCandidate,
  readSyncLock,
  resolveCandidateCheckout,
} from "./lib/workbench-sync/sync.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = resolve(repositoryRoot, "workbench/upstream.lock.json");

function printReport(report: unknown): void {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function parseOptions(args: readonly string[]): Map<string, string> | null {
  if (args.length === 0 || args.length % 2 !== 0) return null;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      (key !== "--checkout" && key !== "--base") ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    ) {
      return null;
    }
    options.set(key, value);
  }
  return options;
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);
  let lock;
  try {
    lock = readSyncLock(lockPath);
  } catch (error) {
    printReport({
      command: command ?? "unknown",
      status: "configuration-error",
      reason: error instanceof Error ? error.message : "lock-file-invalid",
      stage: "lock-file-read",
      exitCode: null,
      retryAction: "repair-workbench-upstream-lock-json",
    });
    return 2;
  }

  if (command === "check" && args.length === 0) {
    const report = await checkWorkbenchSync({ repoRoot: repositoryRoot, lock });
    printReport(report);
    return report.status === "network-failure" ? 1 : report.status === "selection-blocked" ? 2 : 0;
  }

  if (command === "prepare") {
    const options = parseOptions(args);
    const checkoutArg = options?.get("--checkout");
    const baseSha = options?.get("--base");
    if (!checkoutArg || !baseSha || options?.size !== 2) {
      printReport({
        command: "prepare",
        status: "usage-error",
        stage: "argument-validation",
        exitCode: null,
        retryAction: "run-workbench-sync-prepare-with-explicit-checkout-and-base-sha",
      });
      return 2;
    }
    const report = prepareCandidate({
      checkout: resolveCandidateCheckout(checkoutArg),
      baseSha,
      targetTag: lock.candidate.tag,
      targetSha: lock.candidate.commit,
    });
    printReport(report);
    return report.status === "candidate-ready" ? 0 : report.status === "prepare-failed" ? 1 : 2;
  }

  printReport({
    command: command ?? "unknown",
    status: "usage-error",
    stage: "command-dispatch",
    exitCode: null,
    retryAction: "use-workbench-sync-check-or-workbench-sync-prepare",
  });
  return 2;
}

const requestedCommand = process.argv[2] ?? "unknown";

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch(() => {
    printReport({
      command: requestedCommand,
      status: "unexpected-error",
      stage:
        requestedCommand === "check"
          ? "check-execution"
          : requestedCommand === "prepare"
            ? "prepare-execution"
            : "command-dispatch",
      exitCode: null,
      retryAction: "inspect-local-git-and-filesystem-state-before-retrying",
    });
    process.exitCode = 1;
  });
