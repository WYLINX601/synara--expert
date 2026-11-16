import type {
  DesktopBridge,
  LinxUpdateWindowMaintenanceRequest,
  NativeApi,
  ProjectReadFileResult,
} from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  useComposerDraftStore,
  composerDraftDurabilitySnapshot,
  captureComposerPromptHistorySavedDraft,
} from "~/composerDraftStore";
import { useStore, persistAppStateNow } from "~/store";
import { PERSISTED_STATE_KEY } from "~/storePersistence";
import { composerPersistenceOperationCount } from "./composerPersistenceActivity";
import {
  persistComposerImageBlob,
  readComposerImageBlob,
  deleteComposerImageBlob,
} from "./composerImageBlobStore";
import { installLinxUpdateWindowMaintenance } from "./linxUpdateWindowMaintenance";
import type { DeferredPersistStorage } from "./storage";
import type { PersistedComposerDraftStoreState } from "~/composerDraftPersistence";
import { makeFile, makeQueuedChatTurn } from "~/composerDraftStoreTestFixtures";
import { readFileAsDataUrl } from "./composerSend";
import "~/components/codeEditor/editorRuntime";
import { acquireEditorModel, applyEditorEdits } from "~/components/codeEditor/editorModels";
import { getWorkspaceEditorSession } from "./workspaceEditorSession";
import type * as NativeApiModule from "~/nativeApi";

// Only the native I/O boundary is isolated; storage, hydration and Monaco remain real.
const { nativeIo } = vi.hoisted(() => ({
  nativeIo: {
    projects: {
      readFile: vi.fn<NativeApi["projects"]["readFile"]>(),
      writeFile: vi.fn<NativeApi["projects"]["writeFile"]>(),
    } satisfies Pick<NativeApi["projects"], "readFile" | "writeFile">,
  },
}));
vi.mock("~/nativeApi", async (original) => ({
  ...(await original<typeof NativeApiModule>()),
  ensureNativeApi: () => nativeIo,
  readNativeApiServerConnection: () => ({ generation: "isolated-native-fixture", connected: true }),
}));
const originalState = useStore.getState();
const originalDrafts = useComposerDraftStore.getState();
const threadId = ThreadId.makeUnsafe("update-durability-fixture");
const digest = "a".repeat(64);
let sequence = 0;
let dispose: (() => void) | undefined;
const blobKeys: string[] = [];
const previewUrls: string[] = [];
const draftStorage = useComposerDraftStore.persist.getOptions()
  .storage as DeferredPersistStorage<PersistedComposerDraftStoreState>;
function prepareHarness() {
  let receive!: (request: LinxUpdateWindowMaintenanceRequest) => void;
  const reply = vi.fn();
  const bridge: NonNullable<DesktopBridge["updateWindowMaintenance"]> = {
    onRequest: (listener) => {
      receive = listener;
      return () => {};
    },
    reply,
  };
  dispose = installLinxUpdateWindowMaintenance(bridge);
  return {
    reply,
    prepare: () => {
      const request: LinxUpdateWindowMaintenanceRequest = {
        schemaVersion: 1,
        action: "prepare",
        manifestDigest: digest,
        attemptId: `12345678-1234-4234-8234-${String(++sequence).padStart(12, "0")}`,
        probeId: crypto.randomUUID(),
        backendStopped: false,
      };
      receive(request);
      return () => receive({ ...request, action: "release" });
    },
  };
}
beforeEach(async () => {
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });
  useComposerDraftStore.setState({
    draftsByThreadId: {},
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  persistAppStateNow();
  draftStorage.flush();
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
});
afterEach(async () => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  for (const key of blobKeys.splice(0)) await deleteComposerImageBlob(key);
  for (const url of previewUrls.splice(0)) URL.revokeObjectURL(url);
  useComposerDraftStore.setState(originalDrafts, true);
  draftStorage.flush();
  useStore.setState({ ...originalState, threadsHydrated: true }, true);
  persistAppStateNow();
});

it("refuses real debounced app metadata and drafts without flushing them, then holds and releases the producer fence", async () => {
  const f = prepareHarness();
  const previousMetadata = localStorage.getItem(PERSISTED_STATE_KEY);
  useStore.setState({ projects: [] });
  useComposerDraftStore.getState().setPrompt(threadId, "unsent but recoverable");
  expect(composerPersistenceOperationCount()).toBeGreaterThan(0);
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  expect(localStorage.getItem(PERSISTED_STATE_KEY)).toBe(previousMetadata);
  expect(document.body.inert).toBe(false);
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
  const release = f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  expect(document.body.inert).toBe(true);
  expect(() => useComposerDraftStore.getState().setPrompt(threadId, "blocked")).toThrow("paused");
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
    "unsent but recoverable",
  );
  release();
  expect(document.body.inert).toBe(false);
  useComposerDraftStore.getState().setPrompt(threadId, "editing resumes");
});

it("keeps transient images unsafe through an in-flight blob commit, then accepts the actually committed draft and blob", async () => {
  const f = prepareHarness();
  const file = new File(["real image fixture"], "capture.png", { type: "image/png" });
  const previewUrl = URL.createObjectURL(file);
  previewUrls.push(previewUrl);
  const image = {
    type: "image" as const,
    id: "image-durable",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl,
  };
  useComposerDraftStore.getState().addImage(threadId, image);
  draftStorage.flush();
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(1);
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  const pending = persistComposerImageBlob({ threadId, imageId: image.id, file });
  expect(composerPersistenceOperationCount()).toBeGreaterThan(0);
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  const blobKey = await pending;
  blobKeys.push(blobKey);
  expect(
    await useComposerDraftStore.getState().syncPersistedAttachments(threadId, [
      {
        id: image.id,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        blobKey,
      },
    ]),
  ).toBe("persisted");
  draftStorage.flush();
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(0);
  const release = f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  await expect(
    persistComposerImageBlob({ threadId, imageId: "must-not-start", file }),
  ).rejects.toThrow("paused");
  expect(await (await readComposerImageBlob(blobKey))?.text()).toBe("real image fixture");
  release();
  const persisted = await draftStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY);
  expect(persisted?.state.draftsByThreadId[threadId]?.attachments[0]?.blobKey).toBe(blobKey);
  expect(
    useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments[0]?.blobKey,
  ).toBe(blobKey);
});

it("does not mistake an aborted IndexedDB write for a durable image", async () => {
  const f = prepareHarness();
  const file = new File(["not committed"], "failed.png", { type: "image/png" });
  const previewUrl = URL.createObjectURL(file);
  previewUrls.push(previewUrl);
  useComposerDraftStore.getState().addImage(threadId, {
    type: "image",
    id: "aborted-image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl,
  });
  draftStorage.flush();
  const originalPut = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(
    function (this: IDBObjectStore, value, key) {
      const request =
        key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      this.transaction.abort();
      return request;
    },
  );
  await expect(
    persistComposerImageBlob({ threadId, imageId: "aborted-image", file }),
  ).rejects.toThrow();
  expect(await readComposerImageBlob(`${threadId}:aborted-image`)).toBeNull();
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(1);
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
});

it("revokes ready synchronously on an accepted out-of-band store change rather than returning a stale acknowledgment", () => {
  const f = prepareHarness();
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  useComposerDraftStore.setState({ stickyActiveProvider: null });
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  expect(document.body.inert).toBe(false);
});

it("checks prompt-history and queued-image slots according to the real draft serialization rather than discarding their bytes", async () => {
  const f = prepareHarness();
  const file = new File(["saved image bytes"], "saved.png", { type: "image/png" });
  const previewUrl = URL.createObjectURL(file);
  previewUrls.push(previewUrl);
  const image = {
    type: "image" as const,
    id: "saved-image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    previewUrl,
  };
  const store = useComposerDraftStore.getState();
  store.addImage(threadId, image);
  store.setPromptHistorySavedDraft(
    threadId,
    captureComposerPromptHistorySavedDraft({
      threadId,
      draft: useComposerDraftStore.getState().draftsByThreadId[threadId]!,
      prompt: "",
    }),
  );
  store.removeImage(threadId, image.id);
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(1);
  store.enqueueQueuedTurn(threadId, makeQueuedChatTurn("queued-transient", image));
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(2);
  draftStorage.flush();
  f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
  store.setPromptHistorySavedDraft(threadId, null);
  store.removeQueuedTurn(threadId, "queued-transient");
  const dataUrl = await readFileAsDataUrl(file);
  store.enqueueQueuedTurn(
    threadId,
    makeQueuedChatTurn("queued-inline", { ...image, previewUrl: dataUrl }),
  );
  draftStorage.flush();
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
  expect(composerDraftDurabilitySnapshot().transientAttachments).toBe(0);
  const release = f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.queuedTurns).toHaveLength(1);
  release();
});

it.each(["live", "history", "queued"] as const)(
  "refuses an unsent document in the %s draft slot without discarding it",
  async (slot) => {
    const f = prepareHarness();
    const file = makeFile({
      id: `document-${slot}`,
      name: "notes.pdf",
      mimeType: "application/pdf",
    });
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadId, "Keep the unsent prompt");
    store.addFiles(threadId, [file]);
    if (slot === "history") {
      store.setPromptHistorySavedDraft(
        threadId,
        captureComposerPromptHistorySavedDraft({
          threadId,
          draft: useComposerDraftStore.getState().draftsByThreadId[threadId]!,
          prompt: "Keep the saved prompt",
        }),
      );
      store.removeFile(threadId, file.id);
    } else if (slot === "queued") {
      const turn = makeQueuedChatTurn("queued-document");
      if (turn.kind !== "chat") throw new Error("Expected a queued chat fixture");
      store.enqueueQueuedTurn(threadId, { ...turn, files: [file] });
      store.removeFile(threadId, file.id);
    }
    draftStorage.flush();
    await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
    f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    expect(document.body.inert).toBe(false);
    const draft = useComposerDraftStore.getState().draftsByThreadId[threadId]!;
    const queued = draft.queuedTurns.find((turn) => turn.id === "queued-document");
    const files =
      slot === "live"
        ? draft.files
        : slot === "history"
          ? draft.promptHistorySavedDraft!.files
          : queued?.kind === "chat"
            ? queued.files
            : [];
    expect(files[0]?.file).toBe(file.file);
    expect(draft.prompt).toBe("Keep the unsent prompt");
    if (slot === "live") store.removeFile(threadId, file.id);
    else if (slot === "history") store.setPromptHistorySavedDraft(threadId, null);
    else store.removeQueuedTurn(threadId, "queued-document");
    draftStorage.flush();
    await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
    const release = f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
    release();
  },
);

it("keeps a failed localStorage commit unsafe until the latest draft really reaches storage", async () => {
  const f = prepareHarness();
  const key = COMPOSER_DRAFT_STORAGE_KEY;
  const before = localStorage.getItem(key);
  const originalSetItem = Storage.prototype.setItem;
  const failedWrite = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new DOMException("Fixture quota exhausted", "QuotaExceededError");
      originalSetItem.call(this, name, value);
    });
  try {
    useComposerDraftStore.getState().setPrompt(threadId, "retain me after quota failure");
    expect(() => draftStorage.flush()).toThrow("Fixture quota exhausted");
    expect(composerPersistenceOperationCount()).toBeGreaterThan(0);
    f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    expect(document.body.inert).toBe(false);
    expect(localStorage.getItem(key)).toBe(before);
  } finally {
    failedWrite.mockRestore();
    draftStorage.flush();
  }
  expect((await draftStorage.getItem(key))?.state.draftsByThreadId[threadId]?.prompt).toBe(
    "retain me after quota failure",
  );
  await vi.waitFor(() => expect(composerPersistenceOperationCount()).toBe(0));
  const release = f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  release();
});

it("refuses while real draft rehydration is unresolved and accepts only after the stored draft is restored", async () => {
  const f = prepareHarness();
  useComposerDraftStore.getState().setPrompt(threadId, "restore these stored bytes");
  draftStorage.flush();
  const read = Promise.withResolvers<void>();
  useComposerDraftStore.persist.setOptions({
    storage: {
      ...draftStorage,
      getItem: async (name) => {
        await read.promise;
        return draftStorage.getItem(name);
      },
    },
  });
  const hydration = useComposerDraftStore.persist.rehydrate();
  try {
    expect(composerDraftDurabilitySnapshot().hydrated).toBe(false);
    f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    expect(document.body.inert).toBe(false);
  } finally {
    read.resolve();
    await hydration;
    useComposerDraftStore.persist.setOptions({ storage: draftStorage });
  }
  expect(composerDraftDurabilitySnapshot().hydrated).toBe(true);
  expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.prompt).toBe(
    "restore these stored bytes",
  );
  const release = f.prepare();
  expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  release();
});

it("refuses actual Monaco refactor preparation and dirty edits, then fences the clean model until release", async () => {
  const f = prepareHarness();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const data: ProjectReadFileResult = {
    relativePath: "durability.ts",
    contents: "original",
    version: "sha256:original",
    encoding: "utf8",
    lineEnding: "lf",
    truncated: false,
  };
  const session = getWorkspaceEditorSession(client, "/durability-fixture", data.relativePath);
  session.load(data);
  session.pause();
  const handle = acquireEditorModel(
    client,
    "/durability-fixture",
    data.relativePath,
    data.contents,
    session.getSnapshot().version,
  );
  const read = Promise.withResolvers<ProjectReadFileResult>();
  nativeIo.projects.readFile.mockReturnValueOnce(read.promise);
  const pending = applyEditorEdits(handle.entry, [
    {
      relativePath: data.relativePath,
      expectedContents: data.contents,
      edits: [{ start: 0, length: data.contents.length, newText: "unsaved refactor" }],
    },
  ]);
  try {
    await vi.waitFor(() => expect(nativeIo.projects.readFile).toHaveBeenCalledOnce());
    expect(composerPersistenceOperationCount()).toBeGreaterThan(0);
    f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));
    expect(handle.entry.model.getValue()).toBe("original");
    read.resolve(data);
    await pending;
    expect(handle.entry.model.getValue()).toBe("unsaved refactor");
    f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({ ready: false, unsavedEditors: 1 }),
    );
    expect(nativeIo.projects.writeFile).not.toHaveBeenCalled();
    await handle.entry.model.undo();
    expect(session.dirty).toBe(false);
    const release = f.prepare();
    expect(f.reply).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
    handle.entry.model.setValue("blocked while held");
    expect(handle.entry.model.getValue()).toBe("original");
    expect(session.getSnapshot().value).toBe("original");
    release();
    handle.entry.model.setValue("editing resumes");
    expect(session.getSnapshot().value).toBe("editing resumes");
    expect(nativeIo.projects.writeFile).not.toHaveBeenCalled();
  } finally {
    read.resolve(data);
    await pending;
    dispose?.();
    dispose = undefined;
    session.change(data.contents);
    handle.release();
    handle.entry.dispose();
    client.clear();
  }
});
