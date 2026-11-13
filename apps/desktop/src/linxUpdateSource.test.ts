import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildLinxUpdateManifestUrl,
  buildLinxUpdateReleaseUrl,
  buildLinxUpdateSignatureUrl,
  LINX_UPDATE_ALLOWED_HOSTS,
  LINX_UPDATE_SOURCE_FILE_NAME,
  loadLinxUpdateSource,
  parseLinxUpdateSource,
  resolveLinxUpdateSourceForFlavor,
} from "./linxUpdateSource";

function makeKeyRingEntry(): { keyId: string; encoded: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(der).digest("hex").slice(0, 16);
  return { keyId, encoded: Buffer.from(der).toString("base64") };
}

function validSourceJson(repository = "wylinx/linx"): string {
  const entry = makeKeyRingEntry();
  return JSON.stringify({ repository, keyRing: { [entry.keyId]: entry.encoded } });
}

describe("parseLinxUpdateSource", () => {
  it("derives the fixed GitHub URLs and the allowed host list", () => {
    const source = parseLinxUpdateSource(validSourceJson("owner/repo"));

    expect(source).not.toBeNull();
    expect(source?.repository).toBe("owner/repo");
    expect(source?.keyRing.size).toBe(1);
    expect(source?.manifestUrl).toBe(
      "https://github.com/owner/repo/releases/latest/download/linx-update.json",
    );
    expect(source?.signatureUrl).toBe(
      "https://github.com/owner/repo/releases/latest/download/linx-update.json.sig",
    );
    expect(source?.releaseUrl).toBe("https://github.com/owner/repo/releases/latest");
    expect(source?.allowedAssetHosts).toEqual([...LINX_UPDATE_ALLOWED_HOSTS]);
  });

  it("rejects malformed JSON and non-object documents", () => {
    expect(parseLinxUpdateSource("{")).toBeNull();
    expect(parseLinxUpdateSource("[]")).toBeNull();
    expect(parseLinxUpdateSource("null")).toBeNull();
    expect(parseLinxUpdateSource("")).toBeNull();
  });

  it("rejects repositories that are not a bare owner/repo slug", () => {
    for (const repository of [
      "",
      "owner",
      "owner/repo/extra",
      "https://github.com/owner/repo",
      "owner/repo ",
      "owner/repo\n",
      "owner/repo\r\n",
      "/repo",
      "owner/",
      "../repo",
    ]) {
      expect(parseLinxUpdateSource(validSourceJson(repository))).toBeNull();
    }
  });

  it("rejects missing, empty, and malformed key rings", () => {
    const { keyId, encoded } = makeKeyRingEntry();

    expect(parseLinxUpdateSource(JSON.stringify({ repository: "owner/repo" }))).toBeNull();
    expect(
      parseLinxUpdateSource(JSON.stringify({ repository: "owner/repo", keyRing: {} })),
    ).toBeNull();
    expect(
      parseLinxUpdateSource(JSON.stringify({ repository: "owner/repo", keyRing: [] })),
    ).toBeNull();
    expect(
      parseLinxUpdateSource(
        JSON.stringify({ repository: "owner/repo", keyRing: { [keyId]: "not-base64" } }),
      ),
    ).toBeNull();
    // Declared keyId that does not derive from its own key material.
    expect(
      parseLinxUpdateSource(
        JSON.stringify({ repository: "owner/repo", keyRing: { "0000000000000000": encoded } }),
      ),
    ).toBeNull();
  });

  it("rejects unknown top-level fields", () => {
    const entry = makeKeyRingEntry();
    expect(
      parseLinxUpdateSource(
        JSON.stringify({
          repository: "owner/repo",
          keyRing: { [entry.keyId]: entry.encoded },
          channel: "beta",
        }),
      ),
    ).toBeNull();
  });
});

describe("URL builders", () => {
  it("pin the latest-release download path", () => {
    expect(buildLinxUpdateManifestUrl("a/b")).toBe(
      "https://github.com/a/b/releases/latest/download/linx-update.json",
    );
    expect(buildLinxUpdateSignatureUrl("a/b")).toBe(
      "https://github.com/a/b/releases/latest/download/linx-update.json.sig",
    );
    expect(buildLinxUpdateReleaseUrl("a/b")).toBe("https://github.com/a/b/releases/latest");
  });
});

describe("loadLinxUpdateSource", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "linx-source-"));
  });

  afterEach(async () => {
    await rm(tempDir, { force: true, recursive: true });
  });

  it("returns null when the source file is missing", () => {
    expect(loadLinxUpdateSource(join(tempDir, LINX_UPDATE_SOURCE_FILE_NAME))).toBeNull();
  });

  it("reads a valid packaged file", async () => {
    const filePath = join(tempDir, LINX_UPDATE_SOURCE_FILE_NAME);
    await writeFile(filePath, validSourceJson("owner/repo"), "utf8");

    expect(loadLinxUpdateSource(filePath)?.repository).toBe("owner/repo");
  });

  it("never activates for a flavor other than workbench", () => {
    const loaded: string[] = [];
    const source = resolveLinxUpdateSourceForFlavor({
      flavor: "production",
      sourcePath: "/resources/linx-update-source.json",
      load: (path) => {
        loaded.push(path);
        return { repository: "owner/repo" } as never;
      },
    });

    expect(source).toBeNull();
    expect(loaded).toEqual([]);
  });

  it("stays unconfigured when no packaged source file exists", () => {
    expect(resolveLinxUpdateSourceForFlavor({ flavor: "workbench", sourcePath: null })).toBeNull();
  });

  it("loads the packaged file for the workbench flavor", () => {
    const source = resolveLinxUpdateSourceForFlavor({
      flavor: "workbench",
      sourcePath: "/resources/linx-update-source.json",
      load: (path) => ({ repository: `loaded:${path}` }) as never,
    });

    expect(source?.repository).toBe("loaded:/resources/linx-update-source.json");
  });

  it("treats an oversized file as unconfigured", async () => {
    const filePath = join(tempDir, LINX_UPDATE_SOURCE_FILE_NAME);
    await writeFile(
      filePath,
      `{"repository":"owner/repo","keyRing":{}}${" ".repeat(70_000)}`,
      "utf8",
    );

    expect(loadLinxUpdateSource(filePath)).toBeNull();
  });
});
