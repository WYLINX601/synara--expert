import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderListModelsResult, ProviderSkillsCatalogInput } from "./providerDiscovery";

const decodeModels = Schema.decodeUnknownSync(ProviderListModelsResult);

describe("ProviderSkillsCatalogInput", () => {
  const decode = Schema.decodeUnknownSync(ProviderSkillsCatalogInput);
  it("preserves legacy catalog calls and accepts an explicit runtime scan", () => {
    expect(decode({})).toEqual({});
    expect(decode({ provider: "pi", forceReload: true })).toEqual({
      provider: "pi",
      forceReload: true,
    });
    expect(() => decode({ provider: "unknown-runtime" })).toThrow();
    expect(() => decode({ forceReload: "yes" })).toThrow();
  });
});

describe("ProviderListModelsResult", () => {
  it.each([
    { roles: [{ name: "smol", model: "upstream/model", thinkingLevel: "high" }] },
    { roles: [{ name: "", model: null, thinkingLevel: "retired-level" }] },
    { roles: "invalid legacy roles" },
    { roles: null },
  ])("strips legacy roles without discarding model metadata: %j", ({ roles }) => {
    const catalog = {
      models: [
        {
          slug: "upstream/model",
          name: "Model",
          upstreamProviderId: "upstream",
          supportedReasoningEfforts: [{ value: "high", label: "High" }],
        },
      ],
      source: "omp-cli",
      cached: true,
    };

    expect(decodeModels({ ...catalog, roles })).toEqual(catalog);
  });

  it("still rejects an invalid model catalog when legacy roles are present", () => {
    expect(() => decodeModels({ models: "invalid", roles: [] })).toThrow();
  });
});
