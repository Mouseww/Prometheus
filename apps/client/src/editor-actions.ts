type EditorLike = {
  focus: () => void;
  trigger: (source: string, handlerId: string, payload: unknown) => void;
};

let activeEditor: EditorLike | null = null;

export function registerActiveEditor(editor: EditorLike | null) {
  activeEditor = editor;
}

export type EditorActionId = "undo" | "redo" | "find" | "replace" | "selectAll";

const ACTION_MAP: Record<EditorActionId, string> = {
  undo: "undo",
  redo: "redo",
  find: "actions.find",
  replace: "editor.action.startFindReplaceAction",
  selectAll: "editor.action.selectAll",
};

export function runEditorAction(action: EditorActionId): boolean {
  if (!activeEditor) return false;
  activeEditor.focus();
  activeEditor.trigger("prometheus-menu", ACTION_MAP[action], null);
  return true;
}
