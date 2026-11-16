import { realpath } from "node:fs/promises";
import path from "node:path";

/** Shared path-identity algorithm. Yielded paths are realpath requests so the
 * server's synchronous/asynchronous auth IO interpreters use identical rules.
 */
export function* codexSourceIdentitySteps(inputPath: string): Generator<string, string, string> {
  const resolvedInput = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let candidate = resolvedInput;
  while (true) {
    try {
      const realCandidate = yield candidate;
      const rebuilt =
        missingSegments.length > 0 ? path.join(realCandidate, ...missingSegments) : realCandidate;
      const normalized = path.normalize(rebuilt);
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        const normalized = path.normalize(resolvedInput);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

export async function resolveCodexSourceHomeIdentity(inputPath: string): Promise<string> {
  const steps = codexSourceIdentitySteps(inputPath);
  let step = steps.next();
  while (!step.done) {
    try {
      step = steps.next(await realpath(step.value));
    } catch (error) {
      step = steps.throw(error);
    }
  }
  return step.value;
}
