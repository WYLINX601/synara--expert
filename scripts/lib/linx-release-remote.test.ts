import { describe, expect, it, vi, type Mock } from "vitest";
import { verifyLinxReleaseOperation } from "./linx-release-remote.ts";

const sourceCommit = "a".repeat(40);
const movedCommit = "b".repeat(40);
const tagSha = "c".repeat(40);
const nestedTagSha = "d".repeat(40);
const candidate = { tag: "v0.1.15", sourceCommit };
const release = { tag_name: candidate.tag, target_commitish: sourceCommit, prerelease: false };
const refPath = `git/ref/tags/${candidate.tag}`;
const reference = (sha = sourceCommit, type = "commit") => ({
  ref: `refs/tags/${candidate.tag}`,
  object: { type, sha },
});

interface Fixture {
  responses: Map<string, unknown>;
  api: Mock<(path: string, options: { anonymous: boolean }) => Promise<unknown>>;
  verify: Mock<() => Promise<void>>;
  publish: Mock<() => Promise<void>>;
}

function fixture(): Fixture {
  const responses = new Map<string, unknown>([[refPath, reference()]]);
  const api = vi.fn(async (path: string, _options: { anonymous: boolean }) => {
    if (!responses.has(path)) throw new Error("GitHub GET: 404");
    return responses.get(path);
  });
  const verify = vi.fn(async () => {});
  const publish = vi.fn(async () => {});
  return { responses, api, verify, publish };
}

const operations = [
  { name: "new stage", anonymous: false, publishes: false },
  { name: "stage retry", anonymous: false, publishes: false },
  { name: "restore", anonymous: false, publishes: false },
  { name: "draft promotion", anonymous: false, publishes: true },
  { name: "already-public promotion", anonymous: false, publishes: false },
  { name: "anonymous validation", anonymous: true, publishes: false },
];

describe.each(operations)("remote source gate: $name", ({ anonymous, publishes }) => {
  function run(f: Fixture) {
    return verifyLinxReleaseOperation({
      release,
      candidate,
      api: f.api,
      anonymous,
      verify: f.verify,
      ...(publishes ? { publish: f.publish } : {}),
    });
  }

  it("accepts a stable lightweight tag and rechecks before success", async () => {
    const f = fixture();
    await expect(run(f)).resolves.toBeUndefined();
    expect(f.verify).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledTimes(publishes ? 1 : 0);
    expect(f.api.mock.calls).toEqual(
      Array.from({ length: publishes ? 3 : 2 }, () => [refPath, { anonymous }]),
    );
  });

  it.each(["moved", "deleted"])(
    "rejects a %s tag despite unchanged Release metadata",
    async (change) => {
      const f = fixture();
      if (change === "moved") f.responses.set(refPath, reference(movedCommit));
      else f.responses.delete(refPath);
      await expect(run(f)).rejects.toThrow();
      expect(f.verify).not.toHaveBeenCalled();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it.each(["moved", "deleted"])(
    "rejects a tag %s during asset verification or restore",
    async (change) => {
      const f = fixture();
      f.verify.mockImplementation(async () => {
        if (change === "moved") f.responses.set(refPath, reference(movedCommit));
        else f.responses.delete(refPath);
      });
      await expect(run(f)).rejects.toThrow();
      expect(f.verify).toHaveBeenCalledOnce();
      expect(f.publish).not.toHaveBeenCalled();
    },
  );

  it("peels nested annotated tags using the same access mode for every request", async () => {
    const f = fixture();
    f.responses.set(refPath, reference(tagSha, "tag"));
    f.responses.set(`git/tags/${tagSha}`, {
      sha: tagSha,
      object: { type: "tag", sha: nestedTagSha },
    });
    f.responses.set(`git/tags/${nestedTagSha}`, {
      sha: nestedTagSha,
      object: { type: "commit", sha: sourceCommit },
    });
    await expect(run(f)).resolves.toBeUndefined();
    expect(f.api.mock.calls).toEqual(
      Array.from({ length: publishes ? 3 : 2 }, () => [
        [refPath, { anonymous }],
        [`git/tags/${tagSha}`, { anonymous }],
        [`git/tags/${nestedTagSha}`, { anonymous }],
      ]).flat(),
    );
  });
});

describe("remote source fail-closed boundaries", () => {
  function run(f: Fixture) {
    return verifyLinxReleaseOperation({
      release,
      candidate,
      api: f.api,
      verify: f.verify,
      publish: f.publish,
    });
  }

  it.each(["moved", "deleted"])(
    "does not report success when the tag is %s during publication",
    async (change) => {
      const f = fixture();
      f.publish.mockImplementation(async () => {
        if (change === "moved") f.responses.set(refPath, reference(movedCommit));
        else f.responses.delete(refPath);
      });
      await expect(run(f)).rejects.toThrow();
      expect(f.publish).toHaveBeenCalledOnce();
    },
  );

  it.each([
    null,
    [],
    {},
    { ...reference(), ref: "refs/heads/main" },
    { ...reference(), ref: "refs/tags/v0.1.16" },
    reference(sourceCommit, "tree"),
    reference(sourceCommit, "blob"),
    reference("not-a-sha"),
    reference("A".repeat(40)),
    reference("a".repeat(39)),
  ])("rejects malformed or foreign references %#", async (value) => {
    const f = fixture();
    f.responses.set(refPath, value);
    await expect(run(f)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { sha: nestedTagSha, object: { type: "commit", sha: sourceCommit } },
    { sha: tagSha, object: { type: "tree", sha: sourceCommit } },
    { sha: tagSha, object: { type: "commit", sha: "bad" } },
    { sha: tagSha, object: { type: "commit", sha: movedCommit } },
  ])("rejects malformed, changed or noncommit annotated targets %#", async (value) => {
    const f = fixture();
    f.responses.set(refPath, reference(tagSha, "tag"));
    f.responses.set(`git/tags/${tagSha}`, value);
    await expect(run(f)).rejects.toThrow();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("rejects a deleted annotated object", async () => {
    const f = fixture();
    f.responses.set(refPath, reference(tagSha, "tag"));
    await expect(run(f)).rejects.toThrow("404");
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("bounds cyclic annotated tags to five object reads", async () => {
    const f = fixture();
    f.responses.set(refPath, reference(tagSha, "tag"));
    f.responses.set(`git/tags/${tagSha}`, { sha: tagSha, object: { type: "tag", sha: tagSha } });
    await expect(run(f)).rejects.toThrow("depth");
    expect(f.api).toHaveBeenCalledTimes(6);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([5, 6])("allows at most five annotated objects (chain length %s)", async (length) => {
    const f = fixture();
    const shas = Array.from({ length }, (_, index) => String(index + 1).repeat(40));
    f.responses.set(refPath, reference(shas[0], "tag"));
    for (const [index, sha] of shas.entries()) {
      f.responses.set(`git/tags/${sha}`, {
        sha,
        object:
          index === length - 1
            ? { type: "commit", sha: sourceCommit }
            : { type: "tag", sha: shas[index + 1] },
      });
    }
    if (length === 5) await expect(run(f)).resolves.toBeUndefined();
    else {
      await expect(run(f)).rejects.toThrow("depth");
      expect(f.publish).not.toHaveBeenCalled();
    }
  });

  it.each([
    { ...release, tag_name: "v0.1.16" },
    { ...release, target_commitish: movedCommit },
    { ...release, prerelease: true },
  ])("preserves release metadata binding %#", async (changed) => {
    const f = fixture();
    await expect(
      verifyLinxReleaseOperation({
        release: changed,
        candidate,
        api: f.api,
        verify: f.verify,
        publish: f.publish,
      }),
    ).rejects.toThrow("Release source changed");
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not publish after failed asset verification", async () => {
    const f = fixture();
    f.verify.mockRejectedValue(new Error("Remote digest changed"));
    await expect(run(f)).rejects.toThrow("Remote digest changed");
    expect(f.publish).not.toHaveBeenCalled();
  });
});
