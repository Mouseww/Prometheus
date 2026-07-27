import { AlertTriangle, ListTree, Search, TerminalSquare, X } from "lucide-react";
import type { SessionEvent } from "@prometheus/protocol";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { describeEvent } from "./event-description";
import type { WorkspaceSearchHit } from "./api";
import { PtyTerminal } from "./PtyTerminal";
import type { TerminalLine } from "./terminal-model";

export type BottomPanelTab = "terminal" | "output" | "problems" | "search";

export type EditorProblem = {
  path: string;
  message: string;
  severity: "error" | "warning";
};

type BottomPanelProps = {
  open: boolean;
  tab: BottomPanelTab;
  sessionId: string | null;
  onTabChange: (tab: BottomPanelTab) => void;
  onClose: () => void;
  events: SessionEvent[];
  problems: EditorProblem[];
  searchQuery: string;
  searchHits: WorkspaceSearchHit[];
  searchBusy: boolean;
  searchError: string | null;
  terminalLines: TerminalLine[];
  terminalBusy: boolean;
  terminalWorkdir: string;
  onTerminalWorkdirChange: (value: string) => void;
  onRunTerminal: (command: string) => Promise<void>;
  onClearTerminal: () => void;
  onOpenSearchHit: (path: string, line: number) => void;
  onOpenProblem: (path: string) => void;
};

export function BottomPanel({
  open,
  tab,
  sessionId,
  onTabChange,
  onClose,
  events,
  problems,
  searchQuery,
  searchHits,
  searchBusy,
  searchError,
  terminalLines,
  terminalBusy,
  terminalWorkdir,
  onTerminalWorkdirChange,
  onRunTerminal,
  onClearTerminal,
  onOpenSearchHit,
  onOpenProblem,
}: BottomPanelProps) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [ptyReady, setPtyReady] = useState(open);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setPtyReady(true);
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "terminal") return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [terminalLines, open, tab, terminalBusy]);

  useEffect(() => {
    if (open && tab === "terminal") {
      inputRef.current?.focus();
    }
  }, [open, tab]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = command.trim();
    if (!text || terminalBusy) return;
    setHistory((current) => [text, ...current.filter((item) => item !== text)].slice(0, 100));
    setHistoryIndex(-1);
    setCommand("");
    await onRunTerminal(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (history.length === 0) return;
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setCommand(history[next] ?? "");
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCommand("");
        return;
      }
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setCommand(history[next] ?? "");
    }
  };

  return (
    <section className={"bottom-panel" + (open ? "" : " collapsed")} aria-label="Panel" hidden={!open}>
      <div className="bottom-panel-tabs">
        <button type="button" className={tab === "terminal" ? "active" : ""} onClick={() => onTabChange("terminal")}>
          <TerminalSquare size={13} /> Terminal
        </button>
        <button type="button" className={tab === "output" ? "active" : ""} onClick={() => onTabChange("output")}>
          <TerminalSquare size={13} /> Agent Output
        </button>
        <button type="button" className={tab === "problems" ? "active" : ""} onClick={() => onTabChange("problems")}>
          <AlertTriangle size={13} /> Problems{problems.length > 0 ? " (" + problems.length + ")" : ""}
        </button>
        <button type="button" className={tab === "search" ? "active" : ""} onClick={() => onTabChange("search")}>
          <Search size={13} /> Search{searchHits.length > 0 ? " (" + searchHits.length + ")" : ""}
        </button>
        <button type="button" className="bottom-panel-close" aria-label="Close panel" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="bottom-panel-body">
        <div className={"terminal-panel pty" + (tab === "terminal" ? "" : " hidden-panel")} hidden={tab !== "terminal"}>
          <div className="terminal-toolbar">
            <span className="muted-note">
              {sessionId
                ? "Interactive PTY shell on control plane workspace"
                : "Select or create a session to open a PTY shell"}
            </span>
            <button type="button" className="mini-button" onClick={onClearTerminal}>Clear agent mirror</button>
          </div>
          <PtyTerminal
            sessionId={sessionId}
            active={ptyReady}
            visible={open && tab === "terminal"}
            agentLines={terminalLines.filter((line) => line.kind === "agent" || line.kind === "system").map((line) => line.text)}
          />
          <div className="terminal-fallback">
            <form className="terminal-input-row" onSubmit={(event) => { void submit(event); }}>
              <span className="terminal-prompt">oneshot&gt;</span>
              <input
                ref={inputRef}
                value={command}
                disabled={terminalBusy}
                onChange={(event) => setCommand(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Fallback one-shot command if PTY is unavailable"
                spellCheck={false}
                autoComplete="off"
              />
              <button className="mini-button" type="submit" disabled={terminalBusy || !command.trim()}>
                Run
              </button>
            </form>
          </div>
        </div>

        {tab === "output" && (
          <div className="panel-output">
            {events.length === 0 ? (
              <div className="panel-empty">No agent output yet. Session events will stream here.</div>
            ) : (
              events.slice(-120).map((event) => (
                <div className="panel-output-line" key={event.eventId}>
                  <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
                  <strong>{event.actor.label}</strong>
                  <span>{describeEvent(event)}</span>
                </div>
              ))
            )}
          </div>
        )}

        {tab === "problems" && (
          <div className="panel-problems">
            {problems.length === 0 ? (
              <div className="panel-empty">No problems in open editors.</div>
            ) : (
              problems.map((problem) => (
                <button
                  key={problem.path + ":" + problem.message}
                  type="button"
                  className={"problem-row " + problem.severity}
                  onClick={() => onOpenProblem(problem.path)}
                >
                  <AlertTriangle size={13} />
                  <span>{problem.path}</span>
                  <small>{problem.message}</small>
                </button>
              ))
            )}
          </div>
        )}

        {tab === "search" && (
          <div className="panel-search-results">
            {searchBusy && <div className="panel-empty">Searching…</div>}
            {!searchBusy && searchError && <div className="panel-empty error">{searchError}</div>}
            {!searchBusy && !searchError && searchQuery && searchHits.length === 0 && (
              <div className="panel-empty">No matches for “{searchQuery}”.</div>
            )}
            {!searchBusy && !searchError && !searchQuery && (
              <div className="panel-empty">Run a workspace search from the Search activity.</div>
            )}
            {!searchBusy && searchHits.map((hit) => (
              <button
                key={hit.path + ":" + hit.line + ":" + hit.text}
                type="button"
                className="search-hit-row"
                onClick={() => onOpenSearchHit(hit.path, hit.line)}
              >
                <ListTree size={13} />
                <span className="search-hit-path">{hit.path}</span>
                <span className="search-hit-line">:{hit.line}</span>
                <code>{hit.text.trim()}</code>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
