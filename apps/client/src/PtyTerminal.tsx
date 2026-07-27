import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { getTerminalWebSocketUrl } from "./api";

type PtyTerminalProps = {
  /** PTY 的审批与审计事件必须归属到一个真实会话，没有会话就不建立连接。 */
  sessionId: string | null;
  active: boolean;
  visible?: boolean;
  agentLines?: string[];
};

export function PtyTerminal({ sessionId, active, visible = true, agentLines = [] }: PtyTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const agentCursor = useRef(0);

  useEffect(() => {
    if (!active || !sessionId || !hostRef.current || termRef.current) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      theme: {
        background: "#0a0c0b",
        foreground: "#d5d8d1",
        cursor: "#b7e25a",
        selectionBackground: "rgba(242,106,61,0.35)",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const connect = () => {
      const cols = term.cols || 120;
      const rows = term.rows || 32;
      const socket = new WebSocket(getTerminalWebSocketUrl(sessionId, cols, rows));
      socketRef.current = socket;
      socket.addEventListener("open", () => {
        term.writeln("\r\n\x1b[90m[pty] connected\x1b[0m");
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      });
      socket.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(String(event.data)) as { type?: string; data?: string; message?: string; code?: number };
          if (payload.type === "output" && payload.data) term.write(payload.data);
          else if (payload.type === "error") term.writeln("\r\n\x1b[31m[pty] " + (payload.message ?? "error") + "\x1b[0m");
          else if (payload.type === "exit") term.writeln("\r\n\x1b[90m[pty] exit " + String(payload.code ?? "?") + "\x1b[0m");
          else if (payload.type === "ready") term.writeln("\x1b[90m[pty] " + String((payload as { shell?: string }).shell ?? "shell") + " ready\x1b[0m");
        } catch {
          term.write(String(event.data));
        }
      });
      socket.addEventListener("close", () => {
        term.writeln("\r\n\x1b[90m[pty] disconnected\x1b[0m");
      });
    };
    connect();

    const disposable = term.onData((data) => {
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const onResize = () => {
      fit.fit();
      const socket = socketRef.current;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    window.addEventListener("resize", onResize);
    const ro = new ResizeObserver(() => onResize());
    ro.observe(hostRef.current);

    return () => {
      disposable.dispose();
      window.removeEventListener("resize", onResize);
      ro.disconnect();
      socketRef.current?.close();
      socketRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [active, sessionId]);

  useEffect(() => {
    if (!active || !visible) return;
    const id = window.requestAnimationFrame(() => {
      fitRef.current?.fit();
      const term = termRef.current;
      const socket = socketRef.current;
      if (term && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [active, visible]);

  useEffect(() => {
    const term = termRef.current;
    if (!term || agentLines.length <= agentCursor.current) return;
    const incoming = agentLines.slice(agentCursor.current);
    agentCursor.current = agentLines.length;
    for (const line of incoming) {
      term.writeln("\x1b[36m" + line + "\x1b[0m");
    }
  }, [agentLines]);

  return <div className="pty-terminal-host" ref={hostRef} />;
}
