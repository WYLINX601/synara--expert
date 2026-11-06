import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** A thread owns subscriptions, not observations. Draft clearing must never clear these. */
export interface AmbientContextBinding {
  id: string;
  sourceId: string;
  label: string;
  includeFullText: boolean;
}
export const DEFAULT_AMBIENT_BINDING_LIMIT = 5;
export const MAX_AMBIENT_BINDING_LIMIT = 32;
export function validAmbientBindingLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_AMBIENT_BINDING_LIMIT
  );
}

interface BindingState {
  maxBindings: number;
  setMaxBindings: (value: number) => void;
  byThreadId: Record<string, AmbientContextBinding[]>;
  bind: (threadId: ThreadId, connection: Omit<AmbientContextBinding, "includeFullText">) => void;
  unbind: (threadId: ThreadId, id: string) => void;
  setFullText: (threadId: ThreadId, id: string, include: boolean) => void;
  removeThread: (threadId: ThreadId) => void;
  moveThread: (from: ThreadId, to: ThreadId) => void;
}
export const EMPTY_AMBIENT_BINDINGS: AmbientContextBinding[] = [];
export const useAmbientContextBindingStore = create<BindingState>()(
  persist(
    (set) => ({
      maxBindings: DEFAULT_AMBIENT_BINDING_LIMIT,
      setMaxBindings: (value) => {
        if (validAmbientBindingLimit(value)) set({ maxBindings: value });
      },
      byThreadId: {},
      bind: (threadId, connection) =>
        set((state) => {
          const current = state.byThreadId[threadId] ?? [];
          if (
            current.some((binding) => binding.id === connection.id) ||
            current.length >= state.maxBindings
          )
            return state;
          return {
            byThreadId: {
              ...state.byThreadId,
              [threadId]: [
                ...current,
                {
                  id: connection.id,
                  sourceId: connection.sourceId,
                  label: connection.label,
                  includeFullText: false,
                },
              ],
            },
          };
        }),
      unbind: (threadId, id) =>
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: (state.byThreadId[threadId] ?? []).filter((binding) => binding.id !== id),
          },
        })),
      setFullText: (threadId, id, includeFullText) =>
        set((state) => ({
          byThreadId: {
            ...state.byThreadId,
            [threadId]: (state.byThreadId[threadId] ?? []).map((binding) =>
              binding.id === id ? Object.assign({}, binding, { includeFullText }) : binding,
            ),
          },
        })),
      removeThread: (threadId) =>
        set((state) => {
          const { [threadId]: _removed, ...byThreadId } = state.byThreadId;
          return { byThreadId };
        }),
      moveThread: (from, to) =>
        set((state) => {
          if (from === to || !state.byThreadId[from]) return state;
          const { [from]: bindings, ...byThreadId } = state.byThreadId;
          return { byThreadId: { ...byThreadId, [to]: bindings! } };
        }),
    }),
    {
      name: "synara:ambient-context-bindings:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: ({ byThreadId, maxBindings }) => ({ byThreadId, maxBindings }),
      merge: (persisted, current) => {
        const raw = (persisted as Partial<BindingState> | null)?.byThreadId;
        const byThreadId: BindingState["byThreadId"] = {};
        if (raw && typeof raw === "object")
          for (const [id, value] of Object.entries(raw)) {
            if (Array.isArray(value))
              byThreadId[id] = value.filter(
                (binding): binding is AmbientContextBinding =>
                  binding !== null &&
                  typeof binding === "object" &&
                  typeof binding.id === "string" &&
                  typeof binding.sourceId === "string" &&
                  typeof binding.label === "string" &&
                  typeof binding.includeFullText === "boolean",
              );
          }
        const savedLimit = (persisted as Partial<BindingState> | null)?.maxBindings;
        return {
          ...current,
          byThreadId,
          maxBindings: validAmbientBindingLimit(savedLimit)
            ? savedLimit
            : DEFAULT_AMBIENT_BINDING_LIMIT,
        };
      },
    },
  ),
);
