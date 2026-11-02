import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { frozenLearningEntriesReader } from "./evolution/ExpertLearningState";
import {
  acquireExpertLearningAdmission,
  installExpertLearningReconciler,
  withExpertLearningCommit,
} from "./expertLearningCommit";

const roots: string[] = [];
const uninstall: Array<() => void> = [];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function stateDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expert-learning-commit-"));
  roots.push(root);
  return path.join(root, "state");
}

afterEach(async () => {
  for (const remove of uninstall.splice(0)) remove();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("expert learning commit gate", () => {
  it("keeps awaited nested writes reentrant and reconciles their combined target set once", async () => {
    const root = await stateDir();
    const changes: unknown[] = [];
    const remove = installExpertLearningReconciler(root, async (change) => {
      changes.push(change);
    });
    uninstall.push(remove);

    await withExpertLearningCommit(
      root,
      async () => {
        await withExpertLearningCommit(root, async () => undefined, { skillIds: ["skill-inner"] });
      },
      { expertIds: ["expert-outer"] },
    );

    expect(changes).toEqual([{ expertIds: ["expert-outer"], skillIds: ["skill-inner"] }]);
  });

  it("reconciles manual commits but keeps automatic commits out of the explicit-edit reconciler", async () => {
    const root = await stateDir();
    const changes: unknown[] = [];
    const remove = installExpertLearningReconciler(root, async (change) => {
      changes.push(change);
    });
    uninstall.push(remove);

    await withExpertLearningCommit(
      root,
      async () => undefined,
      { expertIds: ["auto-expert"] },
      "automatic",
    );
    expect(changes).toEqual([]);
    await withExpertLearningCommit(
      root,
      async () => undefined,
      { expertIds: ["manual-expert"] },
      "manual",
    );

    expect(changes).toEqual([{ expertIds: ["manual-expert"], skillIds: [] }]);
  });

  it("releases the gate after an action or its reconciliation fails", async () => {
    const root = await stateDir();
    let failReconcile = true;
    const remove = installExpertLearningReconciler(root, async () => {
      if (failReconcile) {
        failReconcile = false;
        throw new Error("injected reconciliation failure");
      }
    });
    uninstall.push(remove);

    await expect(
      withExpertLearningCommit(
        root,
        async () => {
          throw new Error("injected partial mutation");
        },
        {},
        "control",
      ),
    ).rejects.toThrow("injected partial mutation");
    await expect(withExpertLearningCommit(root, async () => undefined)).rejects.toThrow(
      "injected reconciliation failure",
    );
    await expect(
      withExpertLearningCommit(root, async () => "gate released", {}, "control"),
    ).resolves.toBe("gate released");
  });

  it("linearizes close after an in-flight explicit mutation", async () => {
    const root = await stateDir();
    const mutationStarted = deferred();
    const finishMutation = deferred();
    const events: string[] = [];
    let bindings = ["before"];

    const mutation = withExpertLearningCommit(root, async () => {
      events.push("mutation-start");
      mutationStarted.resolve();
      await finishMutation.promise;
      bindings = ["after"];
      events.push("mutation-committed");
    });
    await mutationStarted.promise;

    let frozen: string[] = [];
    const close = withExpertLearningCommit(
      root,
      async () => {
        frozen = [...bindings];
        events.push("closed");
      },
      {},
      "control",
    );
    await Promise.resolve();
    expect(events).toEqual(["mutation-start"]);

    finishMutation.resolve();
    await Promise.all([mutation, close]);

    expect(events).toEqual(["mutation-start", "mutation-committed", "closed"]);
    expect(frozen).toEqual(["after"]);
  });

  it("keeps close behind an admitted native operation until its release", async () => {
    const root = await stateDir();
    const releaseAdmission = await acquireExpertLearningAdmission(root);
    const events: string[] = ["native-admitted"];
    const close = withExpertLearningCommit(
      root,
      async () => {
        events.push("closed");
      },
      {},
      "control",
    );

    await Promise.resolve();
    expect(events).toEqual(["native-admitted"]);
    releaseAdmission();
    await close;

    expect(events).toEqual(["native-admitted", "closed"]);
  });

  it("releases an interrupted admission so later commits can proceed", async () => {
    const root = await stateDir();
    const releaseAdmission = await acquireExpertLearningAdmission(root);
    try {
      // This is the finalizer path used by Effect.acquireUseRelease on cancellation.
      releaseAdmission();
    } finally {
      // The token must be idempotent: cleanup after cancellation cannot wedge the queue.
      releaseAdmission();
    }

    await expect(withExpertLearningCommit(root, async () => "closed", {}, "control")).resolves.toBe(
      "closed",
    );
  });

  it("does not let a detached old async context bypass a newer held commit", async () => {
    const root = await stateDir();
    const resumeDetached = deferred();
    const detachedStarted = deferred();
    const events: string[] = [];
    let detached!: Promise<void>;

    await withExpertLearningCommit(
      root,
      async () => {
        detached = resumeDetached.promise.then(async () => {
          detachedStarted.resolve();
          await withExpertLearningCommit(root, async () => {
            events.push("detached-write");
          });
        });
      },
      {},
      "control",
    );

    const newerStarted = deferred();
    const finishNewer = deferred();
    const newer = withExpertLearningCommit(
      root,
      async () => {
        events.push("newer-start");
        newerStarted.resolve();
        await finishNewer.promise;
        events.push("newer-end");
      },
      {},
      "control",
    );
    await newerStarted.promise;

    resumeDetached.resolve();
    await detachedStarted.promise;
    await Promise.resolve();
    expect(events).toEqual(["newer-start"]);

    finishNewer.resolve();
    await Promise.all([newer, detached]);
    expect(events).toEqual(["newer-start", "newer-end", "detached-write"]);
  });

  it("lets the runtime frozen-entry reader finish while package lifecycle holds the commit gate", async () => {
    const root = await stateDir();
    const repository = {
      listStates: () => Effect.succeed([]),
    } as never;
    const reader = frozenLearningEntriesReader(repository);
    const started = deferred();
    const release = deferred();
    const lifecycle = withExpertLearningCommit(
      root,
      async () => {
        started.resolve();
        await release.promise;
      },
      {},
      "control",
    );
    await started.promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      reader("expert-reader", []).then(() => "read"),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("blocked"), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    release.resolve();
    await lifecycle;

    expect(outcome).toBe("read");
  });
});
