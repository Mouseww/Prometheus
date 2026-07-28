import { DiffEditor, Editor } from "@monaco-editor/react";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getTeamTaskPatch, type TeamTaskPatch } from "./api";
import { languageFromPath } from "./language";
import { ensureMonacoConfigured } from "./monaco-setup";
import { parseUnifiedPatch, type FileDiffHunk } from "./patch-diff";

ensureMonacoConfigured();

type PatchPreviewModalProps = {
  teamRunId: string;
  teamTaskId: string;
  agentLabel: string;
  canApply?: boolean;
  onClose: () => void;
  onApply: () => Promise<void>;
  onDiscard: () => Promise<void>;
};

export function PatchPreviewModal({
  teamRunId,
  teamTaskId,
  agentLabel,
  canApply = true,
  onClose,
  onApply,
  onDiscard,
}: PatchPreviewModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TeamTaskPatch | null>(null);
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"split" | "unified">("split");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getTeamTaskPatch(teamRunId, teamTaskId)
      .then((next) => {
        if (cancelled) return;
        setPreview(next);
        const files = parseUnifiedPatch(next.patch);
        setSelectedPath(files[0]?.path ?? next.changedPaths[0] ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Unable to load patch preview");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [teamRunId, teamTaskId]);

  const files = useMemo<FileDiffHunk[]>(
    () => (preview ? parseUnifiedPatch(preview.patch) : []),
    [preview],
  );
  const active = files.find((file) => file.path === selectedPath) ?? files[0] ?? null;

  const run = async (action: "apply" | "discard") => {
    if (busy) return;
    if (action === "discard" && !globalThis.confirm("Discard this isolated worktree and all of its unapplied changes?")) {
      return;
    }
    setBusy(action);
    setError(null);
    try {
      if (action === "apply") await onApply();
      else await onDiscard();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Unable to ${action} team changes`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-backdrop patch-preview-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal-card patch-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Patch preview for ${agentLabel}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="patch-preview-header">
          <div>
            <span className="eyebrow">PATCH PREVIEW</span>
            <h3>{agentLabel}</h3>
            <small>
              {preview
                ? `${preview.status} · ${preview.changedPaths.length} paths · ${preview.patchBytes.toLocaleString()} bytes`
                : "Loading worktree diff…"}
            </small>
          </div>
          <div className="patch-preview-header-actions">
            <div className="patch-view-toggle" role="group" aria-label="Diff view mode">
              <button
                type="button"
                className={viewMode === "split" ? "active" : undefined}
                onClick={() => setViewMode("split")}
              >
                Split
              </button>
              <button
                type="button"
                className={viewMode === "unified" ? "active" : undefined}
                onClick={() => setViewMode("unified")}
              >
                Unified
              </button>
            </div>
            <button type="button" className="icon-button" aria-label="Close patch preview" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </header>

        {preview && preview.conflictPaths.length > 0 && (
          <div className="patch-preview-conflicts">Conflicts: {preview.conflictPaths.join(", ")}</div>
        )}
        {preview && preview.disallowedPaths.length > 0 && (
          <div className="patch-preview-conflicts">Out of scope: {preview.disallowedPaths.join(", ")}</div>
        )}

        <div className="patch-preview-body">
          {loading && <div className="panel-empty">Generating unified diff…</div>}
          {error && <div className="error-banner">{error}</div>}
          {!loading && preview && viewMode === "unified" && (
            <div className="monaco-host patch-monaco">
              <Editor
                language="diff"
                theme="vs-dark"
                value={preview.patch || "No textual patch content."}
                options={{
                  readOnly: true,
                  fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontSize: 12,
                  lineHeight: 18,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  wordWrap: "off",
                  renderWhitespace: "selection",
                  padding: { top: 8, bottom: 8 },
                }}
              />
            </div>
          )}
          {!loading && preview && viewMode === "split" && (
            <div className="patch-split-layout">
              <aside className="patch-file-list" aria-label="Changed files">
                {(files.length > 0 ? files : preview.changedPaths.map((path) => ({
                  path,
                  original: "",
                  modified: "",
                  binary: false,
                  added: 0,
                  removed: 0,
                }))).map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className={(active?.path ?? selectedPath) === file.path ? "active" : undefined}
                    onClick={() => setSelectedPath(file.path)}
                  >
                    <strong>{file.path.split("/").pop()}</strong>
                    <small>
                      {file.binary
                        ? "binary"
                        : `+${file.added} -${file.removed}`}
                    </small>
                    <span>{file.path}</span>
                  </button>
                ))}
              </aside>
              <div className="patch-split-editor">
                {active?.binary ? (
                  <div className="panel-empty">Binary file — no text diff available.</div>
                ) : active ? (
                  <div className="monaco-host patch-monaco">
                    <DiffEditor
                      original={active.original}
                      modified={active.modified}
                      language={languageFromPath(active.path)}
                      theme="vs-dark"
                      options={{
                        readOnly: true,
                        renderSideBySide: true,
                        fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                        fontSize: 12,
                        lineHeight: 18,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        renderWhitespace: "selection",
                        originalEditable: false,
                      }}
                    />
                  </div>
                ) : (
                  <div className="panel-empty">No parseable file hunks in this patch.</div>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="patch-preview-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy !== null}>
            Close
          </button>
          <button
            type="button"
            className="secondary-button danger"
            disabled={busy !== null}
            onClick={() => { void run("discard"); }}
          >
            {busy === "discard" ? "Discarding…" : "Discard"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== null || !canApply}
            onClick={() => { void run("apply"); }}
          >
            {busy === "apply" ? "Applying…" : canApply ? "Apply patch" : "Not applyable yet"}
          </button>
        </footer>
      </div>
    </div>
  );
}
