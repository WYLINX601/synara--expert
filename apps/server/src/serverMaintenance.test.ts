import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { LinxUpdateBusyState, LinxUpdateMaintenanceRequest } from "@synara/contracts";
import {
  makeServerMaintenanceAdmission,
  makeServerMaintenanceController,
} from "./serverMaintenance";

const target: LinxUpdateMaintenanceRequest = {
  schemaVersion: 1,
  action: "prepare",
  attemptId: "12345678-1234-4234-8234-123456789012",
  targetVersion: "0.1.16",
  manifestDigest: "a".repeat(64),
};
const clear: LinxUpdateBusyState = {
  activeTurns: 0,
  pendingApprovals: 0,
  pendingUserInputs: 0,
  backgroundTasks: 0,
  acceptedWrites: 0,
};

function fixture(state: LinxUpdateBusyState | null = clear) {
  const admission = makeServerMaintenanceAdmission();
  const commit = vi.fn();
  const controller = makeServerMaintenanceController({
    admission,
    inspect: Effect.sync(() => state && { ...state, acceptedWrites: admission.active }),
    commit: Effect.sync(commit),
    drainTimeoutMs: 50,
  });
  return {
    admission,
    commit,
    controller,
    setState: (next: LinxUpdateBusyState | null) => {
      state = next;
    },
  };
}

describe("reversible update maintenance", () => {
  it.each(["activeTurns", "pendingApprovals", "pendingUserInputs", "backgroundTasks"] as const)(
    "refuses %s without quiescing, cancelling or waiting for it to end",
    async (field) => {
      const f = fixture({ ...clear, [field]: 1 });
      expect((await Effect.runPromise(f.controller.handle(target))).status).toBe("blocked");
      expect(f.admission.held).toBe(false);
      expect(f.commit).not.toHaveBeenCalled();
      expect(
        await Effect.runPromise(
          f.admission.guard(Effect.succeed("original task continues"), () => "closed"),
        ),
      ).toBe("original task continues");
      f.setState(clear);
      expect(
        (await Effect.runPromise(f.controller.handle({ ...target, action: "commit" }))).status,
      ).toBe("blocked");
    },
  );

  it("blocks unknown state and releases admission", async () => {
    const f = fixture(null);
    expect(await Effect.runPromise(f.controller.handle(target))).toMatchObject({
      status: "blocked",
      busy: null,
    });
    expect(f.admission.held).toBe(false);
  });

  it.each([1, 2])(
    "refuses an observer defect at probe %s without committing or retaining admission",
    async (failedProbe) => {
      const admission = makeServerMaintenanceAdmission();
      const commit = vi.fn();
      let probes = 0;
      const controller = makeServerMaintenanceController({
        admission,
        commit: Effect.sync(commit),
        inspect: Effect.suspend(() =>
          ++probes === failedProbe
            ? Effect.die(new Error("Ownership observation unavailable"))
            : Effect.succeed(clear),
        ),
      });
      expect(await Effect.runPromise(controller.handle(target))).toMatchObject({
        status: "blocked",
        busy: null,
      });
      expect(admission.held).toBe(false);
      expect(commit).not.toHaveBeenCalled();
      expect(await Effect.runPromise(admission.guard(Effect.succeed("open"), () => "closed"))).toBe(
        "open",
      );
    },
  );

  it("holds normal and control RPC writes until an exact-target abort", async () => {
    const f = fixture();
    expect((await Effect.runPromise(f.controller.handle(target))).status).toBe("ready");
    const sideEffect = vi.fn();
    for (const method of ["orchestration.dispatchCommand", "terminal.write", "automation.runNow"]) {
      const result = await Effect.runPromise(
        f.admission.guard(Effect.sync(sideEffect), () => method).pipe(Effect.exit),
      );
      expect(result._tag).toBe("Failure");
    }
    expect(sideEffect).not.toHaveBeenCalled();
    expect(
      (
        await Effect.runPromise(
          f.controller.handle({ ...target, action: "abort", manifestDigest: "b".repeat(64) }),
        )
      ).status,
    ).toBe("blocked");
    expect(f.admission.held).toBe(true);
    expect(
      (await Effect.runPromise(f.controller.handle({ ...target, action: "abort" }))).status,
    ).toBe("released");
    expect(f.admission.held).toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("drains already admitted writes and preserves their nested dispatch after fencing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = fixture();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const nested = vi.fn();
        const write = yield* f.admission
          .guard(
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(finish);
              yield* f.admission.guard(Effect.sync(nested), () => "closed");
            }),
            () => "closed",
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const prepare = yield* f.controller.handle(target).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(f.admission.active).toBe(1);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(write);
        expect((yield* Fiber.join(prepare)).status).toBe("ready");
        expect(nested).toHaveBeenCalledTimes(1);
        expect(f.commit).not.toHaveBeenCalled();
      }),
    );
  });

  it("abort wins over a late health response and cannot release a later attempt", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = makeServerMaintenanceAdmission();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let probes = 0;
        const controller = makeServerMaintenanceController({
          admission,
          commit: Effect.void,
          inspect: Effect.suspend(() =>
            ++probes === 1
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.as(clear),
                )
              : Effect.succeed(clear),
          ),
        });
        const first = yield* controller.handle(target).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        expect((yield* controller.handle({ ...target, action: "abort" })).status).toBe("released");
        const newer = { ...target, attemptId: "87654321-1234-4234-8234-123456789012" };
        expect((yield* controller.handle(newer)).status).toBe("ready");
        yield* Deferred.succeed(finish, undefined);
        expect((yield* Fiber.join(first)).status).toBe("blocked");
        expect(admission.held).toBe(true);
        expect((yield* controller.handle({ ...newer, action: "commit" })).status).toBe("committed");
      }),
    );
  });

  it("detects lifecycle progress racing the final proof instead of trusting quiet samples", async () => {
    const admission = makeServerMaintenanceAdmission();
    let probes = 0;
    const controller = makeServerMaintenanceController({
      admission,
      commit: Effect.void,
      inspect: Effect.gen(function* () {
        if (++probes === 2)
          yield* admission.guard(Effect.void, () => "closed", true).pipe(Effect.orDie);
        return clear;
      }),
    });
    expect((await Effect.runPromise(controller.handle(target))).status).toBe("blocked");
    expect(admission.held).toBe(false);
    expect(admission.revision).toBe(1);
    expect(probes).toBe(2);
  });

  it("pauses future background work without losing it and resumes only on abort", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = fixture();
        expect((yield* f.controller.handle(target)).status).toBe("ready");
        const ran = vi.fn();
        const job = yield* f.admission.scheduled(Effect.sync(ran)).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(ran).not.toHaveBeenCalled();
        expect(f.admission.active).toBe(0);
        yield* f.controller.handle({ ...target, action: "abort" });
        yield* Fiber.join(job);
        expect(ran).toHaveBeenCalledTimes(1);
      }),
    );
  });

  it("counts accepted detached library writes for their actual lifetime", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = makeServerMaintenanceAdmission();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        yield* admission.forkAccepted(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
          () => "closed",
        );
        yield* Deferred.await(entered);
        expect(admission.active).toBe(1);
        expect(admission.backgroundActive).toBe(1);
        yield* Deferred.succeed(finish, undefined);
        yield* admission.drain;
        expect(admission.active).toBe(0);
        expect(admission.backgroundActive).toBe(0);
      }),
    );
  });

  it("quiesces only on exact-target commit and never releases a committed handoff", async () => {
    const f = fixture();
    expect((await Effect.runPromise(f.controller.handle(target))).status).toBe("ready");
    expect(f.commit).not.toHaveBeenCalled();
    expect(
      (
        await Effect.runPromise(
          f.controller.handle({ ...target, action: "commit", targetVersion: "0.1.17" }),
        )
      ).status,
    ).toBe("blocked");
    expect(
      (await Effect.runPromise(f.controller.handle({ ...target, action: "commit" }))).status,
    ).toBe("committed");
    expect(f.commit).toHaveBeenCalledTimes(1);
    expect(
      (await Effect.runPromise(f.controller.handle({ ...target, action: "abort" }))).status,
    ).toBe("blocked");
  });
  it("does not wait for accepted writes forever and never cancels them to become ready", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = makeServerMaintenanceAdmission();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const write = yield* admission
          .guard(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            () => "closed",
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const controller = makeServerMaintenanceController({
          admission,
          drainTimeoutMs: 1,
          commit: Effect.void,
          inspect: Effect.sync(() => ({ ...clear, acceptedWrites: admission.active })),
        });
        expect((yield* controller.handle(target)).status).toBe("blocked");
        expect(admission.held).toBe(false);
        expect(admission.active).toBe(1);
        yield* Deferred.succeed(finish, undefined);
        yield* Fiber.join(write);
        expect(admission.active).toBe(0);
      }),
    );
  });

  it("retains the sealed fence on failed irreversible handoff instead of claiming success", async () => {
    const admission = makeServerMaintenanceAdmission();
    const controller = makeServerMaintenanceController({
      admission,
      inspect: Effect.succeed(clear),
      commit: Effect.die("handoff failed"),
    });
    expect((await Effect.runPromise(controller.handle(target))).status).toBe("ready");
    expect(
      await Effect.runPromise(controller.handle({ ...target, action: "commit" })),
    ).toMatchObject({ status: "blocked", busy: null });
    expect(
      await Effect.runPromise(controller.handle({ ...target, action: "abort" })),
    ).toMatchObject({ status: "blocked" });
    expect(
      await Effect.runPromise(controller.handle({ ...target, action: "commit" })),
    ).toMatchObject({ status: "blocked" });
    expect(admission.held).toBe(true);
  });
  it("retains the actual write lease after its disconnected caller stops waiting", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const admission = makeServerMaintenanceAdmission();
        const entered = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        const caller = yield* admission
          .guard(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            () => "closed",
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(caller);
        expect(admission.active).toBe(1);
        yield* Deferred.succeed(finish, undefined);
        yield* admission.drain;
        expect(admission.active).toBe(0);
      }),
    );
  });

  it("refuses work that started and finished during the initial probe", async () => {
    const admission = makeServerMaintenanceAdmission();
    let probes = 0;
    const controller = makeServerMaintenanceController({
      admission,
      commit: Effect.void,
      inspect: Effect.gen(function* () {
        if (++probes === 1) yield* admission.guard(Effect.void, () => "closed").pipe(Effect.orDie);
        return clear;
      }),
    });
    expect((await Effect.runPromise(controller.handle(target))).status).toBe("blocked");
    expect(admission.held).toBe(false);
    expect(admission.revision).toBe(1);
    expect(probes).toBe(1);
  });
  it("never promotes a lifecycle-progress lease into authority to start new work", async () => {
    const admission = makeServerMaintenanceAdmission();
    admission.close(target);
    const result = await Effect.runPromise(
      admission
        .guard(
          admission.guard(Effect.succeed("must not dispatch"), () => "new work fenced"),
          () => "progress fenced",
          true,
        )
        .pipe(Effect.exit),
    );
    expect(result._tag).toBe("Failure");
    admission.seal();
    expect(
      await Effect.runPromise(
        admission.guard(Effect.succeed("shutdown metadata"), () => "closed", true),
      ),
    ).toBe("shutdown metadata");
    expect(
      (await Effect.runPromise(admission.guard(Effect.void, () => "closed").pipe(Effect.exit)))
        ._tag,
    ).toBe("Failure");
  });
});
