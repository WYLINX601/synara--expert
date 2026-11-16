import { Schema } from "effect";
import { LinxUpdateInstallRequest, type LinxUpdateHelperResponse } from "@synara/contracts";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createLinxDarwinHelperPlatform } from "./linxUpdateHelperPlatform";
import {
  LinxUpdateHelperCore,
  validateLinxUpdateHelperStartup,
  readLinxHelperAttempt,
} from "./linxUpdateHelperCore";
import { recoverLinxUpdateHelperAttempt } from "./linxUpdateHelperRecovery";
import {
  LINX_HELPER_FILES,
  readPrivateJson,
  requirePrivateDirectory,
} from "./linxUpdateHelperFiles";
import { linxUpdateFailureReason } from "./linxUpdateFailure";

declare const __LINX_UPDATE_SOURCE_JSON__: string;

export async function runLinxUpdateHelper(args: readonly string[]): Promise<void> {
  if (
    !(
      (args.length === 2 && (args[0] === "--attempt" || args[0] === "--recover")) ||
      (args.length === 3 && (args[0] === "--validate-startup" || args[0] === "--resume-startup"))
    )
  )
    throw new Error("Invalid helper entry arguments");
  if (typeof __LINX_UPDATE_SOURCE_JSON__ !== "string")
    throw new Error("Helper has no embedded public trust root");
  const attemptPath = args[1]!;
  await requirePrivateDirectory(attemptPath);
  const request = Schema.decodeUnknownSync(LinxUpdateInstallRequest)(
    await readPrivateJson(join(attemptPath, LINX_HELPER_FILES.request)),
  );
  const platform = await createLinxDarwinHelperPlatform(attemptPath, __LINX_UPDATE_SOURCE_JSON__);
  const core = new LinxUpdateHelperCore({
    attemptPath,
    sourceJson: __LINX_UPDATE_SOURCE_JSON__,
    platform,
  });
  if (args[0] === "--resume-startup") {
    const pid = Number(args[2]);
    if (!Number.isSafeInteger(pid) || pid !== process.ppid)
      throw new Error("Startup recovery must be invoked by the claiming new application");
    const validated = await core.resumeStartup(pid);
    process.stdout.write(`${JSON.stringify(validated)}\n`);
    await core.finishResumedStartup(validated.request);
    return;
  }
  if (args[0] === "--validate-startup") {
    const pid = Number(args[2]);
    if (!Number.isSafeInteger(pid) || pid !== process.ppid)
      throw new Error("Startup validator must be invoked by the claiming new application");
    const attempt = await readLinxHelperAttempt(attemptPath, __LINX_UPDATE_SOURCE_JSON__);
    const result = await validateLinxUpdateHelperStartup({
      attemptPath,
      sourceJson: __LINX_UPDATE_SOURCE_JSON__,
      platform,
      pid,
      applicationPath: attempt.request.applicationPath,
      homePath: attempt.request.homePath,
      userDataPath: attempt.request.userDataPath,
      version: attempt.manifest.version,
      sourceCommit: attempt.manifest.sourceCommit,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args[0] === "--recover") {
    const journal = await recoverLinxUpdateHelperAttempt({
      attemptPath,
      sourceJson: __LINX_UPDATE_SOURCE_JSON__,
      platform,
    });
    process.stdout.write(`${JSON.stringify(journal)}\n`);
    return;
  }
  await core.initialize();
  let pending = "";
  const decoder = new StringDecoder("utf8");
  let installation: Promise<void> | null = null;
  const reply = (value: LinxUpdateHelperResponse) =>
    process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    for await (const bytes of process.stdin) {
      pending += decoder.write(bytes);
      if (Buffer.byteLength(pending) > 64 * 1024)
        throw new Error("Private IPC command exceeds bound");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          reply(await core.command(JSON.parse(line)));
        } catch (error) {
          // Never echo untrusted input or nonce-bearing schema errors to any stream.
          reply({
            schemaVersion: 1,
            attemptId: request.attemptId,
            manifestDigest: request.manifestDigest,
            helperPid: process.pid,
            status: "failed",
            failure: linxUpdateFailureReason(error) ?? "failed",
          });
        }
        if (core.isCommitted() && installation === null) {
          installation = core.installAfterParentExit();
          // Keep consuming authenticated cancel commands until actual parent death.
          void installation.then(
            () => process.stdin.destroy(),
            () => process.stdin.destroy(),
          );
        }
        if (core.isTerminal()) return;
      }
    }
  } finally {
    await core.disconnected();
    if (installation) await installation;
  }
}
if (import.meta.main) {
  runLinxUpdateHelper(process.argv.slice(2)).catch(() => {
    process.stderr.write(
      "Linx update helper stopped. Preserve this attempt and its verified recovery set; consult its installation journal before reopening an older version.\n",
    );
    process.exitCode = 1;
  });
}
