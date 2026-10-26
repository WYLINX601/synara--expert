import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  access: { canManage: false } as { canManage: boolean },
  credentials: [] as unknown[],
  createPairing: vi.fn(async () => ({
    code: "short-lived-code",
    expiresAt: "2026-10-26T03:00:00.000Z",
    instanceId: "test-instance",
    flavor: "development",
    endpoint: "http://127.0.0.1:8123",
    homeDir: "/tmp/synara-test-home",
  })),
  listCredentials: vi.fn(async () => [] as unknown[]),
  revokeCredential: vi.fn(async () => ({ revoked: true })),
  invalidations: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { readonly queryKey: ReadonlyArray<string> }) => ({
    isPending: false,
    isError: false,
    isFetching: false,
    data:
      options.queryKey.at(-1) === "skillManagementAccess" ? harness.access : harness.credentials,
    refetch: vi.fn(),
  }),
  useMutation: (options: {
    readonly mutationFn: (credentialId?: string) => Promise<unknown>;
    readonly onSuccess?: (result: unknown, credentialId?: string) => void;
    readonly onError?: (error: unknown) => void;
  }) => ({
    isPending: false,
    mutate: (credentialId?: string) => {
      void options
        .mutationFn(credentialId)
        .then((result) => options.onSuccess?.(result, credentialId))
        .catch((error) => options.onError?.(error));
    },
  }),
  useQueryClient: () => ({ invalidateQueries: harness.invalidations }),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
}));

vi.mock("~/hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: vi.fn(async () => undefined),
}));

vi.mock("~/workbench/host/expertClient", () => ({
  ensureExpertClient: () => ({
    readSkillManagementAccess: async () => harness.access,
    createSkillManagementPairing: harness.createPairing,
    listSkillManagementCredentials: harness.listCredentials,
    revokeSkillManagementCredential: harness.revokeCredential,
  }),
}));

import { SkillManagementPairingSettingsPanel } from "./SkillManagementPairingSettingsPanel";

afterEach(() => {
  document.body.innerHTML = "";
  harness.access = { canManage: false };
  harness.credentials = [];
  harness.createPairing.mockClear();
  harness.listCredentials.mockClear();
  harness.revokeCredential.mockClear();
  vi.restoreAllMocks();
});

describe("SkillManagementPairingSettingsPanel", () => {
  it("shows pairing only when the authenticated socket reports local owner access", async () => {
    const view = await render(<SkillManagementPairingSettingsPanel active />);
    await expect
      .element(page.getByRole("button", { name: "Create pairing code" }))
      .not.toBeInTheDocument();

    harness.access = { canManage: true };
    await view.rerender(<SkillManagementPairingSettingsPanel active />);
    await page.getByRole("button", { name: "Create pairing code" }).click();
    await vi.waitFor(() => expect(harness.createPairing).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.body.textContent).toContain("short-lived-code"));
  });
});
