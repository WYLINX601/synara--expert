import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ExpertSaveInput } from "./expert";

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
