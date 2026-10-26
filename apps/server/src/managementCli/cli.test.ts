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
  createdBy: undefined,
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
  activation: undefined,
  instanceId: undefined,
  flavor: undefined,
};

describe("Skill management CLI parser", () => {
  it.each([
    ["unknown flag", ["skill", "list", "--bogus"], /Unrecognized flag: --bogus/u],
    ["invalid integer", ["skill", "update", "--expected-revision", "abc"], /integer/u],
    ["invalid choice", ["expert", "skills", "list", "--flavor", "other"], /Expected one of/u],
    ["missing value", ["skill", "import", "--path"], /Missing value for flag --path/u],
  ])("preflights management parser failures: %s", (_name, args, message) => {
    expect(parseManagementCliFlagFailure(args as ReadonlyArray<string>)?.message).toMatch(message);
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
