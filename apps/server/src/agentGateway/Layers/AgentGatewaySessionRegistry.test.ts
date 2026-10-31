import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

describe("AgentGatewaySessionRegistry", () => {
  it("permanently revokes old computer credentials through re-enable", () => {
    const registry = makeAgentGatewaySessionRegistry();
    const thread = ThreadId.makeUnsafe("thread-1");
    const old = registry.issue(thread, "codex", { additionalCapabilities: ["computer:control"] });
    registry.setComputerControlEnabled?.(thread, false);
    assert.isFalse(registry.verify(old.token)?.capabilities.has("computer:control"));
    assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
    registry.setComputerControlEnabled?.(thread, true);
    assert.isFalse(registry.verify(old.token)?.capabilities.has("computer:control"));
    const fresh = registry.issue(thread, "codex", { additionalCapabilities: ["computer:control"] });
    assert.isTrue(registry.verify(fresh.token)?.capabilities.has("computer:control"));
    assert.isTrue(registry.computerControlProvisioned?.(thread, "codex"));
    assert.isFalse(registry.computerControlProvisioned?.(thread, "claudeAgent"));
    registry.issue(thread, "codex");
    assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
  });
  it("allows independent legitimate sessions for the same thread", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "claudeAgent");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
    assert.equal(registry.verify(first.token)?.provider, "codex");
    assert.equal(registry.verify(second.token)?.provider, "claudeAgent");
  });

  it("keeps replacement runtime credentials independent from outgoing-session revocation", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");

    registry.revoke(first.token);
    assert.isNull(registry.verify(first.token));
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
  });

  it("binds write authority to one exact turn and invalidates it on revocation", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "authority" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const authority = registry.bindWriteAuthority(issued.token, "turn-a");

    assert.isNotNull(authority);
    assert.equal(authority?.turnId, "turn-a");
    assert.isTrue(registry.verifyWriteAuthority(authority!));

    registry.revoke(issued.token);
    assert.isFalse(registry.verifyWriteAuthority(authority!));
    assert.isNull(registry.bindWriteAuthority(issued.token, "turn-b"));
  });

  it("permanently fences a terminal turn credential even when A never used it", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const outgoing = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");

    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-b"));
    // Retirement is idempotent for the same terminal turn but cannot be
    // reassigned to a different one.
    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isFalse(registry.retireWriteAuthority(outgoing.token, "turn-b"));

    const replacement = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const turnBAuthority = registry.bindWriteAuthority(replacement.token, "turn-b");
    assert.isNotNull(turnBAuthority);
    assert.isTrue(registry.verifyWriteAuthority(turnBAuthority!));
  });

  it("keeps credentials valid for a long-lived provider session but not across restart", () => {
    let time = 1_000;
    const firstRegistry = makeAgentGatewaySessionRegistry({
      now: () => time,
      randomId: () => "first",
    });
    const issued = firstRegistry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    time += 48 * 60 * 60 * 1_000;
    assert.equal(firstRegistry.verify(issued.token)?.threadId, "thread-1");

    const afterRestart = makeAgentGatewaySessionRegistry({ randomId: () => "second" });
    assert.isNull(afterRestart.verify(issued.token));
  });

  it("keeps raw bearer tokens out of verified session identity snapshots", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "opaque-secret" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const verified = registry.verify(issued.token);
    assert.match(issued.token, /^sagw_session_/);
    assert.notProperty(verified, "token");
    assert.notInclude(JSON.stringify(verified), issued.token);
  });

  it("keeps computer control opt-in instead of adding it to provider defaults", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "computer" });
    const ordinary = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const optedIn = registry.issue(ThreadId.makeUnsafe("thread-2"), "codex", {
      additionalCapabilities: ["computer:control"],
    });

    assert.isFalse(ordinary.capabilities.has("computer:control"));
    assert.isTrue(optedIn.capabilities.has("computer:control"));
  });

  it("grants read-only learning to a closed epoch and read/write to an enabled OMP epoch", () => {
    const registry = makeAgentGatewaySessionRegistry({
      randomId: (() => {
        let next = 0;
        return () => String(++next);
      })(),
    });
    const thread = ThreadId.makeUnsafe("learning-thread");
    const base = {
      manifestId: "manifest-1",
      rootRunId: "run-1",
      snapshotId: "snapshot-1",
      scope: {
        ownerId: "owner-1",
        spaceId: null,
        expertId: "expert-1",
        projectId: "project-1",
      },
      knowledgeHash: `sha256:${"a".repeat(64)}`,
    } as const;
    const closed = registry.issue(thread, "pi", {
      learningSession: base,
      additionalCapabilities: ["learning:write"],
    });
    const enabled = registry.issue(thread, "omp", {
      learningSession: { ...base, learningEpoch: 4 },
      additionalCapabilities: ["learning:read"],
    });

    assert.isTrue(closed.capabilities.has("learning:read"));
    assert.isFalse(closed.capabilities.has("learning:write"));
    assert.isTrue(enabled.capabilities.has("learning:read"));
    assert.isTrue(enabled.capabilities.has("learning:write"));
    assert.deepEqual(registry.verify(closed.token)?.learningSession, base);
    assert.deepEqual(registry.verify(enabled.token)?.learningSession, {
      ...base,
      learningEpoch: 4,
    });
  });

  it("ignores learning grants for unsupported providers and contexts without exact scope", () => {
    const registry = makeAgentGatewaySessionRegistry({
      randomId: (() => {
        let next = 0;
        return () => String(++next);
      })(),
    });
    const thread = ThreadId.makeUnsafe("learning-thread");
    const forged = {
      manifestId: "manifest-1",
      rootRunId: "run-1",
      snapshotId: "snapshot-1",
      knowledgeHash: `sha256:${"b".repeat(64)}`,
      learningEpoch: 4,
    };
    const unsupported = registry.issue(thread, "codex", {
      learningSession: {
        ...forged,
        scope: { ownerId: "owner-1", spaceId: null, expertId: "expert-1", projectId: "project-1" },
      } as never,
      additionalCapabilities: ["learning:read", "learning:write"],
    });
    const missingScope = registry.issue(thread, "pi", {
      learningSession: forged as never,
      additionalCapabilities: ["learning:read", "learning:write"],
    });

    for (const issued of [unsupported, missingScope]) {
      assert.isFalse(issued.capabilities.has("learning:read"));
      assert.isFalse(issued.capabilities.has("learning:write"));
      assert.isUndefined(registry.verify(issued.token)?.learningSession);
    }
  });

  it("keeps the captured learning context independent between credentials", () => {
    const registry = makeAgentGatewaySessionRegistry();
    const thread = ThreadId.makeUnsafe("learning-thread");
    const input = {
      manifestId: "manifest-1",
      rootRunId: "run-1",
      snapshotId: "snapshot-1",
      scope: {
        ownerId: "owner-1",
        spaceId: null,
        expertId: "expert-1",
        projectId: "project-1",
      },
      knowledgeHash: `sha256:${"c".repeat(64)}`,
      learningEpoch: 5,
    };
    const first = registry.issue(thread, "pi", { learningSession: input });
    const replacement = registry.issue(thread, "pi", { learningSession: input });
    assert.notEqual(first.token, replacement.token);
    assert.deepEqual(registry.verify(first.token)?.learningSession, input);
    assert.deepEqual(registry.verify(replacement.token)?.learningSession, input);
  });
});
