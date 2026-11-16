// FILE: codexPathIdentity.ts
// Purpose: Canonicalizes Codex home paths for account-boundary comparisons.
// Layer: Server filesystem utility.

import { codexAuthFs, runCodexAuthIoSync, type CodexAuthIo } from "./codexAuthIo.ts";
import { codexSourceIdentitySteps } from "@synara/shared/codexSourceIdentity";

// Resolve symlinks in every existing path component while preserving a missing tail.
export function resolveCodexPathIdentity(inputPath: string): string {
  return runCodexAuthIoSync(resolveCodexPathIdentityIo(inputPath));
}

export function* resolveCodexPathIdentityIo(inputPath: string): CodexAuthIo<string> {
  const steps = codexSourceIdentitySteps(inputPath);
  let step = steps.next();
  while (!step.done) {
    try {
      step = steps.next(yield* codexAuthFs.realpath(step.value));
    } catch (error) {
      step = steps.throw(error);
    }
  }
  return step.value;
}

export function codexPathsReferenceSameLocation(left: string, right: string): boolean {
  return resolveCodexPathIdentity(left) === resolveCodexPathIdentity(right);
}

export function* codexPathsReferenceSameLocationIo(
  left: string,
  right: string,
): CodexAuthIo<boolean> {
  return (yield* resolveCodexPathIdentityIo(left)) === (yield* resolveCodexPathIdentityIo(right));
}
