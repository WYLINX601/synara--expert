/**
 * Exact-build compatibility for OMP ACP task updates delivered while idle.
 *
 * @module OmpAcpIdleTaskCompat
 */
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import * as nodePath from "node:path";

import { resolveExecutable } from "@synara/shared/executable";

export const OMP_ACP_IDLE_TASK_COMPAT_VERSION = "v1" as const;
export const OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256 =
  "c5d51fbb4d787035f3cec7b3579234de4c55b169574a094e2a672bb68970992d" as const;
export const OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SIZE = 17_638_974;
export const OMP_ACP_IDLE_TASK_COMPAT_CLI_VERSION = "18.12.1" as const;
export const OMP_ACP_IDLE_TASK_COMPAT_MARKER_TIMEOUT_MS = 3_000;
export const OMP_ACP_IDLE_TASK_COMPAT_MARKER =
  `SYNARA_OMP_ACP_IDLE_TASK_COMPAT ${OMP_ACP_IDLE_TASK_COMPAT_VERSION} sha256=${OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256}` as const;

const OMP_ACP_IDLE_TASK_COMPAT_ANCHOR =
  'async#k(e,t){if(t.type!=="thinking_level_changed"&&t.type!=="model_changed")return;';
const OMP_ACP_IDLE_TASK_COMPAT_PRELOAD_FILENAME = "omp-acp-idle-task-compat.mjs";

export interface OmpAcpIdleTaskCompatLaunch {
  readonly bunExecutable: string;
  /** Canonical, verified CLI source path launched with the same OMP behavior. */
  readonly cliEntrypoint: string;
  readonly preloadPath: string;
  readonly expectedMarker: string;
}

export interface OmpAcpIdleTaskCompatPreparationInput {
  readonly cliBinaryPath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly privateTempDirectory: string;
  readonly platform?: NodeJS.Platform;
}

export function makeOmpAcpIdleTaskCompatArgs(
  launch: OmpAcpIdleTaskCompatLaunch,
  cliArgs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return ["--preload", launch.preloadPath, launch.cliEntrypoint, ...cliArgs];
}

/** Resolves PATH using the exact cwd and environment inherited by the child. */
export function resolveOmpAcpIdleTaskCompatExecutablePath(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const resolved = resolveExecutable(command, { platform, env, cwd });
  if (!resolved) return undefined;
  const pathApi = platform === "win32" ? nodePath.win32 : nodePath;
  return pathApi.resolve(cwd, resolved);
}

/** Creates a launch descriptor that names the verified canonical source path. */
export function makeOmpAcpIdleTaskCompatLaunch(input: {
  readonly bunExecutable: string;
  readonly canonicalSourcePath: string;
  readonly preloadPath: string;
}): OmpAcpIdleTaskCompatLaunch {
  return {
    bunExecutable: input.bunExecutable,
    cliEntrypoint: input.canonicalSourcePath,
    preloadPath: input.preloadPath,
    expectedMarker: OMP_ACP_IDLE_TASK_COMPAT_MARKER,
  };
}

/**
 * Resolve and verify the selected OMP entry point, then create a private Bun
 * preload. The launch continues to execute this exact CLI source file.
 */
export async function prepareOmpAcpIdleTaskCompat(
  input: OmpAcpIdleTaskCompatPreparationInput,
): Promise<OmpAcpIdleTaskCompatLaunch> {
  const platform = input.platform ?? process.platform;
  const cliEntrypoint = resolveSelectedOmpEntrypoint(
    input.cliBinaryPath,
    input.cwd,
    input.env,
    platform,
  );
  const sourcePath = await realpath(cliEntrypoint).catch(() => undefined);
  if (!sourcePath) {
    throw new Error("OMP idle-task compatibility cannot verify the selected CLI entry point.");
  }
  const source = await readFile(sourcePath);
  verifyOmpAcpIdleTaskBundle(source);
  if (source.subarray(0, source.indexOf(0x0a)).toString("utf8") !== "#!/usr/bin/env bun") {
    throw new Error("OMP idle-task compatibility requires the verified Bun CLI shebang.");
  }

  const bunExecutable = resolveOmpAcpIdleTaskCompatExecutablePath(
    "bun",
    input.cwd,
    input.env,
    platform,
  );
  if (!bunExecutable) {
    throw new Error(
      "OMP idle-task compatibility cannot resolve Bun from the selected account PATH.",
    );
  }

  const preloadPath = nodePath.join(
    input.privateTempDirectory,
    OMP_ACP_IDLE_TASK_COMPAT_PRELOAD_FILENAME,
  );
  const preload = buildOmpAcpIdleTaskCompatPreload(sourcePath);
  await writeFile(preloadPath, preload, { encoding: "utf8", mode: 0o400, flag: "wx" });
  return makeOmpAcpIdleTaskCompatLaunch({
    bunExecutable,
    canonicalSourcePath: sourcePath,
    preloadPath,
  });
}

export function verifyOmpAcpIdleTaskCompatProbe(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly expectedMarker: string;
}): boolean {
  return (
    input.exitCode === 0 &&
    input.stdout.trim() === `omp/${OMP_ACP_IDLE_TASK_COMPAT_CLI_VERSION}` &&
    input.stderr.split(/\r?\n/u).some((line) => line.trim() === input.expectedMarker)
  );
}

/** Testable exact-source gate; production callers use the constants above. */
export function verifyOmpAcpIdleTaskBundle(
  source: Uint8Array,
  expected: { readonly sha256?: string; readonly size?: number } = {},
): void {
  const expectedSha256 = expected.sha256 ?? OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256;
  const expectedSize = expected.size ?? OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SIZE;
  if (source.byteLength !== expectedSize) {
    throw new Error("OMP idle-task compatibility does not support this CLI bundle size.");
  }
  const actualSha256 = createHash("sha256").update(source).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("OMP idle-task compatibility does not support this CLI bundle hash.");
  }
  const text = Buffer.from(source).toString("utf8");
  if (countOccurrences(text, OMP_ACP_IDLE_TASK_COMPAT_ANCHOR) !== 1) {
    throw new Error("OMP idle-task compatibility requires one exact native handler anchor.");
  }
}

/** Testable source transform used by the private preload's onLoad callback. */
export function transformVerifiedOmpAcpIdleTaskBundle(
  source: string,
  expected: { readonly sha256?: string; readonly size?: number } = {},
): string {
  const bytes = Buffer.from(source, "utf8");
  verifyOmpAcpIdleTaskBundle(bytes, expected);
  return source.replace(OMP_ACP_IDLE_TASK_COMPAT_ANCHOR, makeHandlerReplacement());
}

function resolveSelectedOmpEntrypoint(
  selectedBinaryPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const selected = selectedBinaryPath.trim();
  if (!selected) throw new Error("OMP idle-task compatibility requires the selected CLI path.");
  const pathApi = platform === "win32" ? nodePath.win32 : nodePath;
  if (pathApi.isAbsolute(selected)) return pathApi.normalize(selected);
  if (selected.includes("/") || (platform === "win32" && selected.includes("\\"))) {
    return pathApi.resolve(cwd, selected);
  }
  const resolved = resolveOmpAcpIdleTaskCompatExecutablePath(selected, cwd, env, platform);
  if (!resolved) {
    throw new Error(
      "OMP idle-task compatibility cannot resolve the selected CLI from its account PATH.",
    );
  }
  return resolved;
}

export function buildOmpAcpIdleTaskCompatPreload(sourcePath: string): string {
  const entryLiteral = JSON.stringify(sourcePath);
  const markerLiteral = JSON.stringify(OMP_ACP_IDLE_TASK_COMPAT_MARKER);
  const shaLiteral = JSON.stringify(OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SHA256);
  const anchorLiteral = JSON.stringify(OMP_ACP_IDLE_TASK_COMPAT_ANCHOR);
  const exactPathPattern = `^${sourcePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`;
  const exactPathPatternLiteral = JSON.stringify(exactPathPattern);
  return `import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";

const expectedPath = ${entryLiteral};
const expectedHash = ${shaLiteral};
const marker = ${markerLiteral};
const anchor = ${anchorLiteral};
let markerWritten = false;

${buildOmpAcpIdleTaskCompatMainGuard()}

Bun.plugin({
  name: "synara-omp-acp-idle-task-compat-v1",
  setup(builder) {
    builder.onLoad({ filter: new RegExp(${exactPathPatternLiteral}) }, async ({ path }) => {
      let resolvedPath;
      try {
        resolvedPath = await realpath(path);
      } catch {
        throw new Error("OMP idle-task compatibility entry point became unavailable.");
      }
      if (resolvedPath !== expectedPath) {
        throw new Error("OMP idle-task compatibility entry point changed after verification.");
      }
      const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
      if (bytes.byteLength !== ${OMP_ACP_IDLE_TASK_COMPAT_BUNDLE_SIZE} || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
        throw new Error("OMP idle-task compatibility source changed after verification.");
      }
      const source = bytes.toString("utf8");
      const firstLine = source.slice(0, source.indexOf("\\n"));
      if (firstLine !== "#!/usr/bin/env bun") throw new Error("OMP idle-task compatibility requires the verified Bun CLI shebang.");
      const occurrences = source.split(anchor).length - 1;
      if (occurrences !== 1) throw new Error("OMP idle-task compatibility handler anchor changed.");
      const transformed = source.replace(anchor, ${JSON.stringify(makeHandlerReplacement())});
      if (!markerWritten) {
        markerWritten = true;
        process.stderr.write(marker + "\\n");
      }
      return { contents: transformed, loader: "js" };
    });
  },
});
`;
}

/** Guard Bun's already-canonicalized main path before installing the loader. */
export function buildOmpAcpIdleTaskCompatMainGuard(): string {
  return `if(Bun.main!==expectedPath)throw new Error("OMP idle-task compatibility main entry changed before preload.");
let mainRealPath;
try{
  mainRealPath=await realpath(expectedPath);
}catch{
  throw new Error("OMP idle-task compatibility main entry became unavailable before preload.");
}
if(mainRealPath!==expectedPath)throw new Error("OMP idle-task compatibility main entry changed before preload.");`;
}

function makeHandlerReplacement(): string {
  return `async#k(e,t){
  if(t.type==="tool_execution_update"&&(!e.promptTurn||e.promptTurn.settled||e.promptTurn.cancelRequested)&&!e.closedError){
    const a=t.partialResult?.details?.async;
    if(a?.type==="task"&&typeof a.jobId==="string"&&a.jobId.trim().length>0&&typeof a.state==="string"){
      let n=(async()=>{
        let r=new Map;
        let i=(s,a)=>{
          let l=\`\${a??""}\\x00\${s}\`,c=r.get(l);
          if(c!==void 0)return c;
          let d=Qde(this.#l,s);
          return r.set(l,d),d;
        };
        for(let s of vWe(t,e.session.sessionId,{getToolArgs:(a)=>e.toolArgsById.get(a),cwd:e.session.sessionManager.getCwd(),resolveImageData:i})){
          await this.#e.sessionUpdate(s);
        }
      })();
      e.promptEventHandlers.add(n);
      try{
        await n;
      }catch(r){
        z("Failed to push idle task update",{sessionId:e.session.sessionId,eventType:t.type,error:r});
      }finally{
        e.promptEventHandlers.delete(n);
      }
      return;
    }
  }
  if(t.type!=="thinking_level_changed"&&t.type!=="model_changed")return;`;
}

function countOccurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
