import { ProjectId, type ContextApi, type NativeApi } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as nativeApi from "~/nativeApi";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";
import { readContextClient, readLegacyProjectInstructions } from "./contextClient";

const projectId = ProjectId.makeUnsafe("context-client-test-project");

describe("Context host client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    useProjectInstructionsStore.getState().clearInstructions(projectId);
  });

  it("returns the native Context API object unchanged and reports support separately", () => {
    const context = {} as ContextApi;
    const api = { context } as unknown as NativeApi;
    vi.spyOn(nativeApi, "readNativeApi").mockReturnValue(api);
    vi.spyOn(nativeApi, "readNativeApiServerCapability").mockReturnValue(true);

    const result = readContextClient();

    expect(result).toEqual({ supported: true, api: context });
    expect(result.api).toBe(context);
  });

  it("uses the latest original API object after the host replaces it", () => {
    const firstContext = {} as ContextApi;
    const secondContext = {} as ContextApi;
    const readApi = vi
      .spyOn(nativeApi, "readNativeApi")
      .mockReturnValue({ context: firstContext } as unknown as NativeApi);
    vi.spyOn(nativeApi, "readNativeApiServerCapability").mockReturnValue(true);

    expect(readContextClient().api).toBe(firstContext);
    readApi.mockReturnValue({ context: secondContext } as unknown as NativeApi);
    expect(readContextClient().api).toBe(secondContext);
  });

  it("keeps an unsupported capability distinct from an absent Context API", () => {
    const context = {} as ContextApi;
    vi.spyOn(nativeApi, "readNativeApi").mockReturnValue({ context } as unknown as NativeApi);
    vi.spyOn(nativeApi, "readNativeApiServerCapability").mockReturnValue(false);

    expect(readContextClient()).toEqual({ supported: false, api: context });
  });

  it("preserves supported status when the Context API is disconnected or absent", () => {
    vi.spyOn(nativeApi, "readNativeApi").mockReturnValue(undefined);
    vi.spyOn(nativeApi, "readNativeApiServerCapability").mockReturnValue(true);

    expect(readContextClient()).toEqual({ supported: true, api: null });
  });

  it("reads legacy instructions without changing the persisted store", () => {
    const instructions = "  preserve original spacing\nacross lines  ";
    useProjectInstructionsStore.getState().setInstructions(projectId, instructions);

    expect(readLegacyProjectInstructions(projectId)).toBe(instructions);
    expect(useProjectInstructionsStore.getState().instructionsByProjectId[projectId]).toBe(
      instructions,
    );
  });
});
