import "../index.css";

import { ThreadId, type ProviderKind, type ProviderMentionReference } from "@synara/contracts";
import { buildHubDeliverableReferenceUri } from "@synara/shared/hubReferences";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { renderHook } from "vitest-browser-react";
import { createRef } from "react";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { InlineMentionChip } from "./chat/InlineMentionChip";
import {
  normalizeCurrentPersistedComposerDraftStoreState,
  toHydratedThreadDraft,
} from "../composerDraftPersistence";
import { partializeComposerDraftStoreState, useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { useComposerReferences } from "./chat/useComposerReferences";
import { formatComposerMentionToken } from "../lib/composerMentions";

const threadId = ThreadId.makeUnsafe("hub-reference-browser");
const emptySkills: [] = [];

function makeVersion(revision: number): ProviderMentionReference {
  return {
    name: "brief.md",
    path: buildHubDeliverableReferenceUri({
      hubId: "design-hub",
      workerThreadId: "worker-1",
      path: "brief.md",
      revision,
    }),
  };
}

function token(mention: ProviderMentionReference): string {
  return formatComposerMentionToken(mention.path);
}

afterEach(() => {
  resetComposerDraftStore();
  localStorage.clear();
  document.body.innerHTML = "";
});

it("renders restored same-name Hub versions as readable composer chips", async () => {
  const v1 = makeVersion(1);
  const v2 = makeVersion(2);
  const prompt = `Compare ${token(v1)} with ${token(v2)} now`;
  useComposerDraftStore.getState().setPrompt(threadId, prompt);
  useComposerDraftStore.getState().setMentions(threadId, [v1, v2]);

  const persisted = normalizeCurrentPersistedComposerDraftStoreState(
    JSON.parse(JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState()))),
  );
  const restored = toHydratedThreadDraft(threadId, persisted.draftsByThreadId[threadId]!);
  const editorRef = createRef<ComposerPromptEditorHandle>();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerPromptEditor
      ref={editorRef}
      value={restored.prompt}
      cursor={restored.prompt.length}
      terminalContexts={[]}
      mentionReferences={restored.mentions}
      disabled={false}
      placeholder="Ask something"
      onRemoveTerminalContext={() => undefined}
      onChange={() => undefined}
      onPaste={() => undefined}
    />,
    { container: host },
  );

  try {
    const editor = host.querySelector<HTMLElement>('[data-testid="composer-editor"]');
    expect(editor).not.toBeNull();
    const chips = Array.from(editor!.querySelectorAll<HTMLElement>('[contenteditable="false"]'));
    expect(chips.map((chip) => chip.textContent)).toEqual(["brief.md", "brief.md"]);
    expect(editor!.textContent).not.toContain("synara://");
    expect(editorRef.current?.readSnapshot().value).toBe(prompt);
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("renders a sent Hub mention as a readable non-openable chip", async () => {
  const v1 = makeVersion(1);
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <InlineMentionChip path={v1.path} theme="dark" mentionReferences={[v1]} />,
    { container: host },
  );

  try {
    const chip = host.querySelector<HTMLElement>("[title]");
    expect(chip?.textContent).toBe("brief.md");
    expect(chip?.title).toBe("brief.md");
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).not.toContain("synara://");
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("restores Hub references across Provider changes and removes only the exact version token", async () => {
  const v1 = makeVersion(1);
  const v2 = makeVersion(2);
  const nativeMention = { name: "Linear", path: "plugin://linear@openai-curated" };
  const allMentions = [v1, v2, nativeMention];
  const prompt = `Compare ${token(v1)} and ${token(v2)} with @Linear now`;
  useComposerDraftStore.getState().setPrompt(threadId, prompt);
  useComposerDraftStore.getState().setMentions(threadId, allMentions);
  const persisted = normalizeCurrentPersistedComposerDraftStoreState(
    JSON.parse(JSON.stringify(partializeComposerDraftStoreState(useComposerDraftStore.getState()))),
  );
  const restoredMentions = toHydratedThreadDraft(
    threadId,
    persisted.draftsByThreadId[threadId]!,
  ).mentions;
  const initialProps = { provider: "codex" as ProviderKind, prompt };
  const hook = await renderHook(
    (props?: { provider: ProviderKind; prompt: string }) =>
      useComposerReferences({
        threadId,
        selectedProvider: props?.provider ?? initialProps.provider,
        prompt: props?.prompt ?? initialProps.prompt,
        composerSkills: emptySkills,
        composerMentions: restoredMentions,
      }),
    { initialProps },
  );

  try {
    expect(hook.result.current.selectedComposerMentions).toEqual(allMentions);

    await hook.rerender({ provider: "claudeAgent", prompt });
    await expect.poll(() => hook.result.current.selectedComposerMentions).toEqual([v1, v2]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.mentions).toEqual([v1, v2]);

    await hook.rerender({ provider: "claudeAgent", prompt: `Use ${token(v2)} now` });
    await expect.poll(() => hook.result.current.selectedComposerMentions).toEqual([v2]);
    expect(useComposerDraftStore.getState().draftsByThreadId[threadId]?.mentions).toEqual([v2]);
  } finally {
    await hook.unmount();
  }
});
