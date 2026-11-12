import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  DEFAULT_PROJECT_AGENT_LIMITS,
  ProjectAgentConfigureInput,
  ProjectAgentListSummariesInput,
  ProjectAgentSummary,
  ProjectAgentConfig,
  ProjectAgentOverview,
  ProjectTaskStatus,
} from "./projectAgent";

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("defaults coordinator limits and capture", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentConfigureInput, {
      requestId: "req-1",
      projectId: "project-1",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    assert.deepStrictEqual(parsed.limits, { ...DEFAULT_PROJECT_AGENT_LIMITS });
    assert.strictEqual(parsed.captureEnabled, true);
  }),
);

it.effect("keeps an omitted expert roster distinct from an explicit empty roster", () =>
  Effect.gen(function* () {
    const base = {
      requestId: "req-expert-roster",
      projectId: "project-expert-roster",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    };
    const omitted = yield* decode(ProjectAgentConfigureInput, base);
    const empty = yield* decode(ProjectAgentConfigureInput, { ...base, expertIds: [] });

    assert.isFalse(Object.hasOwn(omitted, "expertIds"));
    assert.deepStrictEqual(empty.expertIds, []);
  }),
);

it.effect("keeps review distinct from done", () =>
  Effect.gen(function* () {
    const review = yield* decode(ProjectTaskStatus, "review");
    const done = yield* decode(ProjectTaskStatus, "done");
    assert.notStrictEqual(review, done);
  }),
);

it.effect("accepts an empty listSummaries payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentListSummariesInput, {});
    assert.deepStrictEqual(parsed, {});
  }),
);

it.effect("decodes a configured project agent summary", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentSummary, {
      projectId: "project-1",
      configured: true,
      coordinatorName: "Synara Coordinator",
      coordinatorThreadId: "thread-coordinator",
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "idle",
      revision: 1,
    });
    assert.strictEqual(parsed.configured, true);
    assert.strictEqual(parsed.coordinatorName, "Synara Coordinator");
    assert.strictEqual(parsed.revision, 1);
    assert.strictEqual(parsed.suite, null);
  }),
);

it.effect(
  "preserves omitted Suite selection separately from explicit null and a fixed revision",
  () =>
    Effect.gen(function* () {
      const base = {
        requestId: "req-suite",
        projectId: "hub-suite",
        coordinatorModelSelection: { provider: "codex", model: "fixture" },
      };
      const suite = { suiteId: "suite_00000000-0000-0000-0000-000000000001", revision: 2 };
      const omitted = yield* decode(ProjectAgentConfigureInput, base);
      const cleared = yield* decode(ProjectAgentConfigureInput, { ...base, suite: null });
      const selected = yield* decode(ProjectAgentConfigureInput, { ...base, suite });
      assert.isFalse(Object.hasOwn(omitted, "suite"));
      assert.strictEqual(cleared.suite, null);
      assert.deepStrictEqual(selected.suite, suite);
    }),
);

it.effect(
  "reads legacy config and overview Suite selections as null without rewriting the payload",
  () =>
    Effect.gen(function* () {
      const config = {
        projectId: "legacy-hub",
        coordinatorThreadId: "legacy-coordinator",
        coordinatorName: "Coordinator",
        coordinatorModelSelection: { provider: "codex", model: "fixture" },
        limits: { ...DEFAULT_PROJECT_AGENT_LIMITS },
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: "2026-11-11T00:00:00.000Z",
        updatedAt: "2026-11-11T00:00:00.000Z",
        disabledAt: null,
      };
      const parsedConfig = yield* decode(ProjectAgentConfig, config);
      const overview = {
        projectId: "legacy-hub",
        configured: true,
        config,
        linkedProjectIds: [],
        goal: null,
        digest: null,
        blockers: [],
        recentOutcomes: [],
        coordinatorStatus: "idle",
      };
      const parsedOverview = yield* decode(ProjectAgentOverview, overview);
      assert.strictEqual(parsedConfig.suite, null);
      assert.strictEqual(parsedOverview.suite, null);
      assert.strictEqual(parsedOverview.config?.suite, null);
      assert.strictEqual(parsedOverview.suiteSelectionOpen, false);
      assert.isFalse(Object.hasOwn(config, "suite"));
      assert.isFalse(Object.hasOwn(overview, "suite"));
      assert.isFalse(Object.hasOwn(overview, "suiteSelectionOpen"));
    }),
);
