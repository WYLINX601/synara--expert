import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { EXPERT_PROVIDER_KINDS, ExpertPreviewInput, ExpertSaveInput } from "./expert";

function definition(connections: unknown[]) {
  return {
    name: "Contract test",
    description: "",
    useCases: "",
    persona: "",
    outputRequirements: "",
    skills: [],
    references: [],
    connections,
  };
}

describe("Expert connection tool modes", () => {
  it("accepts all mode with an empty legacy tools list", () => {
    const decoded = Schema.decodeUnknownSync(ExpertSaveInput)(
      definition([{ id: "mcp", required: false, tools: [], toolMode: "all" }]),
    );

    expect(decoded.connections).toEqual([
      { id: "mcp", required: false, tools: [], toolMode: "all" },
    ]);
  });

  it("keeps a missing mode absent so callers can apply the legacy selected default", () => {
    const decoded = Schema.decodeUnknownSync(ExpertSaveInput)(
      definition([{ id: "mcp", required: false, tools: ["search"] }]),
    );

    expect(decoded.connections).toEqual([{ id: "mcp", required: false, tools: ["search"] }]);
  });
});

describe("Expert provider compatibility", () => {
  it.each(EXPERT_PROVIDER_KINDS)(
    "accepts %s preferences and instance-scoped preview",
    (provider) => {
      expect(
        Schema.decodeUnknownSync(ExpertSaveInput)({
          ...definition([]),
          preferredProvider: provider,
        }).preferredProvider,
      ).toBe(provider);
      expect(
        Schema.decodeUnknownSync(ExpertPreviewInput)({
          expertId: "reviewer",
          provider,
          providerInstanceId: `${provider}-work`,
          cwd: "/workspace",
        }),
      ).toMatchObject({ provider, providerInstanceId: `${provider}-work` });
    },
  );
  it("does not enable unrelated providers through Expert contracts", () => {
    expect(() =>
      Schema.decodeUnknownSync(ExpertPreviewInput)({ expertId: "reviewer", provider: "opencode" }),
    ).toThrow();
  });
});
