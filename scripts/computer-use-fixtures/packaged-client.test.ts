import { describe, expect, it } from "vitest";

import { connectOwnerUrl } from "./packaged-client.ts";

describe("operator owner connection boundaries", () => {
  it("keeps authenticated owner URLs required by default", async () => {
    await expect(connectOwnerUrl("ws://127.0.0.1:19841")).rejects.toThrow(
      "An authenticated owner URL is required.",
    );
  });

  it.each([
    "ws://example.com:19841",
    "ws://user:password@127.0.0.1:19841",
    "ws://127.0.0.1:19841/#fragment",
    "http://127.0.0.1:19841",
  ])("still rejects non-local or ambiguous endpoints with explicit local mode: %s", async (url) => {
    await expect(connectOwnerUrl(url, { allowUnauthenticatedLoopback: true })).rejects.toThrow(
      "Fixture connections must use local loopback endpoints.",
    );
  });
});
