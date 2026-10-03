import { buildWorkbenchArtifact, parseWorkbenchBuildArgs } from "./lib/workbench-build.ts";
import { basename } from "node:path";

function printReport(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<number> {
  const request = parseWorkbenchBuildArgs(process.argv.slice(2));
  if (!request) {
    printReport({
      command: "workbench:build",
      status: "usage-error",
      stage: "argument-validation",
      exitCode: 2,
      retryAction:
        "use-build-with-flavor-source-sha-platform-arch-output-dir-and-optional-upstream-tag-sha-pair",
    });
    return 2;
  }
  const result = await buildWorkbenchArtifact(request);
  printReport({
    command: "workbench:build",
    status: result.manifest.status,
    stage: "artifact-and-manifest-written",
    exitCode: 0,
    manifestFile: basename(result.manifestPath),
    provenanceFile: basename(result.provenancePath),
    manifest: result.manifest,
    retryAction: "review-diagnostic-manifest-and-run-bound-candidate-verification",
  });
  return 0;
}

if (import.meta.main) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      printReport({
        command: "workbench:build",
        status: "build-rejected",
        stage: error instanceof Error ? error.message : "unexpected-error",
        exitCode: 1,
        retryAction: "inspect-source-identity-upstream-lineage-toolchain-and-output-path",
      });
      process.exitCode = 1;
    });
}
