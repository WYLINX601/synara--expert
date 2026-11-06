import type {
  AmbientContextObservation,
  AmbientContextSourceManifest,
  AmbientContextSourcePolicy,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { AmbientContextManager } from "./AmbientContextManager";
import type { AmbientContextSource } from "./ContextSource";

const now = Date.parse("2026-11-06T00:00:00.000Z");
const capturedAt = new Date(now).toISOString();

function manifest(
  id: string,
  capabilities: AmbientContextSourceManifest["capabilities"] = [
    {
      type: "selection.text",
      captureMode: "event",
      requiredPermissions: [],
      precision: "exact",
    },
  ],
): AmbientContextSourceManifest {
  return { id, label: id, kind: "application", capabilities };
}

function selection(id = "observation-1", text = "selected words"): AmbientContextObservation {
  return {
    schemaVersion: 1,
    id,
    targetKey: "target-1",
    capturedAt,
    method: "test adapter",
    confidence: "exact",
    type: "selection.text",
    value: { text },
  };
}

function publication(sequence: number, observations: readonly AmbientContextObservation[]) {
  return { sequence, observations };
}

function createSource(
  id: string,
  options: {
    manifest?: AmbientContextSourceManifest;
    start?: AmbientContextSource["start"];
    stop?: AmbientContextSource["stop"];
  } = {},
): AmbientContextSource {
  return {
    manifest: options.manifest ?? manifest(id),
    start: options.start ?? (async () => undefined),
    stop: options.stop ?? (async () => undefined),
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const enabledPolicy: AmbientContextSourcePolicy = {
  enabled: true,
  allowedTypes: ["selection.text"],
};

describe("AmbientContextManager", () => {
  it("keeps registered sources disabled until policy explicitly enables them", () => {
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("app"));

    expect(manager.getSourceStatus("app")).toMatchObject({ enabled: false, state: "disabled" });
    expect(manager.getDesktopState()).toMatchObject({
      sources: [{ connected: false, policy: { enabled: false, allowedTypes: [] } }],
      items: [],
    });
  });

  it("rejects duplicate source IDs and duplicate manifest capabilities", () => {
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("app"));
    expect(() => manager.registerSource(createSource("app"))).toThrow("already registered");

    const duplicated = manifest("duplicate", [
      {
        type: "selection.text",
        captureMode: "event",
        requiredPermissions: [],
        precision: "exact",
      },
      {
        type: "selection.text",
        captureMode: "on-demand",
        requiredPermissions: [],
        precision: "approximate",
      },
    ]);
    expect(() =>
      manager.registerSource(createSource("duplicate", { manifest: duplicated })),
    ).toThrow("duplicate capability");
  });

  it("rejects more than 32 registered sources", () => {
    const manager = new AmbientContextManager({ now: () => now });
    for (let index = 0; index < 32; index += 1)
      manager.registerSource(createSource(`source-${index}`));
    expect(() => manager.registerSource(createSource("source-32"))).toThrow("at most 32 sources");
  });

  it("forgets a stopped dynamic source and retains it when cleanup fails", async () => {
    const stop = vi
      .fn<AmbientContextSource["stop"]>()
      .mockRejectedValueOnce(new Error("listener still open"));
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("vault-a", { stop }));
    await manager.setPolicy("vault-a", enabledPolicy);
    await expect(manager.unregisterSource("vault-a")).rejects.toThrow("Could not stop");
    expect(manager.getSourceStatus("vault-a").state).toBe("failed");

    await manager.unregisterSource("vault-a");
    expect(() => manager.getSourceStatus("vault-a")).toThrow("Unknown ambient context source");
    expect(stop).toHaveBeenCalledTimes(2);
    manager.registerSource(createSource("vault-a"));
    expect(manager.getSourceStatus("vault-a").state).toBe("disabled");
  });

  it("uses complete sequence-checked replacements, including empty publications", async () => {
    const manager = new AmbientContextManager({ now: () => now });
    let emit!: (publication: unknown) => void;
    manager.registerSource(
      createSource("app", {
        start: async (_policy, publish) => {
          emit = publish;
        },
      }),
    );
    await manager.setPolicy("app", enabledPolicy);

    emit(publication(0, [selection()]));
    expect(manager.resolve()).toHaveLength(1);
    emit(publication(1, []));
    expect(manager.resolve()).toEqual([]);

    emit(publication(1, [selection("stale", "stale")]));
    emit(publication(0, [selection("older", "older")]));
    expect(manager.resolve()).toEqual([]);
  });

  it("omits full text by default and enforces explicit body scope before snapshot validation", async () => {
    const manager = new AmbientContextManager({ now: () => now });
    const ids = Array.from({ length: 5 }, (_, index) => `vault-${index}`);
    const emitters = new Map<string, (publication: unknown) => void>();
    const privateBody = `PRIVATE:${"x".repeat(16_376)}`;
    for (const id of ids) {
      manager.registerSource(
        createSource(id, {
          manifest: manifest(id, [
            {
              type: "resource.content",
              captureMode: "event",
              requiredPermissions: [],
              precision: "exact",
            },
          ]),
          start: async (_policy, emit) => void emitters.set(id, emit),
        }),
      );
      await manager.setPolicy(id, { enabled: true, allowedTypes: ["resource.content"] });
      emitters.get(id)!(
        publication(0, [
          {
            schemaVersion: 1,
            id: `body-${id}`,
            targetKey: `target-${id}`,
            capturedAt,
            method: "editor",
            confidence: "exact",
            type: "resource.content",
            value: { text: privateBody, truncated: false },
          },
        ]),
      );
    }

    expect(manager.capture({ sourceIds: ids }).items).toEqual([]);
    expect(() => manager.capture({ sourceIds: ids, includeFullTextSourceIds: ids })).toThrow(
      "Context exceeds the snapshot size limit.",
    );
    try {
      manager.capture({ sourceIds: ids, includeFullTextSourceIds: ids });
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE:");
    }
    expect(() => manager.capture({ sourceIds: [ids[0]!], includeFullTextSourceIds: ids })).toThrow(
      "Full-text sources must be selected context sources.",
    );
  });

  it("clears malformed publications without echoing their data", async () => {
    const manager = new AmbientContextManager({ now: () => now });
    let emit!: (publication: unknown) => void;
    manager.registerSource(
      createSource("app", {
        start: async (_policy, publish) => {
          emit = publish;
        },
      }),
    );
    await manager.setPolicy("app", enabledPolicy);
    emit(publication(0, [selection()]));
    expect(manager.resolve()).toHaveLength(1);

    emit(publication(-1, [selection("invalid", "private malformed payload")]));
    expect(manager.resolve()).toEqual([]);
    expect(manager.getSourceStatus("app").error).toBe("Invalid publication.");
    expect(manager.getSourceStatus("app").error).not.toContain("private malformed payload");
  });

  it("clears immediately on disable and ignores callbacks from the previous generation", async () => {
    const startEntered = deferred<void>();
    const finishStart = deferred<void>();
    let oldEmit!: (publication: unknown) => void;
    const stop = vi.fn(async () => undefined);
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(
      createSource("app", {
        start: async (_policy, emit) => {
          oldEmit = emit;
          startEntered.resolve();
          await finishStart.promise;
          emit(publication(0, [selection()]));
        },
        stop,
      }),
    );

    const enabling = manager.setPolicy("app", enabledPolicy);
    await startEntered.promise;
    expect(manager.getSourceStatus("app").enabled).toBe(false);

    const disabling = manager.setPolicy("app", { enabled: false, allowedTypes: [] });
    expect(manager.resolve()).toEqual([]);
    finishStart.resolve();
    await Promise.all([enabling, disabling]);
    oldEmit(publication(1, [selection("late", "late callback")]));

    expect(manager.getSourceStatus("app")).toMatchObject({ enabled: false, state: "disabled" });
    expect(manager.resolve()).toEqual([]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("serializes rapid policy updates and leaves the latest requested policy running", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const starts: AmbientContextSourcePolicy[] = [];
    const source = createSource("app", {
      start: async (policy) => {
        starts.push(policy);
        entered.resolve();
        await release.promise;
      },
    });
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(source);

    const first = manager.setPolicy("app", enabledPolicy);
    await entered.promise;
    const second = manager.setPolicy("app", { enabled: false, allowedTypes: [] });
    const third = manager.setPolicy("app", enabledPolicy);
    release.resolve();
    await Promise.all([first, second, third]);

    expect(starts).toEqual([enabledPolicy, enabledPolicy]);
    expect(manager.getSourceStatus("app")).toMatchObject({ enabled: true, state: "running" });
  });

  it("lets one source disable while another source start is still pending", async () => {
    const startEntered = deferred<void>();
    const finishStart = deferred<void>();
    const stopBlocked = vi.fn(async () => undefined);
    const stopOther = vi.fn(async () => undefined);
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(
      createSource("blocked", {
        start: async () => {
          startEntered.resolve();
          await finishStart.promise;
        },
        stop: stopBlocked,
      }),
    );
    manager.registerSource(createSource("other", { stop: stopOther }));

    const blockedEnable = manager.setPolicy("blocked", enabledPolicy);
    await startEntered.promise;
    await manager.setPolicy("other", enabledPolicy);

    const blockedDisable = manager.setPolicy("blocked", { enabled: false, allowedTypes: [] });
    await manager.setPolicy("other", { enabled: false, allowedTypes: [] });
    expect(stopOther).toHaveBeenCalledTimes(1);

    finishStart.resolve();
    await Promise.all([blockedEnable, blockedDisable]);
    expect(stopBlocked).toHaveBeenCalledTimes(1);
    expect(manager.getSourceStatus("blocked")).toMatchObject({ enabled: false, state: "disabled" });
  });

  it("does not let an older global stop override a newer policy update", async () => {
    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("app", { start, stop }));
    await manager.setPolicy("app", enabledPolicy);

    const stopping = manager.stop();
    const enabling = manager.setPolicy("app", enabledPolicy);
    await Promise.all([stopping, enabling]);

    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.getSourceStatus("app")).toMatchObject({ enabled: true, state: "running" });
  });

  it("rejects manager-wide stop on cleanup failure after attempting every source", async () => {
    const otherCleanupEntered = deferred<void>();
    const finishOtherCleanup = deferred<void>();
    const stopBroken = vi.fn(async () => {
      throw new Error("adapter cleanup failed");
    });
    const stopOther = vi.fn(async () => {
      otherCleanupEntered.resolve();
      await finishOtherCleanup.promise;
    });
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("broken", { stop: stopBroken }));
    manager.registerSource(createSource("other", { stop: stopOther }));
    await manager.setPolicy("broken", enabledPolicy);
    await manager.setPolicy("other", enabledPolicy);

    const stopping = manager.stop();
    expect(manager.resolve()).toEqual([]);
    await otherCleanupEntered.promise;
    expect(stopBroken).toHaveBeenCalledTimes(1);
    expect(stopOther).toHaveBeenCalledTimes(1);

    finishOtherCleanup.resolve();
    await expect(stopping).rejects.toThrow("Ambient context cleanup failed for sources: broken.");
    expect(manager.getSourceStatus("broken")).toMatchObject({
      enabled: false,
      state: "failed",
    });
    expect(manager.getSourceStatus("other")).toMatchObject({
      enabled: false,
      state: "disabled",
    });
  });

  it("cleans up partial start failures and never reports a failed source enabled", async () => {
    let emit!: (publication: unknown) => void;
    const stop = vi.fn(async () => undefined);
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(
      createSource("broken", {
        start: async (_policy, publish) => {
          emit = publish;
          publish(publication(0, [selection()]));
          throw new Error("adapter startup failed");
        },
        stop,
      }),
    );
    await manager.setPolicy("broken", enabledPolicy);
    emit(publication(1, [selection("late", "late after failure")]));

    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.getSourceStatus("broken")).toMatchObject({
      enabled: false,
      state: "failed",
      error: expect.stringContaining("adapter startup failed"),
    });
    expect(manager.resolve()).toEqual([]);
  });

  it("revokes active observations and does not start capabilities without their grants", async () => {
    const sourceManifest = manifest("secure", [
      {
        type: "selection.text",
        captureMode: "event",
        requiredPermissions: ["selection.read"],
        precision: "exact",
      },
    ]);
    let emit!: (publication: unknown) => void;
    const start = vi.fn(
      async (_policy: AmbientContextSourcePolicy, publish: (value: unknown) => void) => {
        emit = publish;
      },
    );
    const stop = vi.fn(async () => undefined);
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(createSource("secure", { manifest: sourceManifest, start, stop }));
    await manager.setPermissions("secure", ["selection.read"]);
    await manager.setPolicy("secure", enabledPolicy);
    emit(publication(0, [selection()]));
    expect(manager.resolve()).toHaveLength(1);

    const revoking = manager.setPermissions("secure", []);
    expect(manager.resolve()).toEqual([]);
    await revoking;

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(manager.getSourceStatus("secure")).toMatchObject({ enabled: false, state: "disabled" });
  });

  it("filters denied observation types before retaining a source publication", async () => {
    const sourceManifest = manifest("mixed", [
      {
        type: "application.identity",
        captureMode: "event",
        requiredPermissions: [],
        precision: "exact",
      },
      {
        type: "selection.text",
        captureMode: "event",
        requiredPermissions: ["selection.read"],
        precision: "exact",
      },
    ]);
    let emit!: (publication: unknown) => void;
    let receivedPolicy: AmbientContextSourcePolicy | undefined;
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(
      createSource("mixed", {
        manifest: sourceManifest,
        start: async (policy, publish) => {
          receivedPolicy = policy;
          emit = publish;
        },
      }),
    );
    await manager.setPolicy("mixed", {
      enabled: true,
      allowedTypes: ["application.identity", "selection.text"],
    });

    expect(receivedPolicy).toEqual({ enabled: true, allowedTypes: ["application.identity"] });
    emit(
      publication(0, [
        {
          schemaVersion: 1,
          id: "application-1",
          targetKey: "target-1",
          capturedAt,
          method: "test adapter",
          confidence: "exact",
          type: "application.identity",
          value: { applicationId: "app-id", name: "Test App" },
        },
        selection(),
      ]),
    );

    expect(manager.resolve()).toHaveLength(1);
    expect(manager.resolve()[0]?.observation.type).toBe("application.identity");
  });

  it("returns cloned, deeply immutable snapshots with caller supplied identity", async () => {
    let emit!: (publication: unknown) => void;
    const manager = new AmbientContextManager({ now: () => now });
    manager.registerSource(
      createSource("app", {
        start: async (_policy, publish) => {
          emit = publish;
        },
      }),
    );
    await manager.setPolicy("app", enabledPolicy);
    const original = selection("copy-check", "before");
    emit(publication(0, [original]));
    (original.value as { text: string }).text = "after mutation";

    const snapshot = manager.capture({ id: "snapshot-1", capturedAt });
    expect(snapshot.id).toBe("snapshot-1");
    expect(snapshot.capturedAt).toBe(capturedAt);
    expect(snapshot.items[0]?.observation.value).toEqual({ text: "before" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.isFrozen(snapshot.items[0]?.observation.value)).toBe(true);
  });

  it("isolates source failures and notifies subscribers when state or batches change", async () => {
    let emitGood!: (publication: unknown) => void;
    const manager = new AmbientContextManager({ now: () => now });
    const listener = vi.fn();
    const unsubscribe = manager.subscribe(listener);
    manager.registerSource(
      createSource("bad", {
        start: async () => {
          throw new Error("bad source");
        },
      }),
    );
    manager.registerSource(
      createSource("good", {
        start: async (_policy, publish) => {
          emitGood = publish;
        },
      }),
    );

    await manager.setPolicy("bad", enabledPolicy);
    await manager.setPolicy("good", enabledPolicy);
    emitGood(publication(0, [selection("good-observation", "still available")]));

    expect(manager.getSourceStatuses().map(({ sourceId, enabled }) => [sourceId, enabled])).toEqual(
      [
        ["bad", false],
        ["good", true],
      ],
    );
    expect(manager.resolve()).toHaveLength(1);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    const callCount = listener.mock.calls.length;
    emitGood(publication(1, []));
    expect(listener).toHaveBeenCalledTimes(callCount);
  });
});
