import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  LinxUpdateInstallRequest,
  LinxUpdateMaintenanceResponse,
  LinxUpdateWindowMaintenanceResponse,
  LinxUpdateWindowMaintenanceRequest,
} from "./linxUpdateInstall";

const attemptId = "dc74e8ae-c431-43fc-a418-ef3525cddf26";
const manifestDigest = "a".repeat(64);
const clearBusyState = {
  activeTurns: 0,
  pendingApprovals: 0,
  pendingUserInputs: 0,
  backgroundTasks: 0,
  acceptedWrites: 0,
};
const readyResponse = {
  schemaVersion: 1,
  attemptId,
  manifestDigest,
  status: "ready",
  busy: clearBusyState,
  message: null,
};

const request = {
  schemaVersion: 1,
  attemptId,
  requestedAt: "2026-11-13T12:00:00.000Z",
  fromVersion: "0.1.15",
  toVersion: "0.1.16",
  manifestDigest,
  manifestPath: "/private/tmp/linx/profile/linx-update-staging/linx-update.json",
  signaturePath: "/private/tmp/linx/profile/linx-update-staging/linx-update.json.sig",
  packagePath: "/private/tmp/linx/profile/linx-update-staging/Linx.zip",
  applicationPath: "/private/tmp/linx/Applications/Linx.app",
  homePath: "/private/tmp/linx/home/.linx",
  userDataPath: "/private/tmp/linx/profile",
  parentPid: 123,
  authorizationDigest: "b".repeat(64),
};

const decodeMaintenance = Schema.decodeUnknownSync(LinxUpdateMaintenanceResponse);
const decodeInstallRequest = Schema.decodeUnknownSync(LinxUpdateInstallRequest);

describe("Linx maintenance admission", () => {
  it("admits readiness when every owned activity is proven idle", () => {
    expect(Schema.is(LinxUpdateMaintenanceResponse)(readyResponse)).toBe(true);
  });

  it.each([
    "activeTurns",
    "pendingApprovals",
    "pendingUserInputs",
    "backgroundTasks",
    "acceptedWrites",
  ])("cannot report readiness while %s remain", (field) => {
    expect(() =>
      decodeMaintenance({
        ...readyResponse,
        busy: { ...clearBusyState, [field]: 1 },
      }),
    ).toThrow();
  });

  it.each(["ready", "committed"])("cannot report %s when live state is unknown", (status) => {
    expect(() => decodeMaintenance({ ...readyResponse, status, busy: null })).toThrow();
  });

  it("preserves unknown state as a blocked decision rather than claiming idle", () => {
    const blocked = decodeMaintenance({
      ...readyResponse,
      status: "blocked",
      busy: null,
      message: "Live activity could not be verified.",
    });
    expect(blocked.status).toBe("blocked");
    expect(blocked.busy).toBeNull();
  });

  it.each([
    { unsavedEditors: 1, savingEditors: 0 },
    { unsavedEditors: 0, savingEditors: 1 },
  ])("cannot acknowledge a window with uncommitted edits: %j", (editors) => {
    expect(() =>
      Schema.decodeUnknownSync(LinxUpdateWindowMaintenanceResponse)({
        schemaVersion: 1,
        attemptId,
        probeId: attemptId,
        manifestDigest,
        ready: true,
        ...editors,
        message: null,
      }),
    ).toThrow();
  });

  it("requires a UUIDv4 probe binding for both directions without accepting the retired shape", () => {
    const windowRequest = {
      schemaVersion: 1,
      action: "prepare",
      attemptId,
      probeId: attemptId,
      backendStopped: false,
      manifestDigest,
    };
    const windowResponse = {
      schemaVersion: 1,
      attemptId,
      probeId: attemptId,
      manifestDigest,
      ready: true,
      unsavedEditors: 0,
      savingEditors: 0,
      message: null,
    };
    expect(Schema.is(LinxUpdateWindowMaintenanceRequest)(windowRequest)).toBe(true);
    expect(Schema.is(LinxUpdateWindowMaintenanceResponse)(windowResponse)).toBe(true);
    for (const probeId of [undefined, "", "not-a-uuid", "dc74e8ae-c431-13fc-a418-ef3525cddf26"]) {
      expect(() =>
        Schema.decodeUnknownSync(LinxUpdateWindowMaintenanceRequest)({ ...windowRequest, probeId }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(LinxUpdateWindowMaintenanceResponse)({
          ...windowResponse,
          probeId,
        }),
      ).toThrow();
    }
    for (const backendStopped of [undefined, null, "true", 1]) {
      expect(() =>
        Schema.decodeUnknownSync(LinxUpdateWindowMaintenanceRequest)({
          ...windowRequest,
          backendStopped,
        }),
      ).toThrow();
    }
  });
});

describe("Linx helper request boundary", () => {
  it("admits a canonical parent-bound request for helper-side verification", () => {
    expect(Schema.is(LinxUpdateInstallRequest)(request)).toBe(true);
  });

  it.each([
    "Linx.app",
    "/",
    "/Applications/../Linx.app",
    "/Applications/./Linx.app",
    "/Applications//Linx.app",
    "/Applications/Linx.app/",
    "/Applications/Linx.app\0",
    "/Applications/Linx.app\n",
  ])("rejects a noncanonical target %j before filesystem access", (applicationPath) => {
    expect(() => decodeInstallRequest({ ...request, applicationPath })).toThrow();
  });

  it.each([0, -1, 1.5, 2_147_483_648])("rejects an invalid parent pid %j", (parentPid) => {
    expect(() => decodeInstallRequest({ ...request, parentPid })).toThrow();
  });

  it("does not admit a caller-supplied trust root", () => {
    expect(() => decodeInstallRequest({ ...request, keyRing: { attacker: "AAAA" } })).toThrow();
  });

  it("does not accept missing authorization binding", () => {
    const unsignedRequest = { ...request };
    Reflect.deleteProperty(unsignedRequest, "authorizationDigest");
    expect(() => decodeInstallRequest(unsignedRequest)).toThrow();
  });
});
