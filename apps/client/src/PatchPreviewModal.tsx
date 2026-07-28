import Editor from "@monaco-editor/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { getTeamTaskPatch, type TeamTaskPatch } from "./api";
import { ensureMonacoConfigured } from "./monaco-setup";

ensureMonacoConfigured();

type PatchPreviewModalProps = {
  teamRunId: string;
  teamTaskId: string;
  agentLabel: string;
  onClose: () => void;
  onApply: () => Promise<void>;
  onDiscard: () => Promise<void>;
};

export function PatchPreviewModal({
  teamRunId,
  teamTaskId,
  agentLabel,
  onClose,
  onApply,
  onDiscard,
}: PatchPreviewModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TeamTaskPatch | null>(null);
  const [busy, setBusy] = useState<"apply" | "discard" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getTeamTaskPatch(teamRunId, teamTaskId)
      .then((next) => {
        if (!cancelled) setPreview(next);
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
          <button type="button" className="icon-button" aria-label="Close patch preview" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {preview && preview.changedPaths.length > 0 && (
          <div className="patch-preview-paths" aria-label="Changed paths">
            {preview.changedPaths.map((path) => (
              <code key={path}>{path}</code>
            ))}
          </div>
        )}
        {preview && preview.conflictPaths.length > 0 && (
          <div className="patch-preview-conflicts">Conflicts: {preview.conflictPaths.join(", ")}</div>
        )}
        {preview && preview.disallowedPaths.length > 0 && (
          <div className="patch-preview-conflicts">Out of scope: {preview.disallowedPaths.join(", ")}</div>
        )}

        <div className="patch-preview-body">
          {loading && <div className="panel-empty">Generating unified diff…</div>}
          {error && <div className="error-banner">{error}</div>}
          {!loading && preview && (
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
            disabled={busy !== null}
            onClick={() => { void run("apply"); }}
          >
            {busy === "apply" ? "Applying…" : "Apply patch"}
          </button>
        </footer>
      </div>
    </div>
  );
}
