import {
  isLinxUpdateBusyStateClear,
  type LinxUpdateBusyState,
  type LinxUpdateMaintenanceRequest,
  type LinxUpdateMaintenanceResponse,
} from "@synara/contracts";
import { Effect, Fiber, ServiceMap } from "effect";

export const DESKTOP_MAINTENANCE_ROUTE_PATH = "/api/desktop/maintenance";
export const MAINTENANCE_BLOCKED_MESSAGE =
  "Installation requires an idle backend. Finish active work and try installing again.";

const CurrentWriteLease = ServiceMap.Reference<MaintenanceWriteLease | null>(
  "linx/maintenance/CurrentWriteLease",
  { defaultValue: () => null },
);

type Binding = Pick<LinxUpdateMaintenanceRequest, "attemptId" | "targetVersion" | "manifestDigest">;
const matches = (a: Binding, b: Binding) =>
  a.attemptId === b.attemptId &&
  a.targetVersion === b.targetVersion &&
  a.manifestDigest === b.manifestDigest;

interface MaintenanceWriteLease {
  readonly live: () => boolean;
  readonly progressOnly: boolean;
  readonly release: () => void;
}

export interface ServerMaintenanceAdmission {
  readonly close: (binding: Binding) => boolean;
  readonly release: (binding: Binding) => void;
  readonly seal: () => void;
  readonly guard: <A, E, R, F>(
    effect: Effect.Effect<A, E, R>,
    blocked: () => F,
    progress?: boolean,
  ) => Effect.Effect<A, E | F, R>;
  readonly scheduled: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly forkAccepted: <A, E, R, F>(
    effect: Effect.Effect<A, E, R>,
    blocked: () => F,
  ) => Effect.Effect<void, F, R>;
  readonly drain: Effect.Effect<void>;
  readonly active: number;
  readonly backgroundActive: number;
  readonly revision: number;
  readonly held: boolean;
}

/** One reversible fence, shared by transports, orchestration and native dispatch. */
export function makeServerMaintenanceAdmission(): ServerMaintenanceAdmission {
  let held: Binding | null = null;
  let active = 0;
  let backgroundActive = 0;
  let revision = 0;
  let sealed = false;
  const waiters = new Set<() => void>();
  const openWaiters = new Set<() => void>();
  const acquireLease = (background = false, progressOnly = false): MaintenanceWriteLease => {
    active += 1;
    if (background) backgroundActive += 1;
    revision += 1;
    let live = true;
    return {
      live: () => live,
      progressOnly,
      release: () => {
        if (!live) return;
        live = false;
        active -= 1;
        if (background) backgroundActive -= 1;
        if (active === 0) for (const resolve of waiters) resolve();
      },
    };
  };
  const close = (binding: Binding) => {
    if (held !== null) return matches(held, binding);
    held = binding;
    return true;
  };
  const release = (binding: Binding) => {
    if (held && matches(held, binding) && !sealed) {
      held = null;
      for (const resume of openWaiters) resume();
    }
  };
  const guard: ServerMaintenanceAdmission["guard"] = (effect, blocked, progress = false) =>
    Effect.gen(function* () {
      const inherited = yield* CurrentWriteLease;
      if (inherited?.live() && !sealed && (!inherited.progressOnly || progress))
        return yield* effect;
      // Disconnecting a renderer must not release a lease while its accepted
      // filesystem promise is still writing. The caller can still stop waiting
      // immediately (including ordinary quit); the actual operation owns release.
      const running = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (held && !progress) return yield* Effect.fail(blocked());
          const lease = acquireLease(false, progress);
          return yield* effect.pipe(
            Effect.provideService(CurrentWriteLease, lease),
            Effect.ensuring(Effect.sync(lease.release)),
            Effect.interruptible,
            Effect.forkDetach,
          );
        }),
      );
      return yield* Fiber.join(running);
    });
  const drain = Effect.callback<void>((resume) => {
    if (active === 0) {
      resume(Effect.void);
      return;
    }
    const resolve = () => resume(Effect.void);
    waiters.add(resolve);
    return Effect.sync(() => {
      waiters.delete(resolve);
    });
  });
  const scheduled: ServerMaintenanceAdmission["scheduled"] = (effect) =>
    Effect.gen(function* () {
      const inherited = yield* CurrentWriteLease;
      return yield* Effect.acquireUseRelease(
        Effect.callback<MaintenanceWriteLease>((resume) => {
          const grant = () => {
            if (held && !(inherited?.live() && !inherited.progressOnly && !sealed)) return;
            openWaiters.delete(grant);
            resume(Effect.succeed(acquireLease(true)));
          };
          openWaiters.add(grant);
          grant();
          return Effect.sync(() => {
            openWaiters.delete(grant);
          });
        }).pipe(Effect.interruptible),
        (lease) => effect.pipe(Effect.provideService(CurrentWriteLease, lease)),
        (lease) => Effect.sync(lease.release),
      );
    });
  const forkAccepted: ServerMaintenanceAdmission["forkAccepted"] = (effect, blocked) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const inherited = yield* CurrentWriteLease;
        if (held && !(inherited?.live() && !inherited.progressOnly && !sealed))
          return yield* Effect.fail(blocked());
        const lease = acquireLease(true);
        yield* effect.pipe(
          Effect.provideService(CurrentWriteLease, lease),
          Effect.ensuring(Effect.sync(lease.release)),
          Effect.interruptible,
          Effect.forkDetach,
        );
      }),
    );
  return {
    close,
    release,
    guard,
    scheduled,
    forkAccepted,
    drain,
    seal: () => {
      sealed = true;
    },
    get active() {
      return active;
    },
    get backgroundActive() {
      return backgroundActive;
    },
    get revision() {
      return revision;
    },
    get held() {
      return held !== null;
    },
  };
}

// The production process owns exactly one server/home. Tests use the factory above.
export const serverMaintenanceAdmission = makeServerMaintenanceAdmission();

/** Decorates existing service methods, never a second dispatch queue. */
export function guardMaintenanceMethods<T extends object>(
  service: T,
  names: readonly (keyof T)[],
  blocked: (method: keyof T) => unknown,
): T {
  const guarded = new Set<keyof T>(names);
  return new Proxy(service, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (!guarded.has(key as keyof T) || typeof value !== "function") return value;
      return (...args: unknown[]) =>
        serverMaintenanceAdmission.guard(
          Effect.suspend(
            () => Reflect.apply(value, target, args) as Effect.Effect<unknown, unknown>,
          ),
          () => blocked(key as keyof T),
        );
    },
  });
}

export interface ServerMaintenanceController {
  readonly handle: (
    request: LinxUpdateMaintenanceRequest,
  ) => Effect.Effect<LinxUpdateMaintenanceResponse>;
}

interface MaintenanceAttempt {
  readonly binding: Binding;
  phase: "preparing" | "ready" | "committing" | "committed" | "failed";
  busy: LinxUpdateBusyState | null;
}

export function makeServerMaintenanceController(options: {
  readonly admission: ServerMaintenanceAdmission;
  readonly inspect: Effect.Effect<LinxUpdateBusyState | null>;
  readonly commit: Effect.Effect<void>;
  readonly drainTimeoutMs?: number;
}): ServerMaintenanceController {
  let current: MaintenanceAttempt | null = null;
  const retired = new Set<string>();
  const response = (
    request: Binding,
    status: LinxUpdateMaintenanceResponse["status"],
    busy: LinxUpdateBusyState | null,
    message: string | null,
  ): LinxUpdateMaintenanceResponse => ({
    schemaVersion: 1,
    attemptId: request.attemptId,
    manifestDigest: request.manifestDigest,
    status,
    busy,
    message,
  });
  const inspect = options.inspect.pipe(Effect.catchCause(() => Effect.succeed(null)));
  const handle: ServerMaintenanceController["handle"] = (request) =>
    Effect.gen(function* () {
      if (current && !matches(current.binding, request))
        return response(request, "blocked", null, "Another installation attempt owns maintenance.");
      if (request.action === "abort") {
        if (
          current &&
          (current.phase === "committed" ||
            current.phase === "committing" ||
            current.phase === "failed")
        )
          return response(request, "blocked", null, "The clean handoff is already committed.");
        current = null;
        retired.add(request.attemptId);
        options.admission.release(request);
        return response(request, "released", null, null);
      }
      if (current?.phase === "committed") return response(request, "committed", current.busy, null);
      if (current?.phase === "committing" || current?.phase === "failed")
        return response(
          request,
          "blocked",
          null,
          "Backend clean handoff is not confirmed; maintenance remains held.",
        );
      if (request.action === "commit" && current?.phase !== "ready")
        return response(request, "blocked", null, "Prepare this exact target before committing.");
      if (current?.phase === "preparing")
        return response(request, "blocked", null, "Maintenance preparation is already running.");
      if (retired.has(request.attemptId))
        return response(
          request,
          "blocked",
          null,
          "This attempt was released. Start a new installation attempt.",
        );
      const attempt: MaintenanceAttempt = current ?? {
        binding: request,
        phase: "preparing",
        busy: null,
      };
      attempt.phase = "preparing";
      current = attempt;
      const refuse = (busy: LinxUpdateBusyState | null, message = MAINTENANCE_BLOCKED_MESSAGE) => {
        if (
          current === attempt &&
          attempt.phase !== "committed" &&
          attempt.phase !== "committing" &&
          attempt.phase !== "failed"
        ) {
          current = null;
          retired.add(request.attemptId);
          options.admission.release(request);
        }
        return response(request, "blocked", busy, message);
      };
      // Refuse live work immediately. Never wait for a chat to become idle and restart later.
      const initialRevision = options.admission.revision;
      const initial = yield* inspect;
      if (
        initial === null ||
        initial.activeTurns !== 0 ||
        initial.pendingApprovals !== 0 ||
        initial.pendingUserInputs !== 0 ||
        initial.backgroundTasks !== 0
      )
        return refuse(initial);
      if (current !== attempt)
        return response(request, "blocked", null, "The installation attempt was released.");
      if (initialRevision !== options.admission.revision)
        return refuse(null, "Backend activity changed during preparation. Try installing again.");
      if (!options.admission.close(request))
        return refuse(null, "Another installation attempt owns admission.");
      const revision = options.admission.revision;
      const drained = yield* options.admission.drain.pipe(
        Effect.timeoutOption(options.drainTimeoutMs ?? 3_000),
        Effect.map((value) => value._tag === "Some"),
      );
      if (!drained)
        return refuse(null, "Accepted writes did not finish in time. Try installing again.");
      if (current !== attempt)
        return response(request, "blocked", null, "The installation attempt was released.");
      const busy = yield* inspect;
      if (!isLinxUpdateBusyStateClear(busy)) return refuse(busy);
      if (current !== attempt)
        return response(request, "blocked", null, "The installation attempt was released.");
      if (options.admission.active !== 0 || revision !== options.admission.revision)
        return refuse(null, "Backend activity changed during preparation. Try installing again.");
      if (request.action === "commit") {
        // The only irreversible boundary. Abort cannot claim to reopen a quiesced engine.
        attempt.phase = "committing";
        attempt.busy = busy;
        options.admission.seal();
        const committed = yield* options.commit.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
        attempt.phase = committed ? "committed" : "failed";
        if (!committed)
          return response(
            request,
            "blocked",
            null,
            "Backend clean handoff failed; maintenance remains held.",
          );
        return response(request, "committed", busy, null);
      }
      attempt.phase = "ready";
      return response(request, "ready", busy, null);
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (
            current &&
            matches(current.binding, request) &&
            (current.phase === "preparing" || current.phase === "ready")
          ) {
            current = null;
            retired.add(request.attemptId);
            options.admission.release(request);
          }
        }),
      ),
    );
  return { handle };
}
