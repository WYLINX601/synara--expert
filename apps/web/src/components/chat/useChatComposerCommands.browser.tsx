import { ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import { useChatComposerCommands } from "./useChatComposerCommands";
import { useAmbientContextBindingStore } from "~/ambientContextBindingStore";

function fixture() {
  const prompt = "Keep @nomatching";
  const input = {
    threadId: ThreadId.makeUnsafe("mention-keys"),
    mentionTab: "files",
    onMentionTabChange: vi.fn(),
    composerMenuOpenRef: { current: true },
    composerSelectLockRef: { current: false },
    composerMenuItems: [],
    composerMenuItemsRef: { current: [] },
    activeComposerMenuItemRef: { current: null },
    resolveActiveComposerTrigger: () => ({
      snapshot: {
        value: prompt,
        cursor: prompt.length,
        expandedCursor: prompt.length,
        selectionCollapsed: true,
      },
      trigger: { kind: "mention", query: "nomatching", rangeStart: 5, rangeEnd: prompt.length },
    }),
    setComposerTrigger: vi.fn(),
    setComposerCommandPicker: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    promptHistoryNavigationRef: { current: null },
    expectedPromptHistoryPromptRef: { current: null },
    pendingUserInputs: [],
    settings: { followUpBehavior: "queue" },
    hasLiveTurn: false,
    onSend: vi.fn(async () => true),
    applyComposerTriggerReplacement: vi.fn((args: { onApplied?: () => void }) => {
      args.onApplied?.();
      return 0;
    }),
  };
  return { input, hookInput: input as unknown as Parameters<typeof useChatComposerCommands>[0] };
}

describe("composer context keyboard", () => {
  it("switches tabs without editing text and ignores composing navigation", async () => {
    const { input, hookInput } = fixture();
    const hook = await renderHook(() => useChatComposerCommands(hookInput));
    expect(
      hook.result.current.onComposerCommandKey(
        "ArrowRight",
        new KeyboardEvent("keydown", { key: "ArrowRight" }),
      ),
    ).toBe(true);
    expect(input.onMentionTabChange).toHaveBeenCalledExactlyOnceWith("context");
    expect(input.applyComposerTriggerReplacement).not.toHaveBeenCalled();
    expect(
      hook.result.current.onComposerCommandKey(
        "ArrowRight",
        new KeyboardEvent("keydown", { key: "ArrowRight", isComposing: true }),
      ),
    ).toBe(false);
    expect(input.onMentionTabChange).toHaveBeenCalledTimes(1);
    await hook.unmount();
  });
  it("dismisses an empty menu then sends the unchanged literal mention on Enter", async () => {
    const { input, hookInput } = fixture();
    const hook = await renderHook(() => useChatComposerCommands(hookInput));
    expect(
      hook.result.current.onComposerCommandKey(
        "Enter",
        new KeyboardEvent("keydown", { key: "Enter" }),
      ),
    ).toBe(true);
    expect(input.onSend).not.toHaveBeenCalled();
    hook.result.current.onComposerCommandKey(
      "Escape",
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    expect(input.setComposerTrigger).toHaveBeenCalledWith(null);
    input.composerMenuOpenRef.current = false;
    hook.result.current.onComposerCommandKey(
      "Enter",
      new KeyboardEvent("keydown", { key: "Enter" }),
    );
    expect(input.onSend).toHaveBeenCalledOnce();
    expect(input.applyComposerTriggerReplacement).not.toHaveBeenCalled();
    await hook.unmount();
  });
  it("selects a vault as a thread binding rather than an inline file mention", async () => {
    const { input, hookInput } = fixture();
    useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
    const hook = await renderHook(() => useChatComposerCommands(hookInput));
    hook.result.current.onSelectComposerItem({
      id: "paper",
      type: "ambient-connection",
      label: "Paper",
      description: "",
      connection: { id: "paper", sourceId: "paper", label: "Paper" },
    });
    expect(input.applyComposerTriggerReplacement).toHaveBeenCalledWith(
      expect.objectContaining({ base: "" }),
    );
    expect(useAmbientContextBindingStore.getState().byThreadId[input.threadId]).toEqual([
      { id: "paper", sourceId: "paper", label: "Paper", includeFullText: false },
    ]);
    await hook.unmount();
    useAmbientContextBindingStore.setState({ byThreadId: {}, maxBindings: 5 });
  });
});
