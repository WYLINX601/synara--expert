import { describe, expect, it } from "vitest";

import {
  authenticatedOwnerUrl,
  parseRuntimeProbeOptions,
  validateProbeInstanceHome,
  validateProbePaths,
} from "./lib/workbench-runtime-probe-input.ts";

const commonArgs = [
  "--source-sha",
  "a".repeat(40),
  "--owner-url",
  "ws://127.0.0.1:43123",
  "--instance-home",
  "/tmp/probe-instance",
  "--output-dir",
  "/tmp/probe-run",
  "--codex-home",
  "/tmp/probe-codex",
  "--pi-agent-dir",
  "/tmp/probe-pi",
];

describe("workbench runtime probe input", () => {
  it("accepts a full source SHA and explicit isolated paths", () => {
    expect(parseRuntimeProbeOptions(commonArgs)).toEqual({
      sourceSha: "a".repeat(40),
      ownerBaseUrl: "ws://127.0.0.1:43123",
      instanceHome: "/tmp/probe-instance",
      outputDir: "/tmp/probe-run",
      codexHome: "/tmp/probe-codex",
      piAgentDir: "/tmp/probe-pi",
      awaitServerRestart: false,
    });
  });

  it("keeps credentials out of argv and restricts owner access to unauthenticated loopback bases", () => {
    expect(() => parseRuntimeProbeOptions([...commonArgs, "--token", "secret"])).toThrow();
    expect(() => authenticatedOwnerUrl("ws://example.com:43123", "secret")).toThrow();
    expect(() => authenticatedOwnerUrl("ws://127.0.0.1:43123/?token=old", "secret")).toThrow();
    expect(authenticatedOwnerUrl("ws://127.0.0.1:43123", "private-token")).toBe(
      "ws://127.0.0.1:43123/?token=private-token",
    );
  });

  it("rejects overlapping, in-checkout, and default user profile paths", () => {
    const paths = {
      instanceHome: "/tmp/probe-instance",
      outputDir: "/tmp/probe-run",
      codexHome: "/tmp/probe-codex",
      piAgentDir: "/tmp/probe-pi",
      repositoryRoot: "/workspace/repo",
      userHome: "/Users/operator",
    };
    expect(() => validateProbePaths(paths)).not.toThrow();
    expect(() => validateProbePaths({ ...paths, outputDir: "/workspace/repo/out" })).toThrow();
    expect(() => validateProbePaths({ ...paths, piAgentDir: "/tmp/probe-run/pi" })).toThrow();
    expect(() => validateProbePaths({ ...paths, instanceHome: "/tmp/probe-run" })).toThrow();
    expect(() => validateProbePaths({ ...paths, codexHome: "/Users/operator/.codex" })).toThrow();
    expect(() =>
      validateProbePaths({ ...paths, piAgentDir: "/Users/operator/.pi/agent/probe" }),
    ).toThrow();
    expect(() =>
      validateProbePaths({ ...paths, outputDir: "/Users/operator/.synara-beta/probe-output" }),
    ).toThrow();
    expect(() =>
      validateProbePaths({
        ...paths,
        outputDir: "/tmp/operator-profile-alias/probe-output",
        protectedUserProfiles: ["/tmp/operator-profile-alias"],
      }),
    ).toThrow();
    expect(() =>
      validateProbeInstanceHome("/Users/operator/.synara/workbench", "/Users/operator"),
    ).toThrow();
    expect(() =>
      validateProbeInstanceHome("/Users/operator/.synara-beta", "/Users/operator"),
    ).toThrow();
    expect(() =>
      validateProbeInstanceHome("/tmp/configured", "/Users/operator", "/tmp/configured"),
    ).toThrow();
    expect(() =>
      validateProbeInstanceHome("/tmp/profile-alias/workbench", "/Users/operator", undefined, [
        "/tmp/profile-alias",
      ]),
    ).toThrow();
  });
});
