import type { ApprovalDecision } from "@prometheus/protocol";
import { Columns2, Minus, PanelLeft, PanelRight, ShieldAlert, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauriDesktop } from "./local-runtime";
import type { PendingApprovalItem } from "./pending-approvals";

export type LayoutMode = "editor" | "split" | "agent";

export type TitleMenuItem = {
  id: string;
  label: string;
  detail?: string;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
};

export type TitleMenu = {
  id: string;
  label: string;
  items: TitleMenuItem[];
};

type SessionOption = {
  id: string;
  title: string;
};

type TitleBarProps = {
  menus: TitleMenu[];
  workspaceLabel: string;
  sessions: SessionOption[];
  selectedSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: () => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  connectionLabel: string;
  connectionTone: "live" | "connecting" | "idle" | "offline";
  pendingApprovals?: PendingApprovalItem[];
  onResolveApproval?: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<unknown>;
  onFocusApprovals?: () => void;
};

async function withAppWindow(action: "minimize" | "toggleMaximize" | "close") {
  if (!isTauriDesktop()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = getCurrentWindow();
    if (action === "minimize") await current.minimize();
    if (action === "toggleMaximize") await current.toggleMaximize();
    if (action === "close") await current.close();
  } catch {
    // Browser / non-window hosts ignore chrome controls.
  }
}

export function TitleBar({
  menus,
  workspaceLabel,
  sessions,
  selectedSessionId,
  onSelectSession,
  onCreateSession,
  layoutMode,
  onLayoutModeChange,
  connectionLabel,
  connectionTone,
  pendingApprovals = [],
  onResolveApproval,
  onFocusApprovals,
}: TitleBarProps) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const desktop = isTauriDesktop();
  const approvalCount = pendingApprovals.length;

  useEffect(() => {
    if (!openMenu && !inboxOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
        setInboxOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpenMenu(null);
        setInboxOpen(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu, inboxOpen]);

  useEffect(() => {
    if (approvalCount === 0) setInboxOpen(false);
  }, [approvalCount]);

  const resolve = async (item: PendingApprovalItem, decision: ApprovalDecision) => {
    if (!onResolveApproval || resolvingId) return;
    setResolvingId(item.approvalId);
    try {
      await onResolveApproval(item.sessionId, item.approvalId, decision);
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <header className={`title-bar${desktop ? " is-desktop" : ""}`} ref={rootRef}>
      <div className="title-bar-left">
        <div className="title-brand" title="Prometheus" aria-hidden="true">
          <span>P</span>
        </div>
        <nav className="title-menubar" aria-label="Application menu">
          {menus.map((menu) => {
            const expanded = openMenu === menu.id;
            return (
              <div key={menu.id} className={expanded ? "title-menu open" : "title-menu"}>
                <button
                  type="button"
                  className="title-menu-trigger"
                  aria-haspopup="menu"
                  aria-expanded={expanded}
                  onClick={() => {
                    setInboxOpen(false);
                    setOpenMenu(expanded ? null : menu.id);
                  }}
                  onMouseEnter={() => {
                    if (openMenu) setOpenMenu(menu.id);
                  }}
                >
                  {menu.label}
                </button>
                {expanded && (
                  <div className="title-menu-dropdown" role="menu">
                    {menu.items.map((item) =>
                      item.separator ? (
                        <div key={item.id} className="title-menu-separator" role="separator" />
                      ) : (
                        <button
                          key={item.id}
                          type="button"
                          role="menuitem"
                          className="title-menu-item"
                          disabled={item.disabled || !item.run}
                          onClick={() => {
                            item.run?.();
                            setOpenMenu(null);
                          }}
                        >
                          <span>{item.label}</span>
                          {item.detail && <kbd>{item.detail}</kbd>}
                        </button>
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      </div>

      <div
        className="title-bar-center"
        data-tauri-drag-region={desktop ? true : undefined}
        onDoubleClick={() => {
          void withAppWindow("toggleMaximize");
        }}
      >
        <div className="title-path" title={workspaceLabel}>
          <span className="title-path-label">{workspaceLabel || "Prometheus"}</span>
          <span className="title-path-sep">·</span>
          <label className="title-session">
            <span className="sr-only">Session</span>
            <select
              value={selectedSessionId ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "__new__") {
                  onCreateSession();
                  return;
                }
                if (value) onSelectSession(value);
              }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <option value="">{sessions.length ? "Select session" : "No session"}</option>
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.title}
                </option>
              ))}
              <option value="__new__">+ New session…</option>
            </select>
          </label>
        </div>
      </div>

      <div className="title-bar-right">
        <div className="title-inbox">
          <button
            type="button"
            className={approvalCount > 0 ? "title-inbox-button has-items" : "title-inbox-button"}
            aria-label={approvalCount > 0 ? `${approvalCount} pending approvals` : "Approval inbox empty"}
            aria-expanded={inboxOpen}
            onClick={() => {
              setOpenMenu(null);
              setInboxOpen((open) => !open);
              onFocusApprovals?.();
            }}
          >
            <ShieldAlert size={14} />
            <span>Approvals</span>
            {approvalCount > 0 && <em>{approvalCount}</em>}
          </button>
          {inboxOpen && (
            <div className="title-inbox-panel" role="dialog" aria-label="Pending approvals">
              {approvalCount === 0 ? (
                <div className="title-inbox-empty">No pending approvals in this session.</div>
              ) : (
                pendingApprovals.map((item) => (
                  <article key={item.approvalId} className="title-inbox-card">
                    <header>
                      <strong>{item.title}</strong>
                      <small>
                        {item.sessionTitle ? `${item.sessionTitle} · ${item.detail}` : item.detail}
                        {" · "}
                        <span className={item.live ? "tone-live" : "tone-stale"}>
                          {item.live ? "live" : "stale"}
                        </span>
                      </small>
                    </header>
                    {item.preview && <pre>{item.preview}</pre>}
                    {!item.live && (
                      <p className="title-inbox-stale">
                        Run waiter is gone (restart/abort). Resolving only clears this card — resend the task if work must continue.
                      </p>
                    )}
                    <div className="title-inbox-actions">
                      <button
                        type="button"
                        className="deny"
                        disabled={resolvingId === item.approvalId}
                        onClick={() => { void resolve(item, "denied"); }}
                      >
                        {item.denyLabel}
                      </button>
                      <button
                        type="button"
                        className="approve"
                        disabled={resolvingId === item.approvalId}
                        onClick={() => { void resolve(item, "approved"); }}
                      >
                        {resolvingId === item.approvalId ? "Working…" : item.approveLabel}
                      </button>
                    </div>
                  </article>
                ))
              )}
            </div>
          )}
        </div>

        <div className={`title-connection ${connectionTone}`} title={connectionLabel}>
          <i />
          <span>{connectionLabel}</span>
        </div>
        <div className="title-layout" role="group" aria-label="Workbench layout">
          <button
            type="button"
            className={layoutMode === "editor" ? "active" : undefined}
            title="Editor only"
            aria-label="Editor only"
            aria-pressed={layoutMode === "editor"}
            onClick={() => onLayoutModeChange("editor")}
          >
            <PanelLeft size={14} />
          </button>
          <button
            type="button"
            className={layoutMode === "split" ? "active" : undefined}
            title="Editor + Agent"
            aria-label="Editor and agent split"
            aria-pressed={layoutMode === "split"}
            onClick={() => onLayoutModeChange("split")}
          >
            <Columns2 size={14} />
          </button>
          <button
            type="button"
            className={layoutMode === "agent" ? "active" : undefined}
            title="Agent only"
            aria-label="Agent only"
            aria-pressed={layoutMode === "agent"}
            onClick={() => onLayoutModeChange("agent")}
          >
            <PanelRight size={14} />
          </button>
        </div>
        {desktop && (
          <div className="title-window-controls">
            <button type="button" aria-label="Minimize" onClick={() => void withAppWindow("minimize")}>
              <Minus size={14} />
            </button>
            <button type="button" aria-label="Maximize" onClick={() => void withAppWindow("toggleMaximize")}>
              <Square size={12} />
            </button>
            <button type="button" className="close" aria-label="Close" onClick={() => void withAppWindow("close")}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
