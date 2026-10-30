import { describe, expect, it } from "vitest";

import {
  assertSingleContentSource,
  ManagementCliUsageError,
  parseCsvFlag,
  parseManagementCliCommand,
  parseManagementCliFlagFailure,
  type ManagementCliFlagValues,
} from "./cli";

const flags: ManagementCliFlagValues = {
  json: false,
  content: undefined,
  contentFile: undefined,
  stdin: false,
  codeStdin: false,
  file: undefined,
  url: undefined,
  path: undefined,
  name: undefined,
  description: undefined,
  search: undefined,
  usage: undefined,
  source: [],
  tag: [],
  expertId: [],
  expertIds: undefined,
  skillId: [],
  skillIds: undefined,
  sort: undefined,
  direction: undefined,
  expectedRevision: undefined,
  requestId: undefined,
  dryRun: false,
  clear: false,
  yes: false,
  overwriteLocalEdits: false,
  entry: undefined,
  duplicate: undefined,
  allowEvolution: undefined,
  selectionScope: undefined,
  resourceMode: undefined,
  instanceId: undefined,
  flavor: undefined,
};

describe("Skill management CLI parser", () => {
  it.each([
    ["unknown flag", ["skill", "list", "--bogus"], /Unrecognized flag: --bogus/u],
    [
      "removed activation flag",
      ["expert", "skills", "add", "expert-a", "--activation", "startup"],
      /Unrecognized flag: --activation/u,
    ],
    [
      "removed creator flag",
      ["skill", "list", "--created-by", "actor"],
      /Unrecognized flag: --created-by/u,
    ],
    ["invalid integer", ["skill", "update", "--expected-revision", "abc"], /integer/u],
    ["invalid choice", ["expert", "skills", "list", "--flavor", "other"], /Expected one of/u],
    [
      "invalid evolution permission",
      ["expert", "skills", "add", "expert-a", "--allow-evolution", "maybe"],
      /true, false/u,
    ],
    [
      "invalid selection scope",
      ["expert", "skills", "add", "--selection-scope", "all"],
      /entry, package/u,
    ],
    [
      "invalid resource mode",
      ["expert", "skills", "add", "--resource-mode", "writable"],
      /shared-readonly, run-private/u,
    ],
    ["missing value", ["skill", "import", "--path"], /Missing value for flag --path/u],
  ])("preflights management parser failures: %s", (_name, args, message) => {
    expect(parseManagementCliFlagFailure(args as ReadonlyArray<string>)?.message).toMatch(message);
  });

  it.each(["true", "false"] as const)("accepts explicit --allow-evolution %s", (value) => {
    expect(
      parseManagementCliFlagFailure([
        "expert",
        "skills",
        "set",
        "expert-a",
        "--allow-evolution",
        value,
      ]),
    ).toBeUndefined();
  });

  it("parses Skill file and Expert binding command paths", () => {
    expect(
      parseManagementCliCommand({
        namespace: "skill",
        args: ["files", "write", "skl_0123456789abcdef0123456789abcdef", "templates/a.bin"],
        flags,
      }),
    ).toMatchObject({
      operation: { area: "skill", action: "files-write" },
      positional: ["skl_0123456789abcdef0123456789abcdef", "templates/a.bin"],
    });

    expect(
      parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "add", "expert-a"],
        flags: { ...flags, expertIds: "expert-b,expert-c" },
      }),
    ).toMatchObject({
      operation: { area: "expert-skills", action: "add" },
      positional: ["expert-a"],
    });

    expect(() =>
      parseManagementCliCommand({
        namespace: "expert",
        args: ["skills", "convert", "expert-a"],
        flags,
      }),
    ).toThrow(ManagementCliUsageError);
    expect(
      parseManagementCliFlagFailure(["expert", "skills", "add", "--expected-plan-digest", "a"])
        ?.message,
    ).toMatch(/Unrecognized flag: --expected-plan-digest/u);
    expect(
      parseManagementCliFlagFailure([
        "expert",
        "skills",
        "add",
        "--selection-scope",
        "package",
        "--resource-mode",
        "run-private",
      ]),
    ).toBeUndefined();
  });

  it("deduplicates comma-separated and repeated filters while preserving order", () => {
    expect(parseCsvFlag("e2,e1,e2", ["e1", "e3"])).toEqual(["e1", "e3", "e2"]);
  });

  it("requires exactly one content source for text and binary file inputs", () => {
    expect(() =>
      assertSingleContentSource({ content: "", contentFile: undefined, stdin: false }),
    ).not.toThrow();
    expect(() =>
      assertSingleContentSource({ content: undefined, contentFile: "a.bin", stdin: true }),
    ).toThrow(ManagementCliUsageError);
    expect(() =>
      assertSingleContentSource({ content: undefined, contentFile: undefined, stdin: false }),
    ).toThrow(ManagementCliUsageError);
  });
});
