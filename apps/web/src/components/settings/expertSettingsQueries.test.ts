import { describe, expect, it } from "vitest";
import { expertPreviewQueryKey } from "./expertSettingsQueries";

describe("expertPreviewQueryKey", () => {
  it("keeps provider instance and cwd previews in separate cache entries", () => {
    const base = expertPreviewQueryKey(
      "planner",
      7,
      "claudeAgent",
      "claude-work" as never,
      "/workspace/one",
    );

    expect(
      expertPreviewQueryKey(
        "planner",
        7,
        "claudeAgent",
        "claude-personal" as never,
        "/workspace/one",
      ),
    ).not.toEqual(base);
    expect(
      expertPreviewQueryKey("planner", 7, "claudeAgent", "claude-work" as never, "/workspace/two"),
    ).not.toEqual(base);
    expect(
      expertPreviewQueryKey("planner", 7, "omp", "claude-work" as never, "/workspace/one"),
    ).not.toEqual(base);
  });
});
