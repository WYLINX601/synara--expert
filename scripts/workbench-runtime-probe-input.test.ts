import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  authenticatedOwnerUrl,
  parseRuntimeProbeOptions,
  safeTurnErrorEvidence,
  validateProbeInstanceHome,
  validateProbePaths,
} from "./lib/workbench-runtime-probe-input.ts";

const commonArgs = [
  "--source-sha",
  "a".repeat(40),
  "--owner-url",
  "ws://127.0.0.1:43123",
  "--codex-model",
  "gpt-6.1-sol",
  "--codex-reasoning-effort",
  "high",
  "--pi-model",
  "openai-codex/gpt-5.6-sol",
  "--pi-thinking-level",
  "medium",
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
      codexModel: "gpt-6.1-sol",
      codexReasoningEffort: "high",
      piModel: "openai-codex/gpt-5.6-sol",
      piThinkingLevel: "medium",
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

  it("requires explicit model and provider-option selections with no implicit fallback", () => {
    for (const option of [
      "--codex-model",
      "--codex-reasoning-effort",
      "--pi-model",
      "--pi-thinking-level",
    ]) {
      const args = [...commonArgs];
      const index = args.indexOf(option);
      args.splice(index, 2);
      expect(() => parseRuntimeProbeOptions(args), option).toThrow();
    }
    const customModelArgs = [...commonArgs];
    customModelArgs[customModelArgs.indexOf("gpt-6.1-sol")] = "operator-selected-codex-model";
    expect(parseRuntimeProbeOptions(customModelArgs).codexModel).toBe(
      "operator-selected-codex-model",
    );
    expect(() =>
      parseRuntimeProbeOptions([
        ...commonArgs.slice(0, commonArgs.indexOf("high")),
        "max",
        ...commonArgs.slice(commonArgs.indexOf("high") + 1),
      ]),
    ).toThrow();
    expect(() =>
      parseRuntimeProbeOptions([
        ...commonArgs.slice(0, commonArgs.indexOf("medium")),
        "auto",
        ...commonArgs.slice(commonArgs.indexOf("medium") + 1),
      ]),
    ).toThrow();
  });

  it("rejects unsafe model identifiers and malformed Pi provider/model references", () => {
    for (const model of ["", "two words", "model\nname", `x${"a".repeat(128)}`]) {
      const args = [...commonArgs];
      args[args.indexOf("gpt-6.1-sol")] = model;
      expect(() => parseRuntimeProbeOptions(args)).toThrow();
    }
    for (const model of ["/model", "provider/", "provider:"]) {
      const args = [...commonArgs];
      args[args.indexOf("openai-codex/gpt-5.6-sol")] = model;
      expect(() => parseRuntimeProbeOptions(args)).toThrow();
    }
    const colonModelArgs = [...commonArgs];
    colonModelArgs[colonModelArgs.indexOf("openai-codex/gpt-5.6-sol")] = "openai-codex:gpt-5.6-sol";
    expect(parseRuntimeProbeOptions(colonModelArgs).piModel).toBe("openai-codex:gpt-5.6-sol");
    const bareModelArgs = [...commonArgs];
    bareModelArgs[bareModelArgs.indexOf("openai-codex/gpt-5.6-sol")] = "gpt-5.6-sol";
    expect(() => parseRuntimeProbeOptions(bareModelArgs)).toThrow();
  });

  it("classifies only an explicit unsupported-model response and never returns its body", () => {
    const rawText =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}';
    const diagnostic = safeTurnErrorEvidence(
      [
        {
          kind: "runtime.error",
          turnId: "another-turn",
          payload: { message: "another turn failure" },
        },
        {
          kind: "runtime.error",
          turnId: "target-turn",
          payload: {
            message: {
              parsed: {
                httpStatus: 400,
                providerErrorType: "invalid_request_error",
                providerMessage:
                  "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
              },
              text: rawText,
            },
          },
        },
      ],
      "target-turn",
    );

    expect(diagnostic).toEqual({
      providerErrorCategory: "model-unsupported",
      originalMessageSha256: createHash("sha256").update(rawText).digest("hex"),
      providerHttpStatus: 400,
    });
    expect(JSON.stringify(diagnostic)).not.toContain("ChatGPT account");
  });

  it("keeps unknown provider failures generic and reports missing cause as unknown", () => {
    const rawText = '{"status":400,"error":{"message":"Request could not be completed."}}';
    expect(
      safeTurnErrorEvidence(
        [
          {
            kind: "runtime.error",
            turnId: "target-turn",
            payload: { message: rawText },
          },
        ],
        "target-turn",
      ),
    ).toEqual({
      providerErrorCategory: "provider-error",
      originalMessageSha256: createHash("sha256").update(rawText).digest("hex"),
      providerHttpStatus: 400,
    });
    expect(safeTurnErrorEvidence([], "target-turn")).toEqual({
      providerErrorCategory: "unknown",
      originalMessageSha256: null,
      providerHttpStatus: null,
    });
  });

  it("does not misclassify an unsupported model-related request field as an unsupported model", () => {
    const rawText = '{"status":400,"error":{"message":"Model request header is not supported."}}';
    expect(
      safeTurnErrorEvidence(
        [
          {
            kind: "runtime.error",
            turnId: "target-turn",
            payload: { message: rawText },
          },
        ],
        "target-turn",
      ),
    ).toEqual({
      providerErrorCategory: "provider-error",
      originalMessageSha256: createHash("sha256").update(rawText).digest("hex"),
      providerHttpStatus: 400,
    });
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
