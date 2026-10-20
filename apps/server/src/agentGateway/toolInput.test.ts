import { assert, describe, it } from "@effect/vitest";

import {
  MODEL_SELECTION_INPUT_SCHEMA,
  decodeCreateThreadsInput,
  readModelSelectionArg,
} from "./toolInput.ts";

describe("agent gateway target input", () => {
  it("advertises and preserves an explicit provider instance", () => {
    assert.equal(MODEL_SELECTION_INPUT_SCHEMA.properties.instanceId?.type, "string");
    assert.equal(
      readModelSelectionArg(
        {
          target: {
            provider: "codex",
            instanceId: "codex_work",
            model: "gpt-5.5",
          },
        },
        "target",
      )?.instanceId,
      "codex_work",
    );
  });

  it("rejects a blank provider instance", () => {
    assert.throws(() =>
      readModelSelectionArg(
        {
          target: {
            provider: "codex",
            instanceId: " ",
            model: "gpt-5.5",
          },
        },
        "target",
      ),
    );
  });

  it("allows an Expert request without a target but rejects caller-supplied frozen bindings", () => {
    assert.deepEqual(
      decodeCreateThreadsInput({
        requestId: "hub-expert",
        threads: [{ prompt: "Use the pinned Expert", expertId: "expert-one" }],
      }).threads[0],
      { prompt: "Use the pinned Expert", expertId: "expert-one" },
    );
    assert.throws(
      () =>
        decodeCreateThreadsInput({
          requestId: "forged-binding",
          threads: [
            {
              prompt: "Inject an Expert snapshot",
              expertId: "expert-one",
              target: { provider: "codex", model: "gpt-6-astra" },
              expertBinding: {
                expertId: "expert-one",
                snapshotId: "attacker-selected",
                displayName: "Forged",
                revision: 1,
              },
            },
          ],
        }),
      /Invalid Synara creation plan/u,
    );
  });
});
