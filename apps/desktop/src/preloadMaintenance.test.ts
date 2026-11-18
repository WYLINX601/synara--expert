import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  LinxUpdateWindowMaintenanceRequest,
  LinxUpdateWindowMaintenanceResponse,
} from "@synara/contracts";
import {
  parseLinxUpdateWindowMaintenanceRequest,
  parseLinxUpdateWindowMaintenanceResponse,
} from "./preloadMaintenance";

const attemptId = "123e4567-e89b-42d3-a456-426614174000";
const probeId = "123e4567-e89b-42d3-a456-426614174001";
const digest = "a".repeat(64);
const request = {
  schemaVersion: 1,
  action: "prepare",
  attemptId,
  probeId,
  backendStopped: true,
  manifestDigest: digest,
} as const;
const response = {
  schemaVersion: 1,
  attemptId,
  probeId,
  manifestDigest: digest,
  ready: true,
  unsavedEditors: 0,
  savingEditors: 0,
  message: null,
} as const;

function contractAccepts(
  schema: Schema.Top & { readonly DecodingServices: never },
  value: unknown,
): boolean {
  return Schema.decodeUnknownOption(schema)(value)._tag === "Some";
}

describe("preload maintenance parsers", () => {
  it.each([request, { ...request, action: "release" }, { ...request, backendStopped: false }])(
    "accepts request %#",
    (value) => {
      expect(parseLinxUpdateWindowMaintenanceRequest(value)).toEqual(value);
      expect(contractAccepts(LinxUpdateWindowMaintenanceRequest, value)).toBe(true);
    },
  );

  it.each([
    { ...request, action: "install" },
    { ...request, schemaVersion: 2 },
    { ...request, attemptId: "not-an-attempt" },
    { ...request, manifestDigest: "A".repeat(64) },
    { ...request, backendStopped: "yes" },
    { ...request, extra: true },
    { ...request, probeId: undefined },
  ])("rejects request %#", (value) => {
    expect(parseLinxUpdateWindowMaintenanceRequest(value)).toBeNull();
    expect(contractAccepts(LinxUpdateWindowMaintenanceRequest, value)).toBe(false);
  });

  it.each([
    response,
    { ...response, ready: false, unsavedEditors: 1, savingEditors: 2 },
    { ...response, message: "maintenance" },
    { ...response, message: "x".repeat(2_048) },
  ])("accepts response %#", (value) => {
    expect(parseLinxUpdateWindowMaintenanceResponse(value)).toEqual(value);
    expect(contractAccepts(LinxUpdateWindowMaintenanceResponse, value)).toBe(true);
  });

  it.each([
    { ...response, ready: true, unsavedEditors: 1 },
    { ...response, ready: true, savingEditors: 1 },
    { ...response, unsavedEditors: -1 },
    { ...response, savingEditors: 1.5 },
    { ...response, message: "" },
    { ...response, message: "x".repeat(2_049) },
    { ...response, extra: true },
  ])("rejects response %#", (value) => {
    expect(parseLinxUpdateWindowMaintenanceResponse(value)).toBeNull();
    expect(contractAccepts(LinxUpdateWindowMaintenanceResponse, value)).toBe(false);
  });
});
