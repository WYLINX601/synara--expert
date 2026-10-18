import {
  WS_CLIENT_REQUIRED_CAPABILITIES,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  WS_PROJECT_FILE_WATCH_CAPABILITY,
  WS_SERVER_CAPABILITIES,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { negotiateWsCompatibility } from "./wsCompatibility";

describe("WebSocket compatibility bootstrap", () => {
  it("negotiates the stable epoch/range and returns process/build capabilities", async () => {
    const result = await Effect.runPromise(
      negotiateWsCompatibility({
        protocolEpoch: WS_PROTOCOL_EPOCH,
        minRevision: WS_PROTOCOL_MIN_REVISION,
        maxRevision: WS_PROTOCOL_MAX_REVISION,
        clientBuild: "test-client",
        requiredCapabilities: [...WS_SERVER_CAPABILITIES],
      }),
    );

    expect(result).toMatchObject({
      protocolEpoch: WS_PROTOCOL_EPOCH,
      negotiatedRevision: WS_PROTOCOL_MAX_REVISION,
    });
    expect(result.serverBuild.length).toBeGreaterThan(0);
    expect(result.serverInstanceId.length).toBeGreaterThan(0);
    expect(result.capabilities).toContain("orchestration.cursor-safe-streams");
    expect(result.capabilities).toContain("orchestration.thread-detail-snapshot");
    expect(result.capabilities).toContain("projects.github-provisioning");
    expect(result.capabilities).toContain(WS_PROJECT_FILE_WATCH_CAPABILITY);
    expect(result.capabilities).toContain("context.v1");
    expect(WS_CLIENT_REQUIRED_CAPABILITIES).not.toContain("projects.github-provisioning");
    expect(WS_CLIENT_REQUIRED_CAPABILITIES).not.toContain(WS_PROJECT_FILE_WATCH_CAPABILITY);
  });

  it.each([1, 2, 3, 4])(
    "rejects revision-%s clients because it cannot decode the current typed protocol",
    async (revision) => {
      const error = await Effect.runPromise(
        negotiateWsCompatibility({
          protocolEpoch: WS_PROTOCOL_EPOCH,
          minRevision: revision,
          maxRevision: revision,
          clientBuild: "stale-client",
          requiredCapabilities: [],
        }).pipe(Effect.flip),
      );

      expect(error).toMatchObject({
        code: "WS_PROTOCOL_INCOMPATIBLE",
        action: "update-client",
      });
    },
  );
});
