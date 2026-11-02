import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";

export interface ExpertLearningMutation {
  readonly expertIds?: readonly string[];
  readonly skillIds?: readonly string[];
}
type Commit = {
  active: boolean;
  readonly root: string;
  readonly origin: "manual" | "automatic" | "control";
  readonly expertIds: Set<string>;
  readonly skillIds: Set<string>;
};
const context = new AsyncLocalStorage<Commit>();
const tails = new Map<string, Promise<void>>();
const reconcilers = new Map<string, (change: ExpertLearningMutation) => Promise<void>>();

/** An Effect-owned native admission holds the same gate only until its start/send is accepted. */
export async function acquireExpertLearningAdmission(stateDir: string): Promise<() => void> {
  const root = path.resolve(stateDir);
  const parent = context.getStore();
  if (parent?.root === root && parent.active) return () => {};
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const previous = tails.get(root) ?? Promise.resolve();
  const settled = previous.then(() => held);
  tails.set(root, settled);
  void settled.then(() => {
    if (tails.get(root) === settled) tails.delete(root);
  });
  await previous;
  return release;
}

/** One host-owned reconciliation capability, not a second event stream. */
export function installExpertLearningReconciler(
  stateDir: string,
  reconcile: (change: ExpertLearningMutation) => Promise<void>,
) {
  const root = path.resolve(stateDir);
  if (reconcilers.has(root)) throw new Error("Expert learning host is already installed.");
  reconcilers.set(root, reconcile);
  return () => {
    if (reconcilers.get(root) === reconcile) reconcilers.delete(root);
  };
}

/** Serializes capability commits and explicit edits. Nested library/Expert writes share the gate. */
export function withExpertLearningCommit<T>(
  stateDir: string,
  action: () => Promise<T>,
  change: ExpertLearningMutation = {},
  origin: Commit["origin"] = "manual",
): Promise<T> {
  const root = path.resolve(stateDir);
  const parent = context.getStore();
  const add = (commit: Commit) => {
    for (const id of change.expertIds ?? []) commit.expertIds.add(id);
    for (const id of change.skillIds ?? []) commit.skillIds.add(id);
  };
  if (parent?.root === root && parent.active) {
    add(parent);
    return action();
  }
  const commit: Commit = { active: true, root, origin, expertIds: new Set(), skillIds: new Set() };
  add(commit);
  const result = (tails.get(root) ?? Promise.resolve()).then(() =>
    context.run(commit, async () => {
      try {
        return await action();
      } finally {
        // Partial explicit commits also need reconciliation. A failed reconciliation
        // remains a failed operation so idempotent callers can retry the same edit.
        try {
          if (commit.origin === "manual")
            await reconcilers.get(root)?.({
              expertIds: [...commit.expertIds],
              skillIds: [...commit.skillIds],
            });
        } finally {
          commit.active = false;
        }
      }
    }),
  );
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(root, settled);
  void settled.then(() => {
    if (tails.get(root) === settled) tails.delete(root);
  });
  return result;
}
