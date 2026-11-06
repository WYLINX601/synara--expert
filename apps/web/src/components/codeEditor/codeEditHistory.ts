// FILE: codeEditHistory.ts
// Purpose: The undo/redo contract between the editor engine and the pane
//          chrome (WorkspaceFileEditorHistoryActions).
// Layer: Web editor runtime
// Exports: CodeEditHistoryControls, CodeEditHistoryState, INITIAL_CODE_EDIT_HISTORY_STATE

export interface CodeEditHistoryControls {
  /** Read live edits before React publishes the latest value. */
  getText?: () => string;
  undo: () => void;
  redo: () => void;
  revertTo: (value: string) => void;
}

export interface CodeEditHistoryState {
  canUndo: boolean;
  canRedo: boolean;
}

export const INITIAL_CODE_EDIT_HISTORY_STATE: CodeEditHistoryState = {
  canUndo: false,
  canRedo: false,
};
