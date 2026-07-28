import Editor, { type OnMount } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { registerActiveEditor } from "./editor-actions";
import { languageFromPath } from "./language";
import { ensureMonacoConfigured } from "./monaco-setup";

ensureMonacoConfigured();

type CodeEditorProps = {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
  revealLine?: number | null;
  onRevealHandled?: () => void;
};

export function CodeEditor({ path, value, onChange, onSave, readOnly = false, revealLine = null, onRevealHandled }: CodeEditorProps) {
  const saveRef = useRef(onSave);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);
  useEffect(() => {
    saveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!revealLine || !editorRef.current) return;
    const editor = editorRef.current;
    editor.revealLineInCenter(revealLine);
    editor.setPosition({ lineNumber: revealLine, column: 1 });
    editor.focus();
    onRevealHandled?.();
  }, [revealLine, path, onRevealHandled]);

  useEffect(() => {
    return () => {
      if (editorRef.current) {
        registerActiveEditor(null);
      }
    };
  }, []);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerActiveEditor(editor);
    editor.onDidFocusEditorText(() => {
      registerActiveEditor(editor);
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveRef.current?.();
    });
    if (revealLine) {
      editor.revealLineInCenter(revealLine);
      editor.setPosition({ lineNumber: revealLine, column: 1 });
    }
  };

  return (
    <div className="monaco-host">
      <Editor
        path={path}
        language={languageFromPath(path)}
        value={value}
        theme="vs-dark"
        onChange={(next) => onChange(next ?? "")}
        onMount={handleMount}
        options={{
          readOnly,
          fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 13,
          lineHeight: 20,
          minimap: { enabled: true, scale: 1, showSlider: "mouseover" },
          scrollBeyondLastLine: false,
          automaticLayout: true,
          wordWrap: "off",
          tabSize: 2,
          renderWhitespace: "selection",
          smoothScrolling: true,
          cursorBlinking: "smooth",
          padding: { top: 10, bottom: 16 },
          bracketPairColorization: { enabled: true },
        }}
        loading={<div className="monaco-loading">Loading editor…</div>}
      />
    </div>
  );
}
