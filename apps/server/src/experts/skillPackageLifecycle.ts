import * as path from "node:path";

const pending = new Map<string, Promise<void>>();

/** Serializes package publication/removal with creation of durable references.
 * Mutating callers must run in the owning server process. Read-only verification
 * does not acquire this lock, so writers may validate resources while holding it.
 */
export function withSkillPackageLifecycle<T>(
  stateDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(stateDir);
  const result = (pending.get(key) ?? Promise.resolve()).then(action);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pending.set(key, settled);
  void settled.then(() => {
    if (pending.get(key) === settled) pending.delete(key);
  });
  return result;
}
