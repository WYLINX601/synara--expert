import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLinxUpdateStaging,
  downloadLinxUpdateAsset,
  LinxUpdateDownloadError,
  type LinxUpdateDownloadTarget,
} from "./linxUpdateDownload";

const PAYLOAD = Buffer.from("linx-update-payload-0123456789");
const PAYLOAD_SHA256 = createHash("sha256").update(PAYLOAD).digest("hex");

let server: Server | null = null;
let stagingDir: string;

async function startServer(handler: (response: ServerResponse) => void): Promise<string> {
  server = createServer((_request, response) => handler(response));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function targetFor(overrides: Partial<LinxUpdateDownloadTarget>): LinxUpdateDownloadTarget {
  return {
    version: "0.2.0",
    assetName: "linx-0.2.0.zip",
    assetUrl: "http://127.0.0.1/asset.zip",
    size: PAYLOAD.byteLength,
    sha256: PAYLOAD_SHA256,
    ...overrides,
  };
}

beforeEach(async () => {
  stagingDir = await mkdtemp(join(tmpdir(), "linx-download-"));
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await rm(stagingDir, { force: true, recursive: true });
});

describe("downloadLinxUpdateAsset", () => {
  it("writes the verified package into staging and reports progress", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.byteLength) });
      response.end(PAYLOAD);
    });
    const progress: number[] = [];

    const result = await downloadLinxUpdateAsset({
      target: targetFor({ assetUrl: `${baseUrl}/asset.zip` }),
      stagingDir,
      allowedHosts: ["127.0.0.1"],
      onProgress: (percent) => progress.push(percent),
    });

    expect(result.size).toBe(PAYLOAD.byteLength);
    expect(result.sha256).toBe(PAYLOAD_SHA256);
    expect(result.filePath).toBe(join(stagingDir, "linx-0.2.0.zip"));
    expect(await readFile(result.filePath)).toEqual(PAYLOAD);
    expect(progress.at(-1)).toBe(100);
    expect(await readdir(stagingDir)).toEqual(["linx-0.2.0.zip"]);
  });

  it("discards the file when the streamed digest does not match", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.byteLength) });
      response.end(PAYLOAD);
    });

    await expect(
      downloadLinxUpdateAsset({
        target: targetFor({ assetUrl: `${baseUrl}/asset.zip`, sha256: "0".repeat(64) }),
        stagingDir,
        allowedHosts: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ reason: "sha256" });

    expect(await readdir(stagingDir)).toEqual([]);
  });

  it("discards a body longer than the manifest size", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200);
      response.write(PAYLOAD.subarray(0, 10));
      response.end(PAYLOAD);
    });

    await expect(
      downloadLinxUpdateAsset({
        target: targetFor({ assetUrl: `${baseUrl}/asset.zip`, size: 8 }),
        stagingDir,
        allowedHosts: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ reason: "size" });

    expect(await readdir(stagingDir)).toEqual([]);
  });

  it("discards a body shorter than the manifest size", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200);
      response.write(PAYLOAD);
      response.end();
    });

    await expect(
      downloadLinxUpdateAsset({
        target: targetFor({ assetUrl: `${baseUrl}/asset.zip`, size: PAYLOAD.byteLength + 1 }),
        stagingDir,
        allowedHosts: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ reason: "size" });

    expect(await readdir(stagingDir)).toEqual([]);
  });

  it("discards a package whose declared length disagrees with the manifest", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.byteLength + 5) });
      response.end(PAYLOAD);
    });

    await expect(
      downloadLinxUpdateAsset({
        target: targetFor({ assetUrl: `${baseUrl}/asset.zip` }),
        stagingDir,
        allowedHosts: ["127.0.0.1"],
      }),
    ).rejects.toMatchObject({ reason: "size" });
  });

  it("refuses an asset URL outside the allowed hosts", async () => {
    const error = await downloadLinxUpdateAsset({
      target: targetFor({ assetUrl: "http://127.0.0.1/asset.zip" }),
      stagingDir,
      allowedHosts: ["github.com"],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LinxUpdateDownloadError);
    expect(error).toMatchObject({ reason: "network" });
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it("aborts an in-flight transfer and leaves no partial file", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200);
      // Deliver one chunk, then stall; the client aborts from its progress signal.
      response.write(PAYLOAD.subarray(0, 4));
    });
    const controller = new AbortController();

    await expect(
      downloadLinxUpdateAsset({
        target: targetFor({ assetUrl: `${baseUrl}/asset.zip` }),
        stagingDir,
        allowedHosts: ["127.0.0.1"],
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ reason: "aborted" });

    expect(await readdir(stagingDir)).toEqual([]);
    await expect(stat(join(stagingDir, "linx-0.2.0.zip"))).rejects.toThrow();
  });
});

describe("clearLinxUpdateStaging", () => {
  it("removes the staging directory and everything in it", async () => {
    const baseUrl = await startServer((response) => {
      response.writeHead(200, { "content-length": String(PAYLOAD.byteLength) });
      response.end(PAYLOAD);
    });
    await downloadLinxUpdateAsset({
      target: targetFor({ assetUrl: `${baseUrl}/asset.zip` }),
      stagingDir,
      allowedHosts: ["127.0.0.1"],
    });

    await clearLinxUpdateStaging(stagingDir);

    await expect(stat(stagingDir)).rejects.toThrow();
  });
});
