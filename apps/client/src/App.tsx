import {
  createTeamRunSchema,
  type ApprovalDecision,
  type AgentProfile,
  type CreateAgentProfileInput,
  type CreateProviderInput,
  type CreateTeamRunInput,
  type Provider,
  type ProviderKind,
  type PermissionRule,
  type PermissionRuleEffect,
  type PermissionRuleTool,
  type CreatePermissionRuleInput,
  type RunStreamSnapshot,
  type SessionEvent,
  type TeamMessage,
  type TeamRun,
  type WorkspaceNode,
} from "@prometheus/protocol";
import {
  Activity,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock3,
  Command,
  FileCode2,
  Files,
  Folder,
  FolderOpen,
  GitBranch,
  Globe2,
  Menu,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  Radio,
  Save,
  Search,
  Send,
  ServerCog,
  ShieldCheck,
  Sparkles,
  Store,
  Settings2,
  TerminalSquare,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { describeApprovalRequest, describeEvent } from "./event-description";
import { buildConversationItems, deriveConversationPhase } from "./conversation-model";
import type { ExtensionCatalogEntry, ExtensionStore, McpServer, SkillSummary } from "./api";
import { execTerminal, getAccessToken, listLivePendingApprovals, listWorkspaceFiles, readWorkspaceFile, searchWorkspace, setAccessToken, writeWorkspaceFile, type WorkspaceSearchHit } from "./api";
import { BottomPanel, type BottomPanelTab, type EditorProblem } from "./BottomPanel";
import { CodeEditor } from "./CodeEditor";
import { CommandPalette, type PaletteCommand, type PaletteMode } from "./CommandPalette";
import { TitleBar, type LayoutMode, type TitleMenu } from "./TitleBar";
import { runEditorAction } from "./editor-actions";
import { listPendingApprovals, mergePendingApprovals, pendingFromLiveApproval } from "./pending-approvals";
import { PatchPreviewModal } from "./PatchPreviewModal";
import { agentShellLines, extractWritePathFromStarted, inputLine, resultLines, systemLine, type TerminalLine } from "./terminal-model";
import { usePrometheus } from "./use-prometheus";

type ActivityId = "explorer" | "search" | "sessions" | "agents" | "extensions" | "settings";
type SettingsSection = "connection" | "server" | "providers" | "agents" | "permissions" | "store" | "mcp" | "skills";
type EditorTab = {
  path: string;
  content: string;
  original: string;
  truncated: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
};

export function App() {
  const prometheus = usePrometheus();
  const [activity, setActivity] = useState<ActivityId>("explorer");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("connection");
  const [message, setMessage] = useState("");
  const [sendingMessage, setSendingMessage] = useState(false);
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [teamSetupOpen, setTeamSetupOpen] = useState(false);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteMode, setPaletteMode] = useState<PaletteMode>("files");
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomTab, setBottomTab] = useState<BottomPanelTab>("terminal");
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("split");
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [liveApprovals, setLiveApprovals] = useState<ReturnType<typeof pendingFromLiveApproval>[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<WorkspaceSearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [terminalLines, setTerminalLines] = useState<TerminalLine[]>(() => [
    systemLine("Prometheus terminal ready. Commands execute on the control-plane workspace."),
  ]);
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalWorkdir, setTerminalWorkdir] = useState("");
  const seenTerminalEvents = useRef<Set<string>>(new Set());
  const pendingWritePaths = useRef<Map<string, string>>(new Map());
  const timelineEnd = useRef<HTMLDivElement>(null);
  const agentRunning = sendingMessage || prometheus.running || prometheus.teamRunning || prometheus.activeStreams.length > 0;
  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  const openFile = async (path: string) => {
    setSelectedFilePath(path);
    setActivity("explorer");
    const existing = tabs.find((tab) => tab.path === path);
    if (existing) {
      setActivePath(path);
      return;
    }
    try {
      const file = await readWorkspaceFile(path);
      setTabs((current) => [
        ...current.filter((tab) => tab.path !== path),
        {
          path: file.path,
          content: file.content,
          original: file.content,
          truncated: file.truncated,
          dirty: false,
          saving: false,
          error: null,
        },
      ]);
      setActivePath(file.path);
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : "Unable to open file";
      setTabs((current) => [
        ...current.filter((tab) => tab.path !== path),
        { path, content: "", original: "", truncated: false, dirty: false, saving: false, error },
      ]);
      setActivePath(path);
    }
  };

  const updateActiveContent = (content: string) => {
    if (!activePath) return;
    setTabs((current) =>
      current.map((tab) =>
        tab.path === activePath
          ? { ...tab, content, dirty: content !== tab.original, error: null }
          : tab,
      ),
    );
  };

  const saveActiveTab = async () => {
    if (!activePath) return;
    const tab = tabs.find((item) => item.path === activePath);
    if (!tab || tab.saving) return;
    setTabs((current) => current.map((item) => item.path === activePath ? { ...item, saving: true, error: null } : item));
    try {
      await writeWorkspaceFile(tab.path, tab.content);
      setTabs((current) => current.map((item) => item.path === activePath
        ? { ...item, original: item.content, dirty: false, saving: false, error: null }
        : item));
    } catch (reason) {
      const error = reason instanceof Error ? reason.message : "Save failed";
      setTabs((current) => current.map((item) => item.path === activePath ? { ...item, saving: false, error } : item));
    }
  };

  const closeTab = (path: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.path !== path);
      if (activePath === path) setActivePath(next.at(-1)?.path ?? null);
      return next;
    });
  };

  const openFileAtLine = async (path: string, line?: number) => {
    await openFile(path);
    if (line && line > 0) setRevealLine(line);
  };

  const runWorkspaceSearch = async (raw = searchQuery) => {
    const query = raw.trim();
    if (!query) {
      setSearchHits([]);
      setSearchError(null);
      return;
    }
    if (prometheus.controlPlane !== "online") {
      setActivity("settings");
      setSettingsSection("connection");
      setSearchError("Control plane offline");
      return;
    }
    setSearchBusy(true);
    setSearchError(null);
    try {
      const hits = await searchWorkspace(query);
      setSearchHits(hits);
      setBottomOpen(true);
      setBottomTab("search");
    } catch (reason) {
      setSearchHits([]);
      setSearchError(reason instanceof Error ? reason.message : "Search failed");
    } finally {
      setSearchBusy(false);
    }
  };

  const runTerminalCommand = async (command: string) => {
    if (prometheus.controlPlane !== "online") {
      setActivity("settings");
      setSettingsSection("connection");
      setTerminalLines((current) => [...current, systemLine("Control plane offline — connect server first.", "error")]);
      return;
    }
    // 终端命令与 agent 工具调用共享同一条审批/审计链，因此必须归属到一个会话。
    const sessionId = prometheus.selectedSessionId;
    if (!sessionId) {
      setActivity("sessions");
      setTerminalLines((current) => [...current, systemLine("Select or create a session before running commands.", "error")]);
      return;
    }
    setTerminalBusy(true);
    setBottomOpen(true);
    setBottomTab("terminal");
    setTerminalLines((current) => [...current, inputLine(command, terminalWorkdir)]);
    try {
      const result = await execTerminal({ sessionId, command, workdir: terminalWorkdir, timeoutMs: 30_000 });
      setTerminalLines((current) => [...current, ...resultLines(result)]);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Terminal command failed";
      setTerminalLines((current) => [...current, systemLine(message, "error")]);
    } finally {
      setTerminalBusy(false);
    }
  };

  const problems: EditorProblem[] = tabs.flatMap((tab) => {
    const items: EditorProblem[] = [];
    if (tab.error) items.push({ path: tab.path, message: tab.error, severity: "error" });
    if (tab.truncated) items.push({ path: tab.path, message: "File truncated at 512KB read limit", severity: "warning" });
    return items;
  });

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [prometheus.events, prometheus.activeStreams, pendingUserText, sendingMessage]);

  useEffect(() => {
    if (prometheus.controlPlane !== "online") {
      setWorkspaceFiles([]);
      return;
    }
    let cancelled = false;
    void listWorkspaceFiles()
      .then((files) => { if (!cancelled) setWorkspaceFiles(files); })
      .catch(() => { if (!cancelled) setWorkspaceFiles([]); });
    return () => { cancelled = true; };
  }, [prometheus.controlPlane, prometheus.health?.workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (mod && key === "s") {
        if (!activePath) return;
        event.preventDefault();
        void saveActiveTab();
        return;
      }
      if (mod && event.shiftKey && key === "p") {
        event.preventDefault();
        setPaletteMode("commands");
        setPaletteOpen(true);
        return;
      }
      if (mod && !event.shiftKey && key === "p") {
        event.preventDefault();
        setPaletteMode("files");
        setPaletteOpen(true);
        return;
      }
      if (mod && event.shiftKey && key === "f") {
        event.preventDefault();
        setActivity("search");
        setBottomOpen(true);
        setBottomTab("search");
        return;
      }
      if (mod && key === "j") {
        event.preventDefault();
        setBottomOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activePath, tabs]);

  useEffect(() => {
    if (prometheus.controlPlane !== "online") {
      setLiveApprovals([]);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void listLivePendingApprovals()
        .then((items) => {
          if (!cancelled) setLiveApprovals(items.map(pendingFromLiveApproval));
        })
        .catch(() => {
          if (!cancelled) setLiveApprovals([]);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [prometheus.controlPlane, prometheus.events.length, prometheus.running, prometheus.teamRunning]);

  useEffect(() => {
    if (agentRunning || !queuedMessage || !prometheus.selectedSession || sendingMessage) return;
    const text = queuedMessage;
    setQueuedMessage(null);
    setPendingUserText(text);
    setSendingMessage(true);
    void prometheus.submitTask(text).catch(() => {
      setMessage(text);
      setPendingUserText(null);
      setSendingMessage(false);
    });
  }, [agentRunning, queuedMessage, prometheus.selectedSession, sendingMessage]);

  // Flush queued composer message is handled above.
  useEffect(() => {
    if (!pendingUserText) return;
    const accepted = prometheus.events.some(
      (event) => event.type === "message.user" && String(event.payload.text ?? "") === pendingUserText,
    );
    if (accepted) {
      setPendingUserText(null);
      setSendingMessage(false);
    }
  }, [pendingUserText, prometheus.events]);

  const submitMessage = async (event: FormEvent) => {
    event.preventDefault();
    const text = message.trim();
    if (!text) return;
    if (!prometheus.selectedSession) {
      setNewSessionOpen(true);
      return;
    }
    if (agentRunning) {
      setQueuedMessage(text);
      setMessage("");
      return;
    }
    setMessage("");
    setQueuedMessage(null);
    setPendingUserText(text);
    setSendingMessage(true);
    try {
      await prometheus.submitTask(text);
    } catch {
      // Keep the draft so the user can retry after fixing provider/agent/runtime issues.
      setMessage(text);
      setPendingUserText(null);
      setSendingMessage(false);
    }
  };

  const submitSession = async (event: FormEvent) => {
    event.preventDefault();
    const title = newSessionTitle.trim();
    if (!title) return;
    if (prometheus.controlPlane !== "online") {
      setActivity("settings");
      setSettingsSection("connection");
      return;
    }
    await prometheus.createSession(title);
    setNewSessionTitle("");
    setNewSessionOpen(false);
  };

  const paletteCommands: PaletteCommand[] = [
    {
      id: "file.quickOpen",
      label: "Go to File…",
      detail: "Ctrl+P",
      run: () => { setPaletteMode("files"); setPaletteOpen(true); },
    },
    {
      id: "file.save",
      label: "File: Save",
      detail: "Ctrl+S",
      run: () => { void saveActiveTab(); },
    },
    {
      id: "edit.undo",
      label: "Edit: Undo",
      detail: "Ctrl+Z",
      run: () => { runEditorAction("undo"); },
    },
    {
      id: "edit.redo",
      label: "Edit: Redo",
      detail: "Ctrl+Y",
      run: () => { runEditorAction("redo"); },
    },
    {
      id: "edit.find",
      label: "Edit: Find",
      detail: "Ctrl+F",
      run: () => { runEditorAction("find"); },
    },
    {
      id: "edit.replace",
      label: "Edit: Replace",
      detail: "Ctrl+H",
      run: () => { runEditorAction("replace"); },
    },
    {
      id: "edit.selectAll",
      label: "Edit: Select All",
      detail: "Ctrl+A",
      run: () => { runEditorAction("selectAll"); },
    },
    {
      id: "workbench.action.approvals",
      label: "View: Focus Approvals",
      run: () => { setLayoutMode("agent"); },
    },
    {
      id: "file.saveAll",
      label: "File: Save All",
      run: () => { void saveActiveTab(); },
    },
    {
      id: "session.create",
      label: "File: New Session",
      run: () => {
        if (prometheus.controlPlane !== "online") {
          setActivity("settings");
          setSettingsSection("connection");
          return;
        }
        setNewSessionOpen(true);
      },
    },
    {
      id: "workbench.action.openSettings",
      label: "File: Preferences / Settings",
      run: () => { setActivity("settings"); setSettingsSection("connection"); },
    },
    {
      id: "workbench.view.explorer",
      label: "View: Show Explorer",
      run: () => setActivity("explorer"),
    },
    {
      id: "workbench.view.search",
      label: "View: Show Search",
      detail: "Ctrl+Shift+F",
      run: () => setActivity("search"),
    },
    {
      id: "workbench.view.sessions",
      label: "View: Show Sessions",
      run: () => setActivity("sessions"),
    },
    {
      id: "workbench.view.agents",
      label: "View: Show Agents",
      run: () => setActivity("agents"),
    },
    {
      id: "workbench.action.terminal",
      label: "Terminal: Focus Terminal",
      run: () => { setBottomOpen(true); setBottomTab("terminal"); },
    },
    {
      id: "workbench.action.togglePanel",
      label: "View: Toggle Bottom Panel",
      detail: "Ctrl+J",
      run: () => setBottomOpen((open) => !open),
    },
    {
      id: "workbench.layout.editor",
      label: "View: Editor Only",
      run: () => setLayoutMode("editor"),
    },
    {
      id: "workbench.layout.split",
      label: "View: Editor + Agent",
      run: () => setLayoutMode("split"),
    },
    {
      id: "workbench.layout.agent",
      label: "View: Agent Only",
      run: () => setLayoutMode("agent"),
    },
    {
      id: "agent.team",
      label: "Run: Team Run…",
      run: () => {
        if (!prometheus.selectedSession || prometheus.agents.length === 0 || agentRunning) return;
        setTeamSetupOpen(true);
      },
    },
    {
      id: "agent.cancel",
      label: "Run: Stop Agent",
      run: () => { void prometheus.cancelRun(prometheus.activeStreams[0]?.runId ?? null); },
    },
    {
      id: "terminal.clear",
      label: "Terminal: Clear",
      run: () => {
        setBottomOpen(true);
        setBottomTab("terminal");
        setTerminalLines([systemLine("Terminal cleared.")]);
      },
    },
    {
      id: "help.commandPalette",
      label: "Help: Command Palette",
      detail: "Ctrl+Shift+P",
      run: () => { setPaletteMode("commands"); setPaletteOpen(true); },
    },
    {
      id: "help.about",
      label: "Help: About Prometheus",
      run: () => {
        window.alert("Prometheus IDE — local-first AI control plane with durable sessions, approvals, and multi-client sync.");
      },
    },
  ];

  const runCommand = (id: string) => {
    paletteCommands.find((command) => command.id === id)?.run();
  };

  const titleMenus: TitleMenu[] = [
    {
      id: "file",
      label: "File",
      items: [
        { id: "m-file-new", label: "New Session…", run: () => runCommand("session.create") },
        { id: "m-file-open", label: "Open File…", detail: "Ctrl+P", run: () => runCommand("file.quickOpen") },
        { id: "m-file-sep1", label: "", separator: true },
        { id: "m-file-save", label: "Save", detail: "Ctrl+S", run: () => runCommand("file.save"), disabled: !activePath },
        { id: "m-file-sep2", label: "", separator: true },
        { id: "m-file-settings", label: "Settings…", run: () => runCommand("workbench.action.openSettings") },
      ],
    },
    {
      id: "edit",
      label: "Edit",
      items: [
        { id: "m-edit-undo", label: "Undo", detail: "Ctrl+Z", run: () => runCommand("edit.undo") },
        { id: "m-edit-redo", label: "Redo", detail: "Ctrl+Y", run: () => runCommand("edit.redo") },
        { id: "m-edit-sep1", label: "", separator: true },
        { id: "m-edit-find", label: "Find", detail: "Ctrl+F", run: () => runCommand("edit.find") },
        { id: "m-edit-replace", label: "Replace", detail: "Ctrl+H", run: () => runCommand("edit.replace") },
        { id: "m-edit-sep2", label: "", separator: true },
        { id: "m-edit-select-all", label: "Select All", detail: "Ctrl+A", run: () => runCommand("edit.selectAll") },
        { id: "m-edit-find-files", label: "Find in Files", detail: "Ctrl+Shift+F", run: () => runCommand("workbench.view.search") },
      ],
    },
    {
      id: "view",
      label: "View",
      items: [
        { id: "m-view-explorer", label: "Explorer", run: () => runCommand("workbench.view.explorer") },
        { id: "m-view-search", label: "Search", detail: "Ctrl+Shift+F", run: () => runCommand("workbench.view.search") },
        { id: "m-view-sessions", label: "Sessions", run: () => runCommand("workbench.view.sessions") },
        { id: "m-view-agents", label: "Agents", run: () => runCommand("workbench.view.agents") },
        { id: "m-view-sep1", label: "", separator: true },
        { id: "m-view-editor", label: "Editor Only", run: () => runCommand("workbench.layout.editor") },
        { id: "m-view-split", label: "Editor + Agent", run: () => runCommand("workbench.layout.split") },
        { id: "m-view-agent", label: "Agent Only", run: () => runCommand("workbench.layout.agent") },
        { id: "m-view-sep2", label: "", separator: true },
        { id: "m-view-panel", label: "Toggle Bottom Panel", detail: "Ctrl+J", run: () => runCommand("workbench.action.togglePanel") },
        { id: "m-view-approvals", label: "Approvals Inbox", run: () => runCommand("workbench.action.approvals") },
      ],
    },
    {
      id: "go",
      label: "Go",
      items: [
        { id: "m-go-file", label: "Go to File…", detail: "Ctrl+P", run: () => runCommand("file.quickOpen") },
        { id: "m-go-session", label: "Go to Sessions", run: () => runCommand("workbench.view.sessions") },
        { id: "m-go-settings", label: "Go to Settings", run: () => runCommand("workbench.action.openSettings") },
      ],
    },
    {
      id: "run",
      label: "Run",
      items: [
        { id: "m-run-team", label: "Team Run…", run: () => runCommand("agent.team"), disabled: !prometheus.selectedSession || prometheus.agents.length === 0 || agentRunning },
        { id: "m-run-stop", label: "Stop Agent", run: () => runCommand("agent.cancel"), disabled: !agentRunning },
      ],
    },
    {
      id: "terminal",
      label: "Terminal",
      items: [
        { id: "m-term-focus", label: "New / Focus Terminal", run: () => runCommand("workbench.action.terminal") },
        { id: "m-term-toggle", label: "Toggle Terminal Panel", detail: "Ctrl+J", run: () => runCommand("workbench.action.togglePanel") },
        { id: "m-term-clear", label: "Clear", run: () => runCommand("terminal.clear") },
      ],
    },
    {
      id: "help",
      label: "Help",
      items: [
        { id: "m-help-palette", label: "Command Palette…", detail: "Ctrl+Shift+P", run: () => runCommand("help.commandPalette") },
        { id: "m-help-about", label: "About Prometheus", run: () => runCommand("help.about") },
      ],
    },
  ];

  const connectionTone =
    prometheus.controlPlane !== "online"
      ? (prometheus.controlPlane === "connecting" ? "connecting" as const : "offline" as const)
      : prometheus.connection === "live"
        ? "live" as const
        : prometheus.connection === "connecting"
          ? "connecting" as const
          : "idle" as const;
  const connectionLabel =
    connectionTone === "offline"
      ? "Offline"
      : connectionTone === "connecting"
        ? "Connecting"
        : connectionTone === "live"
          ? "Live"
          : "Online";
  const pendingApprovals = mergePendingApprovals(
    listPendingApprovals(prometheus.events).map((item) => ({
      ...item,
      sessionTitle: item.sessionId === prometheus.selectedSessionId
        ? prometheus.selectedSession?.title
        : item.sessionTitle,
    })),
    liveApprovals,
  );

  const workspaceLabel =
    prometheus.runtime?.workspaceName
    ?? prometheus.health?.workspace?.split(/[\\/]/).filter(Boolean).at(-1)
    ?? "Prometheus";

  return (
    <div className="ide-shell">
      <TitleBar
        menus={titleMenus}
        workspaceLabel={workspaceLabel}
        sessions={prometheus.sessions.map((session) => ({ id: session.id, title: session.title }))}
        selectedSessionId={prometheus.selectedSessionId}
        onSelectSession={(id) => prometheus.setSelectedSessionId(id)}
        onCreateSession={() => {
          if (prometheus.controlPlane !== "online") {
            setActivity("settings");
            setSettingsSection("connection");
            return;
          }
          setNewSessionOpen(true);
        }}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        connectionLabel={connectionLabel}
        connectionTone={connectionTone}
        pendingApprovals={pendingApprovals}
        onResolveApproval={async (sessionId, approvalId, decision) => {
          const result = await prometheus.resolveApproval(sessionId, approvalId, decision);
          if (sessionId !== prometheus.selectedSessionId) {
            prometheus.setSelectedSessionId(sessionId);
          }
          setLiveApprovals((current) => current.filter((item) => item.approvalId !== approvalId));
          return result;
        }}
        onFocusApprovals={() => {
          setLayoutMode("agent");
        }}
      />
      <NavigationRail activity={activity} onChange={setActivity} />

      <aside className={`ide-sidebar context-panel ${mobilePanelOpen ? "is-open" : ""}`}>
        {activity === "explorer" && (
          <>
            <div className="context-heading">
              <div>
                <span className="eyebrow">EXPLORER</span>
                <h1>{prometheus.health?.workspace ?? (prometheus.controlPlane === "connecting" ? "Connecting…" : "Offline")}</h1>
              </div>
              <button className="icon-button mobile-only" onClick={() => setMobilePanelOpen(false)}><X size={17} /></button>
            </div>
            <section className="workspace-tree" aria-label="Workspace files">
              {prometheus.rootNodes.map((node) => (
                <TreeEntry
                  key={node.path}
                  node={node}
                  depth={0}
                  expandedPaths={prometheus.expandedPaths}
                  childrenByPath={prometheus.childrenByPath}
                  selectedPath={selectedFilePath}
                  onToggle={prometheus.toggleDirectory}
                  onOpenFile={(path) => { void openFile(path); }}
                />
              ))}
              {!prometheus.loading && prometheus.rootNodes.length === 0 && (
                <p className="muted-note">Workspace empty or control plane offline.</p>
              )}
            </section>
          </>
        )}

        {activity === "search" && (
          <>
            <div className="context-heading">
              <div>
                <span className="eyebrow">SEARCH</span>
                <h1>Workspace</h1>
              </div>
            </div>
            <form
              className="sidebar-search"
              onSubmit={(event) => {
                event.preventDefault();
                void runWorkspaceSearch();
              }}
            >
              <label>
                Query
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Search text in workspace"
                  autoFocus
                />
              </label>
              <button className="primary-button" type="submit" disabled={searchBusy || !searchQuery.trim()}>
                {searchBusy ? "Searching…" : "Search"}
              </button>
              <p className="muted-note">Results open in the bottom panel. Click a hit to open the file.</p>
            </form>
            <div className="sidebar-stack">
              {searchHits.slice(0, 30).map((hit) => (
                <button
                  key={hit.path + ":" + hit.line + ":" + hit.text}
                  className="side-card"
                  onClick={() => { void openFileAtLine(hit.path, hit.line); }}
                >
                  <strong>{hit.path}</strong>
                  <small>line {hit.line}</small>
                </button>
              ))}
            </div>
          </>
        )}

        {activity === "sessions" && (
          <>
            <div className="context-heading">
              <div>
                <span className="eyebrow">SESSIONS</span>
                <h1>Durable tasks</h1>
              </div>
              <button className="mini-button" onClick={() => setNewSessionOpen(true)}><MessageSquarePlus size={14} /> New</button>
            </div>
            <nav className="session-list" aria-label="Sessions">
              {prometheus.sessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === prometheus.selectedSessionId ? "session-item active" : "session-item"}
                  onClick={() => { prometheus.setSelectedSessionId(session.id); setMobilePanelOpen(false); }}
                >
                  <span className="session-pulse" />
                  <span className="session-copy">
                    <strong>{session.title}</strong>
                    <small>seq {session.lastSequence.toString().padStart(4, "0")}</small>
                  </span>
                </button>
              ))}
              {!prometheus.loading && prometheus.sessions.length === 0 && (
                <button className="empty-session" onClick={() => setNewSessionOpen(true)}>
                  <span>Create the first task</span>
                  <small>Shared across every connected client.</small>
                </button>
              )}
            </nav>
          </>
        )}

        {activity === "agents" && (
          <>
            <div className="context-heading"><div><span className="eyebrow">AGENTS</span><h1>{prometheus.agents.length} profiles</h1></div></div>
            <div className="sidebar-stack">
              {prometheus.agents.map((agent) => (
                <button key={agent.id} className={agent.id === prometheus.selectedAgentId ? "side-card active" : "side-card"} onClick={() => prometheus.setSelectedAgentId(agent.id)}>
                  <strong>{agent.name}</strong>
                  <small>{agent.model}</small>
                </button>
              ))}
              {prometheus.agents.length === 0 && <p className="muted-note">No agents yet.</p>}
              <button className="secondary-button" onClick={() => { setActivity("settings"); setSettingsSection("agents"); }}>Manage in Settings</button>
            </div>
          </>
        )}

        {activity === "extensions" && (
          <>
            <div className="context-heading"><div><span className="eyebrow">EXTENSIONS</span><h1>Skills & MCP</h1></div></div>
            <div className="sidebar-stack">
              <div className="side-card static"><strong>Skills</strong><small>{prometheus.skills.length} discovered</small></div>
              <div className="side-card static"><strong>MCP servers</strong><small>{prometheus.mcpServers.length} configured</small></div>
              <button className="secondary-button" onClick={() => { setActivity("settings"); setSettingsSection("mcp"); }}>Open extension settings</button>
            </div>
          </>
        )}

        {activity === "settings" && (
          <>
            <div className="context-heading"><div><span className="eyebrow">SETTINGS</span><h1>Configuration</h1></div></div>
            <nav className="settings-nav">
              {([
                ["connection", "Connection"],
                ["server", "Server"],
                ["providers", "Providers"],
                ["agents", "Agents"],
                ["permissions", "Permissions"],
                ["store", "Extension Store"],
                ["mcp", "MCP"],
                ["skills", "Skills"],
              ] as const).map(([id, label]) => (
                <button key={id} className={settingsSection === id ? "settings-nav-item active" : "settings-nav-item"} onClick={() => setSettingsSection(id)}>
                  {label}
                </button>
              ))}
            </nav>
          </>
        )}
      </aside>

      <section className="ide-main">
        {activity === "settings" ? (
          <div className="settings-workspace">
            <header className="settings-header">
              <div>
                <span className="eyebrow">SETTINGS</span>
                <h2>{{
                  connection: "Connection",
                  server: "Server & Projects",
                  providers: "Providers",
                  agents: "Agents",
                  permissions: "Permissions",
                  store: "Extension Store",
                  mcp: "MCP Servers",
                  skills: "Skills",
                }[settingsSection]}</h2>
              </div>
              <div className="telemetry-inline">
                <Globe2 size={15} />
                <span>{prometheus.controlPlaneUrl}</span>
                <strong className={prometheus.controlPlane === "online" ? "tone-good" : "tone-quiet"}>{prometheus.controlPlane}</strong>
              </div>
            </header>
            <div className="settings-content">
              <RuntimeSetupModal
                embedded
                section={settingsSection}
                controlPlane={prometheus.controlPlane}
                controlPlaneMode={prometheus.controlPlaneMode}
                controlPlaneUrl={prometheus.controlPlaneUrl}
                runtime={prometheus.runtime}
                hostMode={prometheus.hostMode}
                localRuntime={prometheus.localRuntime}
                onConfigureControlPlane={prometheus.configureControlPlane}
                onConfigureControlPlaneMode={prometheus.configureControlPlaneMode}
                onReconnectControlPlane={prometheus.reconnectControlPlane}
                onRefreshEmbeddedRuntime={prometheus.refreshEmbeddedRuntime}
                onRestartEmbeddedRuntime={prometheus.restartEmbeddedRuntime}
                onSaveRuntime={prometheus.saveRuntime}
                onAddProject={prometheus.addProject}
                onOpenProject={prometheus.openProject}
                onRemoveProject={prometheus.removeProject}
                providers={prometheus.providers}
                agents={prometheus.agents}
                permissionRules={prometheus.permissionRules}
                skills={prometheus.skills}
                mcpServers={prometheus.mcpServers}
                onCreateProvider={prometheus.createProvider}
                onCreateAgent={prometheus.createAgent}
                onCreatePermissionRule={prometheus.createPermissionRule}
                onDeletePermissionRule={prometheus.deletePermissionRule}
                onCreateMcpServer={prometheus.createMcpServer}
                onDeleteMcpServer={prometheus.deleteMcpServer}
                onRefreshSkills={prometheus.refreshSkills}
                onListExtensionStores={prometheus.listExtensionStores}
                onListExtensionCatalog={prometheus.listExtensionCatalog}
                onInstallExtension={prometheus.installExtension}
                onInstallGithubSkill={prometheus.installGithubSkill}
                onClose={() => setActivity("explorer")}
              />
            </div>
          </div>
        ) : (
          <div className="workbench">
            <div className={`workbench-main layout-${layoutMode}`}>
            <div className="editor-column">
              <div className="editor-tabs" role="tablist" aria-label="Open editors">
                {tabs.map((tab) => (
                  <div key={tab.path} className={tab.path === activePath ? "editor-tab active" : "editor-tab"} role="tab" onClick={() => setActivePath(tab.path)}>
                    <FileCode2 size={13} />
                    <span>{tab.path.split("/").pop()}</span>
                    {tab.dirty && <i className="dirty-dot" />}
                    <button className="tab-close" aria-label={`Close ${tab.path}`} onClick={(event) => { event.stopPropagation(); closeTab(tab.path); }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {tabs.length === 0 && <div className="editor-tab placeholder">No file open</div>}
              </div>
              <div className="editor-body">
                {activeTab ? (
                  <>
                    <div className="editor-toolbar">
                      <div>
                        <strong>{activeTab.path}</strong>
                        <small>{activeTab.truncated ? "truncated · " : ""}{activeTab.dirty ? "unsaved" : "saved"}</small>
                      </div>
                      <button className="mini-button" disabled={!activeTab.dirty || activeTab.saving} onClick={() => { void saveActiveTab(); }}>
                        <Save size={13} /> {activeTab.saving ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {activeTab.error && <div className="error-banner">{activeTab.error}</div>}
                    <CodeEditor
                      path={activeTab.path}
                      value={activeTab.content}
                      onChange={updateActiveContent}
                      onSave={() => { void saveActiveTab(); }}
                      revealLine={revealLine}
                      onRevealHandled={() => setRevealLine(null)}
                    />
                  </>
                ) : (
                  <div className="empty-state editor-empty">
                    <div className="orbital-mark"><Files size={28} /></div>
                    <span className="eyebrow">EDITOR</span>
                    <h3>Open a file from Explorer</h3>
                    <p>Click a file in the left tree to preview and edit. Save with the toolbar button.</p>
                  </div>
                )}
              </div>
            </div>

            <div className="chat-column mission-panel">

              <header className="mission-header chat-header">
                <button className="icon-button mobile-only" onClick={() => setMobilePanelOpen(true)}><Menu size={18} /></button>
                <div className="mission-title">
                  <span className="breadcrumb">AGENT CHAT</span>
                  <h2>{prometheus.selectedSession?.title ?? "No session selected"}</h2>
                </div>
                <div className={`connection-pill ${prometheus.controlPlane === "online" ? (prometheus.connection === "live" ? "live" : prometheus.connection === "connecting" ? "connecting" : "idle") : "offline"}`}>
                  <Radio size={13} />
                  {prometheus.controlPlane !== "online"
                    ? (prometheus.controlPlane === "connecting" ? "CONNECTING" : "SERVER OFFLINE")
                    : prometheus.connection === "live"
                      ? "LIVE SYNC"
                      : prometheus.connection === "connecting"
                        ? "SYNCING"
                        : "SERVER ONLINE"}
                </div>
              </header>

              <ConversationPanel
                events={prometheus.events}
                streams={prometheus.activeStreams}
                running={agentRunning}
                sending={sendingMessage}
                pendingUserText={pendingUserText}
                selectedAgentName={prometheus.agents.find((agent) => agent.id === prometheus.selectedAgentId)?.name ?? null}
                error={prometheus.error}
                teamRuns={prometheus.teamRuns}
                teamMessages={prometheus.teamMessages}
                onApplyTeam={prometheus.applyTeamChanges}
                onDiscardTeam={prometheus.discardTeamChanges}
                onResolveApproval={prometheus.resolveApproval}
                onCancelRun={(runId) => { void prometheus.cancelRun(runId); }}
                timelineEndRef={timelineEnd}
                hasSession={Boolean(prometheus.selectedSession)}
              />

              <form className={"composer" + (agentRunning ? " is-busy" : "")} onSubmit={submitMessage}>
                <div className="composer-meta">
                  <span><TerminalSquare size={13} /> {queuedMessage ? "QUEUED" : agentRunning ? "AGENT WORKING" : "MESSAGE"}</span>
                  <span className={agentRunning ? "composer-status busy" : "composer-status"}>
                    {queuedMessage
                      ? `Queued · ${queuedMessage.slice(0, 42)}${queuedMessage.length > 42 ? "…" : ""}`
                      : sendingMessage
                        ? "Sending…"
                        : prometheus.activeStreams[0]
                          ? (prometheus.activeStreams[0].text ? "Streaming reply…" : "Model thinking…")
                          : agentRunning
                            ? "Processing… (you can still type)"
                            : `${message.length}/12000`}
                  </span>
                </div>
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value.slice(0, 12000))}
                  placeholder={prometheus.selectedSession ? (agentRunning ? "Type next message… (Ctrl+Enter queues it)" : "Message the agent… (Ctrl+Enter to send)") : "Create a task before sending input"}
                  disabled={!prometheus.selectedSession}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
                <div className="composer-footer">
                  <div className="composer-runtime-actions">
                    <label className="agent-selector">
                      <Bot size={13} />
                      <select value={prometheus.selectedAgentId ?? ""} onChange={(event) => prometheus.setSelectedAgentId(event.target.value || null)} disabled={agentRunning}>
                        <option value="">{prometheus.agents.length > 0 ? "Auto-select agent" : (prometheus.providers.length > 0 ? "Auto-create agent from provider" : "No provider — configure in Settings")}</option>
                        {prometheus.agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                      </select>
                    </label>
                    <button type="button" className="team-run-button" disabled={!prometheus.selectedSession || prometheus.agents.length === 0 || agentRunning} onClick={() => setTeamSetupOpen(true)}>
                      <Users size={13} /> Team run
                    </button>
                  </div>
                  <button className="send-button" type="submit" disabled={!prometheus.selectedSession || !message.trim()}>
                    {agentRunning ? "Queue" : "Send"} <Send size={15} />
                  </button>
                </div>
              </form>
            </div>
            </div>
            <BottomPanel
              open={bottomOpen}
              tab={bottomTab}
              sessionId={prometheus.selectedSessionId}
              onTabChange={setBottomTab}
              onClose={() => setBottomOpen(false)}
              events={prometheus.events}
              problems={problems}
              searchQuery={searchQuery}
              searchHits={searchHits}
              searchBusy={searchBusy}
              searchError={searchError}
              terminalLines={terminalLines}
              terminalBusy={terminalBusy}
              terminalWorkdir={terminalWorkdir}
              onTerminalWorkdirChange={setTerminalWorkdir}
              onRunTerminal={runTerminalCommand}
              onClearTerminal={() => setTerminalLines([systemLine("Terminal cleared.")])}
              onOpenSearchHit={(path, line) => { void openFileAtLine(path, line); }}
              onOpenProblem={(path) => { void openFile(path); }}
            />
          </div>
        )}
      </section>

      <footer className="status-bar">
        <button type="button" className="status-action" onClick={() => setBottomOpen((open) => !open)}>Panel</button>
        <button type="button" className="status-action" onClick={() => { setBottomOpen(true); setBottomTab("terminal"); }}>Terminal</button>
        <button type="button" className="status-action" onClick={() => { setPaletteMode("files"); setPaletteOpen(true); }}>Quick Open</button>
        {agentRunning && (
          <button
            type="button"
            className="status-action stop"
            onClick={() => {
              const runId = prometheus.activeStreams[0]?.runId ?? null;
              void prometheus.cancelRun(runId);
            }}
          >
            Stop Agent
          </button>
        )}
        <span>{prometheus.controlPlaneUrl}</span>
        <span>{prometheus.controlPlane === "online" ? "online" : prometheus.controlPlane}</span>
        <span>{agentRunning ? "agent running" : activeTab ? activeTab.path : "no editor"}</span>
        <span>{problems.length} problems</span>
        <span className="status-right">Prometheus IDE · Ctrl+P / Ctrl+Shift+P</span>
      </footer>

      {newSessionOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setNewSessionOpen(false)}>
          <form className="modal-card" onSubmit={submitSession} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">NEW DURABLE TASK</span>
            <h3>Name the outcome</h3>
            <input autoFocus value={newSessionTitle} onChange={(event) => setNewSessionTitle(event.target.value)} maxLength={160} placeholder="e.g. Ship authentication flow" />
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setNewSessionOpen(false)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!newSessionTitle.trim()}>Create task</button>
            </div>
          </form>
        </div>
      )}
      {teamSetupOpen && (
        <TeamRunModal agents={prometheus.agents} onStart={prometheus.startTeam} onClose={() => setTeamSetupOpen(false)} />
      )}
      <CommandPalette
        open={paletteOpen}
        mode={paletteMode}
        files={workspaceFiles}
        commands={paletteCommands}
        onClose={() => setPaletteOpen(false)}
        onOpenFile={(path) => { void openFile(path); }}
      />
    </div>
  );
}

function TeamRunSummary({
  team,
  messages,
  onApply,
  onDiscard,
}: {
  team: TeamRun;
  messages: TeamMessage[];
  onApply: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
  onDiscard: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
}) {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);
  const previewTask = team.tasks.find((task) => task.id === previewTaskId) ?? null;
  const act = async (action: "apply" | "discard", taskId: string) => {
    if (action === "discard" && !globalThis.confirm("Discard this isolated worktree and all of its unapplied changes?")) return;
    setBusyAction(`${action}:${taskId}`);
    setActionError(null);
    try {
      await (action === "apply" ? onApply(team.id, taskId) : onDiscard(team.id, taskId));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : `Unable to ${action} team changes`);
    } finally {
      setBusyAction(null);
    }
  };
  return (
    <section className={`team-run-summary ${team.status}`} aria-label="Team run status">
      <div className="team-run-summary-header">
        <div>
          <span className="eyebrow">PARALLEL TEAM</span>
          <strong>{team.goal}</strong>
        </div>
        <span>{team.status} · {team.tasks.length} agents · {team.workspaceMode} · {team.mergeStrategy}</span>
      </div>
      {actionError && <div className="team-run-error team-action-error">{actionError}</div>}
      <div className="team-task-grid">
        {team.tasks.map((task) => (
          <div className={`team-task ${task.status}`} key={task.id}>
            <span className="team-task-dot" />
            <div className="team-task-content">
              <strong>{task.agentLabel}</strong>
              <small>{task.status} · {task.changeStatus}</small>
              {task.allowedPaths.length > 0 && (
                <span className="team-path-owner">owns {task.allowedPaths.join(", ")}</span>
              )}
              {task.changedPaths.length > 0 && (
                <div className="team-change-list" aria-label={`${task.agentLabel} changed paths`}>
                  {task.changedPaths.slice(0, 8).map((path) => <code key={path}>{path}</code>)}
                  {task.changedPaths.length > 8 && <small>+{task.changedPaths.length - 8} more</small>}
                </div>
              )}
              {task.conflictPaths.length > 0 && (
                <span className="team-conflicts">conflicts: {task.conflictPaths.join(", ")}</span>
              )}
              {task.patchBytes > 0 && <small>{task.patchBytes.toLocaleString()} patch bytes</small>}
              {((task.patchBytes > 0 && ["pending", "conflicted", "rejected", "isolated"].includes(task.changeStatus))
                || ["pending", "conflicted", "rejected"].includes(task.changeStatus)) && (
                <div className="team-change-actions">
                  {task.patchBytes > 0 && (
                    <button
                      type="button"
                      disabled={busyAction !== null}
                      onClick={() => setPreviewTaskId(task.id)}
                    >
                      Preview
                    </button>
                  )}
                  {["pending", "conflicted", "rejected"].includes(task.changeStatus) && (
                    <>
                      <button
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void act("apply", task.id)}
                      >
                        {busyAction === `apply:${task.id}` ? "Applying…" : "Apply"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busyAction !== null}
                        onClick={() => void act("discard", task.id)}
                      >
                        {busyAction === `discard:${task.id}` ? "Discarding…" : "Discard"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {messages.length > 0 && <TeamMessageBus messages={messages} />}
      {previewTask && (
        <PatchPreviewModal
          teamRunId={team.id}
          teamTaskId={previewTask.id}
          agentLabel={previewTask.agentLabel}
          onClose={() => setPreviewTaskId(null)}
          onApply={async () => { await onApply(team.id, previewTask.id); }}
          onDiscard={async () => { await onDiscard(team.id, previewTask.id); }}
        />
      )}
    </section>
  );
}

function TeamMessageBus({ messages }: { messages: TeamMessage[] }) {
  return (
    <section className="team-message-bus" aria-label="Agent message bus">
      <div className="team-message-bus-header">
        <span>AGENT MESSAGE BUS</span>
        <small>{messages.length} durable</small>
      </div>
      <div className="team-message-list">
        {messages.map((message) => (
          <article className={`team-message ${message.channel}`} key={message.id}>
            <div>
              <strong>{message.senderLabel}</strong>
              <span>→ {message.recipientLabel}</span>
              <small>{message.channel} · #{message.sequence}</small>
            </div>
            {message.subject && <b>{message.subject}</b>}
            <p>{message.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function TeamRunModal({
  agents,
  onStart,
  onClose,
}: {
  agents: AgentProfile[];
  onStart: (input: CreateTeamRunInput) => Promise<TeamRun | null>;
  onClose: () => void;
}) {
  const [goal, setGoal] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState(() => new Set(agents.map((agent) => agent.id)));
  const [maxConcurrency, setMaxConcurrency] = useState(Math.min(4, Math.max(1, agents.length)));
  const [workspaceMode, setWorkspaceMode] = useState<"readonly" | "worktree">("readonly");
  const [mergeStrategy, setMergeStrategy] = useState<"manual" | "auto">("manual");
  const [pathAssignments, setPathAssignments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds((current) => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const agentIds = agents.map((agent) => agent.id).filter((agentId) => selectedAgentIds.has(agentId));
    if (!goal.trim() || agentIds.length === 0) return;
    const rawInput = {
      goal: goal.trim(),
      agentIds,
      maxConcurrency: Math.min(maxConcurrency, agentIds.length),
      workspaceMode,
      mergeStrategy: workspaceMode === "readonly" ? "manual" as const : mergeStrategy,
      pathAssignments: workspaceMode === "worktree"
        ? agentIds.map((agentId) => ({
            agentId,
            paths: (pathAssignments[agentId] ?? "")
              .split(/[\n,]+/)
              .map((path) => path.trim())
              .filter(Boolean),
          }))
        : [],
    };
    const parsed = createTeamRunSchema.safeParse(rawInput);
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("; "));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onStart(parsed.data);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Team run failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-card team-run-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">PARALLEL SUBAGENTS</span>
        <h3>Launch a bounded team</h3>
        <p>Readonly is the safe default. Worktree mode gives each Agent a real isolated Git branch with explicit path ownership.</p>
        {error && <div className="team-run-error">{error}</div>}
        <label className="team-goal-field">
          Team goal
          <textarea
            autoFocus
            value={goal}
            onChange={(event) => setGoal(event.target.value.slice(0, 12_000))}
            placeholder="e.g. Review the authentication implementation from independent security and maintainability roles"
          />
        </label>
        <div className="team-agent-list">
          {agents.map((agent) => (
            <label className={selectedAgentIds.has(agent.id) ? "team-agent-option selected" : "team-agent-option"} key={agent.id}>
              <input
                type="checkbox"
                checked={selectedAgentIds.has(agent.id)}
                onChange={() => toggleAgent(agent.id)}
              />
              <div><strong>{agent.name}</strong><small>{agent.description || agent.model}</small></div>
            </label>
          ))}
        </div>
        <div className="team-runtime-options">
          <label>
            Workspace mode
            <select
              value={workspaceMode}
              onChange={(event) => setWorkspaceMode(event.target.value as "readonly" | "worktree")}
            >
              <option value="readonly">Readonly</option>
              <option value="worktree">Git worktree</option>
            </select>
          </label>
          <label>
            Merge strategy
            <select
              value={workspaceMode === "readonly" ? "manual" : mergeStrategy}
              disabled={workspaceMode === "readonly"}
              onChange={(event) => setMergeStrategy(event.target.value as "manual" | "auto")}
            >
              <option value="manual">Manual review</option>
              <option value="auto">Auto if conflict-free</option>
            </select>
          </label>
        </div>
        {workspaceMode === "worktree" && (
          <div className="team-path-assignments">
            <span>PATH OWNERSHIP</span>
            <p>Use workspace-relative files or directories. Assignments cannot overlap across Agents.</p>
            {agents.filter((agent) => selectedAgentIds.has(agent.id)).map((agent) => (
              <label key={agent.id}>
                {agent.name}
                <input
                  value={pathAssignments[agent.id] ?? ""}
                  onChange={(event) => setPathAssignments((current) => ({
                    ...current,
                    [agent.id]: event.target.value,
                  }))}
                  placeholder="apps/server, packages/protocol"
                  required
                />
              </label>
            ))}
          </div>
        )}
        <label className="team-concurrency-field">
          Maximum concurrency
          <select
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !goal.trim() || selectedAgentIds.size === 0}
          >
            {busy ? "Running team…" : `Run ${selectedAgentIds.size} agents`}
          </button>
        </div>
      </form>
    </div>
  );
}

function RuntimeSetupModal({
  embedded = false,
  section = "connection" as SettingsSection,
  controlPlane,
  controlPlaneMode,
  controlPlaneUrl,
  runtime,
  hostMode,
  localRuntime,
  onConfigureControlPlane,
  onConfigureControlPlaneMode,
  onReconnectControlPlane,
  onRefreshEmbeddedRuntime,
  onRestartEmbeddedRuntime,
  onSaveRuntime,
  onAddProject,
  onOpenProject,
  onRemoveProject,
  providers,
  agents,
  permissionRules,
  skills,
  mcpServers,
  onCreateProvider,
  onCreateAgent,
  onCreatePermissionRule,
  onDeletePermissionRule,
  onCreateMcpServer,
  onDeleteMcpServer,
  onRefreshSkills,
  onListExtensionStores,
  onListExtensionCatalog,
  onInstallExtension,
  onInstallGithubSkill,
  onClose,
}: {
  embedded?: boolean;
  section?: SettingsSection;
  controlPlane: "connecting" | "online" | "offline";
  controlPlaneMode: "local" | "remote";
  controlPlaneUrl: string;
  runtime: import("./api").RuntimeInfo | null;
  hostMode: { desktop: boolean; serverHosted: boolean };
  localRuntime: import("./local-runtime").LocalRuntimeStatus | null;
  onConfigureControlPlane: (url: string) => string;
  onConfigureControlPlaneMode: (mode: "local" | "remote") => "local" | "remote";
  onReconnectControlPlane: () => void;
  onRefreshEmbeddedRuntime: () => Promise<import("./local-runtime").LocalRuntimeStatus | null>;
  onRestartEmbeddedRuntime: () => Promise<import("./local-runtime").LocalRuntimeStatus | null>;
  onSaveRuntime: (input: { host?: string; port?: number; workspaceRoot?: string }) => Promise<import("./api").RuntimeInfo>;
  onAddProject: (path: string, open?: boolean) => Promise<unknown>;
  onOpenProject: (projectId: string) => Promise<unknown>;
  onRemoveProject: (projectId: string) => Promise<void>;
  providers: Provider[];
  agents: AgentProfile[];
  permissionRules: PermissionRule[];
  skills: SkillSummary[];
  mcpServers: McpServer[];
  onCreateProvider: (input: CreateProviderInput) => Promise<Provider>;
  onCreateAgent: (input: CreateAgentProfileInput) => Promise<AgentProfile>;
  onCreatePermissionRule: (input: CreatePermissionRuleInput) => Promise<PermissionRule>;
  onDeletePermissionRule: (ruleId: string) => Promise<void>;
  onCreateMcpServer: (input: { name: string; command: string; args?: string[]; enabled?: boolean }) => Promise<McpServer>;
  onDeleteMcpServer: (serverId: string) => Promise<void>;
  onRefreshSkills: () => Promise<SkillSummary[]>;
  onListExtensionStores: () => Promise<ExtensionStore[]>;
  onListExtensionCatalog: (
    storeId: string,
    options?: { q?: string; refresh?: boolean },
  ) => Promise<ExtensionCatalogEntry[]>;
  onInstallExtension: (
    storeId: string,
    input: { entryId: string; env?: Record<string, string>; enabled?: boolean },
  ) => Promise<{ kind: string; skill?: SkillSummary; server?: McpServer }>;
  onInstallGithubSkill: (input: {
    repo: string;
    path: string;
    ref?: string;
    skillId?: string;
  }) => Promise<SkillSummary>;
  onClose: () => void;
}) {
  const [controlUrlDraft, setControlUrlDraft] = useState(controlPlaneUrl);
  const [accessTokenDraft, setAccessTokenDraft] = useState(() => getAccessToken(controlPlaneUrl));
  const [listenHost, setListenHost] = useState(runtime?.host ?? "127.0.0.1");
  const [listenPort, setListenPort] = useState(String(runtime?.port ?? 4310));
  const [projectPath, setProjectPath] = useState("");
  const [restartHint, setRestartHint] = useState<string | null>(null);

  useEffect(() => {
    setControlUrlDraft(controlPlaneUrl);
    // 令牌按 URL 分别存储，切换控制平面时必须重新加载对应的那一份。
    setAccessTokenDraft(getAccessToken(controlPlaneUrl));
  }, [controlPlaneUrl]);

  useEffect(() => {
    if (!runtime) return;
    setListenHost(runtime.host);
    setListenPort(String(runtime.port));
  }, [runtime]);
  const [kind, setKind] = useState<ProviderKind>("openai");
  const [providerName, setProviderName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [agentName, setAgentName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [agentModel, setAgentModel] = useState(providers[0]?.defaultModel ?? "");
  const [permissionTool, setPermissionTool] = useState<PermissionRuleTool>("shell_command");
  const [permissionEffect, setPermissionEffect] = useState<PermissionRuleEffect>("deny");
  const [permissionPattern, setPermissionPattern] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("python");
  const [mcpArgs, setMcpArgs] = useState("");
  const [skillList, setSkillList] = useState(skills);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitProvider = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const provider = await onCreateProvider({
        name: providerName,
        kind,
        baseUrl: baseUrl || null,
        defaultModel,
        apiKey,
      });
      setProviderId(provider.id);
      setAgentModel(provider.defaultModel);
      setProviderName(""); setBaseUrl(""); setDefaultModel(""); setApiKey(""); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider configuration failed");
    } finally { setBusy(false); }
  };

  const submitAgent = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreateAgent({ name: agentName, description, systemPrompt, providerId, model: agentModel });
      setAgentName(""); setDescription(""); setSystemPrompt(""); setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent configuration failed");
    } finally { setBusy(false); }
  };

  const submitPermissionRule = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreatePermissionRule({
        toolName: permissionTool.trim(),
        effect: permissionEffect,
        pattern: permissionPattern,
      });
      setPermissionPattern("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Permission rule creation failed");
    } finally { setBusy(false); }
  };

  const removePermissionRule = async (ruleId: string) => {
    setBusy(true);
    try {
      await onDeletePermissionRule(ruleId);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Permission rule deletion failed");
    } finally { setBusy(false); }
  };

  const submitMcpServer = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const args = mcpArgs
        .split(/\r?\n|,/)
        .map((part) => part.trim())
        .filter(Boolean);
      await onCreateMcpServer({
        name: mcpName.trim(),
        command: mcpCommand.trim(),
        args,
        enabled: true,
      });
      setMcpName("");
      setMcpArgs("");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP server configuration failed");
    } finally { setBusy(false); }
  };

  const removeMcpServer = async (serverId: string) => {
    setBusy(true);
    try {
      await onDeleteMcpServer(serverId);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP server deletion failed");
    } finally { setBusy(false); }
  };

  const reloadSkills = async () => {
    setBusy(true);
    try {
      const next = await onRefreshSkills();
      setSkillList(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill refresh failed");
    } finally { setBusy(false); }
  };

  const show = (id: SettingsSection) => !embedded || section === id;

  const permissionPlaceholder =
    permissionTool === "shell_command"
      ? "e.g. pnpm test*"
      : permissionTool === "write_file"
        ? "e.g. docs/*"
        : "e.g. *";

  const body = (
    <>
      {!embedded && (
        <div className="runtime-modal-header">
          <div>
            <span className="eyebrow">AGENT RUNTIME</span>
            <h3>Connect control plane and providers</h3>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={18} />
          </button>
        </div>
      )}
      {error && <div className="runtime-error">{error}</div>}

      {show("connection") && (
        <form
          className="runtime-form control-plane-form settings-section-panel"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            try {
              if (controlPlaneMode === "local") {
                onConfigureControlPlaneMode("local");
                const localUrl = localRuntime?.url ?? "http://127.0.0.1:4310";
                setAccessToken(accessTokenDraft, localUrl);
                if (hostMode.desktop) {
                  void onRefreshEmbeddedRuntime();
                } else {
                  onReconnectControlPlane();
                }
              } else {
                const normalized = onConfigureControlPlane(controlUrlDraft);
                // 令牌必须落在归一化后的 URL 上，否则 request() 读不到它。
                setAccessToken(accessTokenDraft, normalized);
              }
              setError(null);
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : "Invalid control plane URL");
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="runtime-form-title">
            <Globe2 size={16} />
            <strong>Client connection</strong>
            <small className={controlPlane === "online" ? "tone-good" : "tone-quiet"}>
              {controlPlane === "online" ? "online" : controlPlane}
            </small>
          </div>
          <p className="runtime-help">
            {hostMode.desktop
              ? "桌面客户端内置 control plane：Local 模式会自动拉起本机 sidecar，无需先手动启动 server。"
              : hostMode.serverHosted
                ? "当前页面已由 control plane 直接托管，属于同一进程内的 Server UI，默认即可使用。"
                : "浏览器开发模式仍需本机 control plane。可用桌面客户端获得真正的一键本地独立运行。"}
            {" "}Remote 模式才连接共享服务器。
          </p>
          <div className="mode-toggle" role="group" aria-label="Connection mode">
            <button
              type="button"
              className={controlPlaneMode === "local" ? "mode-chip active" : "mode-chip"}
              onClick={() => {
                onConfigureControlPlaneMode("local");
                setControlUrlDraft("http://127.0.0.1:4310");
                setError(null);
              }}
            >
              Local
            </button>
            <button
              type="button"
              className={controlPlaneMode === "remote" ? "mode-chip active" : "mode-chip"}
              onClick={() => {
                onConfigureControlPlaneMode("remote");
                setError(null);
              }}
            >
              Remote
            </button>
          </div>
          {controlPlaneMode === "remote" ? (
            <label>
              Remote server URL
              <input
                value={controlUrlDraft}
                onChange={(event) => setControlUrlDraft(event.target.value)}
                placeholder="http://192.168.1.10:4310"
                required
              />
            </label>
          ) : (
            <>
              <label>
                Local runtime URL
                <input value={localRuntime?.url ?? controlPlaneUrl} readOnly />
              </label>
              <div className={"local-runtime-card" + (localRuntime?.healthy || controlPlane === "online" ? " online" : "")}>
                <strong>
                  {hostMode.desktop
                    ? "Embedded desktop runtime"
                    : hostMode.serverHosted
                      ? "Server-hosted UI"
                      : "Local development runtime"}
                </strong>
                <small>
                  {localRuntime?.message
                    ?? (controlPlane === "online"
                      ? "Control plane online"
                      : hostMode.desktop
                        ? "Starting embedded control plane..."
                        : "Waiting for local control plane on this machine")}
                </small>
                {localRuntime?.binaryPath && <code>{localRuntime.binaryPath}</code>}
              </div>
            </>
          )}
          <label>
            Access token
            <input
              type="password"
              value={accessTokenDraft}
              onChange={(event) => setAccessTokenDraft(event.target.value)}
              placeholder="PROMETHEUS_ACCESS_TOKEN（本机回环模式可留空）"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <p className="runtime-help">
            服务端绑定非回环地址时必须配置 <code>PROMETHEUS_ACCESS_TOKEN</code>，否则拒绝启动。
            令牌按服务器地址分别保存，切换远程实例不会串用。
          </p>
          <div className="modal-actions">
            {hostMode.desktop && controlPlaneMode === "local" && (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onRefreshEmbeddedRuntime()
                      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to start local runtime"))
                      .finally(() => setBusy(false));
                  }}
                >
                  Start local runtime
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void onRestartEmbeddedRuntime()
                      .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to restart local runtime"))
                      .finally(() => setBusy(false));
                  }}
                >
                  Restart runtime
                </button>
              </>
            )}
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onReconnectControlPlane()}>
              Retry connect
            </button>
            <button className="primary-button" disabled={busy || (controlPlaneMode === "remote" && !controlUrlDraft.trim())}>
              Save and reconnect
            </button>
          </div>
        </form>
      )}

      {show("server") && (
        <div className="settings-section-panel runtime-form">
          <div className="runtime-form-title">
            <ServerCog size={16} />
            <strong>Server runtime</strong>
            <small>{runtime ? runtime.workspaceName : "offline"}</small>
          </div>
          {!runtime || controlPlane !== "online" ? (
            <p className="runtime-help">先在 Connection 连上 control plane，再管理监听地址与项目工作区。</p>
          ) : (
            <>
              <p className="runtime-help">
                配置当前 control plane 的监听地址与项目。host/port 写入 runtime.json，重启 server 后生效；切换项目即时生效。
              </p>
              <form
                className="runtime-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  setBusy(true);
                  void onSaveRuntime({
                    host: listenHost.trim(),
                    port: Number(listenPort),
                  })
                    .then((next) => {
                      setRestartHint(next.restartRequired ? next.listenHint : null);
                      setError(null);
                    })
                    .catch((reason) => {
                      setError(reason instanceof Error ? reason.message : "Unable to save runtime");
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <label>
                  Listen IP
                  <input value={listenHost} onChange={(event) => setListenHost(event.target.value)} placeholder="127.0.0.1" required />
                </label>
                <label>
                  Listen port
                  <input value={listenPort} onChange={(event) => setListenPort(event.target.value)} inputMode="numeric" required />
                </label>
                <label className="full-width">
                  Active workspace
                  <input value={runtime.workspaceRoot} readOnly />
                </label>
                <div className="modal-actions full-width">
                  <button className="primary-button" disabled={busy}>Save listen settings</button>
                </div>
              </form>
              {restartHint && <div className="runtime-help tone-warn">{restartHint}</div>}
              <div className="runtime-meta">
                <span>Data: {runtime.dataFile}</span>
                <span>Runtime file: {runtime.runtimeFile}</span>
              </div>
              <form
                className="runtime-form nested"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!projectPath.trim()) return;
                  setBusy(true);
                  void onAddProject(projectPath.trim(), true)
                    .then(() => {
                      setProjectPath("");
                      setError(null);
                    })
                    .catch((reason) => {
                      setError(reason instanceof Error ? reason.message : "Unable to open project");
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <div className="runtime-form-title">
                  <strong>Projects</strong>
                  <small>{runtime.projects.length} saved</small>
                </div>
                <label>
                  Open folder path
                  <input
                    value={projectPath}
                    onChange={(event) => setProjectPath(event.target.value)}
                    placeholder="E:/work/my-app"
                    required
                  />
                </label>
                <div className="modal-actions">
                  <button className="primary-button" disabled={busy || !projectPath.trim()}>Open project</button>
                </div>
              </form>
              <div className="project-list">
                {runtime.projects.length === 0 && <div className="panel-empty">No saved projects yet.</div>}
                {runtime.projects.map((project) => {
                  const active = runtime.activeProjectId === project.id || runtime.workspaceRoot === project.path;
                  return (
                    <div className={active ? "project-row active" : "project-row"} key={project.id}>
                      <div>
                        <strong>{project.name}</strong>
                        <small>{project.path}</small>
                      </div>
                      <div className="project-actions">
                        <button
                          type="button"
                          className="mini-button"
                          disabled={busy || active}
                          onClick={() => {
                            setBusy(true);
                            void onOpenProject(project.id)
                              .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to switch project"))
                              .finally(() => setBusy(false));
                          }}
                        >
                          {active ? "Active" : "Open"}
                        </button>
                        <button
                          type="button"
                          className="mini-button danger"
                          disabled={busy}
                          onClick={() => {
                            setBusy(true);
                            void onRemoveProject(project.id)
                              .catch((reason) => setError(reason instanceof Error ? reason.message : "Unable to remove project"))
                              .finally(() => setBusy(false));
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {show("providers") && (
        <form className="runtime-form settings-section-panel" onSubmit={submitProvider}>
          <div className="runtime-form-title">
            <ServerCog size={16} />
            <strong>Provider</strong>
            <small>{providers.length} configured</small>
          </div>
          <label>
            Protocol
            <select value={kind} onChange={(event) => setKind(event.target.value as ProviderKind)}>
              <option value="openai">OpenAI Responses</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="gemini">Google Gemini</option>
              <option value="openai_compatible">OpenAI-compatible</option>
            </select>
          </label>
          <label>
            Name
            <input value={providerName} onChange={(event) => setProviderName(event.target.value)} required placeholder="Team OpenAI" />
          </label>
          {(kind === "openai_compatible" || kind === "anthropic") && (
            <label>
              Base URL
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                required={kind === "openai_compatible"}
                placeholder="https://api.example.com/v1"
              />
            </label>
          )}
          <label>
            Default model
            <input value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} required placeholder="Provider model ID" />
          </label>
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              required
              placeholder="Encrypted before storage"
            />
          </label>
          <button className="primary-button" disabled={busy}>Save provider</button>
          {providers.length > 0 && (
            <div className="extension-list compact">
              {providers.map((provider) => (
                <div className="extension-row" key={provider.id}>
                  <div>
                    <strong>{provider.name}</strong>
                    <small>{provider.kind} · {provider.defaultModel}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </form>
      )}

      {show("agents") && (
        <form className="runtime-form settings-section-panel" onSubmit={submitAgent}>
          <div className="runtime-form-title">
            <Bot size={16} />
            <strong>Agent profile</strong>
            <small>{agents.length} configured</small>
          </div>
          <label>
            Provider
            <select
              value={providerId}
              onChange={(event) => {
                const id = event.target.value;
                setProviderId(id);
                setAgentModel(providers.find((provider) => provider.id === id)?.defaultModel ?? "");
              }}
              required
            >
              <option value="">Select provider</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input value={agentName} onChange={(event) => setAgentName(event.target.value)} required placeholder="Builder" />
          </label>
          <label>
            Description
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What this agent is responsible for" />
          </label>
          <label>
            Model
            <input value={agentModel} onChange={(event) => setAgentModel(event.target.value)} required placeholder="Provider model ID" />
          </label>
          <label>
            System prompt
            <textarea value={systemPrompt} onChange={(event) => setSystemPrompt(event.target.value)} required placeholder="Define role, constraints and expected evidence." />
          </label>
          <button className="primary-button" disabled={busy || providers.length === 0}>Save agent</button>
          {agents.length > 0 && (
            <div className="extension-list compact">
              {agents.map((agent) => (
                <div className="extension-row" key={agent.id}>
                  <div>
                    <strong>{agent.name}</strong>
                    <small>{agent.model}</small>
                  </div>
                  <p>{agent.description || "No description"}</p>
                </div>
              ))}
            </div>
          )}
        </form>
      )}

      {show("store") && (
        <ExtensionStorePanel
          className="settings-section-panel"
          defaultKind="all"
          onListExtensionStores={onListExtensionStores}
          onListExtensionCatalog={onListExtensionCatalog}
          onInstallExtension={onInstallExtension}
          onInstallGithubSkill={onInstallGithubSkill}
          onInstalled={() => {
            void onRefreshSkills();
          }}
        />
      )}

      {show("skills") && (

        <section className="extensions-config settings-section-panel">
          <div className="permission-config-header">
            <div className="permission-config-title">
              <Sparkles size={17} />
              <div>
                <strong>Skills</strong>
                <small>{skillList.length} discovered</small>
              </div>
            </div>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void reloadSkills()}>
              Refresh skills
            </button>
          </div>
          <div className="extension-list">
            {skillList.length === 0 ? (
              <div className="permission-empty">
                No SKILL.md files discovered yet. Install from the Extension Store or drop skills into <code>.prometheus/skills/&lt;id&gt;/SKILL.md</code>.
              </div>
            ) : skillList.map((skill) => (
              <div className="extension-row" key={skill.id}>
                <div>
                  <strong>{skill.name}</strong>
                  <small>{skill.id}</small>
                </div>
                <p>{skill.description || "No description"}</p>
              </div>
            ))}
          </div>
          <ExtensionStorePanel
            compact
            defaultKind="skills"
            onListExtensionStores={onListExtensionStores}
            onListExtensionCatalog={onListExtensionCatalog}
            onInstallExtension={async (storeId, input) => {
              const result = await onInstallExtension(storeId, input);
              const next = await onRefreshSkills();
              setSkillList(next);
              return result;
            }}
            onInstallGithubSkill={async (input) => {
              const skill = await onInstallGithubSkill(input);
              const next = await onRefreshSkills();
              setSkillList(next);
              return skill;
            }}
          />
        </section>
      )}

      {show("mcp") && (
        <form className="runtime-form extension-form settings-section-panel" onSubmit={submitMcpServer}>
          <div className="runtime-form-title">
            <Boxes size={16} />
            <strong>MCP server</strong>
            <small>stdio transport</small>
          </div>
          <label>
            Name
            <input value={mcpName} onChange={(event) => setMcpName(event.target.value)} required placeholder="echo" />
          </label>
          <label>
            Command
            <input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} required placeholder="python" />
          </label>
          <label>
            Args
            <textarea
              value={mcpArgs}
              onChange={(event) => setMcpArgs(event.target.value)}
              placeholder={"one arg per line\nscripts/mcp_echo_fixture.py"}
            />
          </label>
          <button className="primary-button" disabled={busy || !mcpName.trim() || !mcpCommand.trim()}>Add MCP server</button>
          <div className="extension-list compact">
            {mcpServers.length === 0 ? (
              <div className="permission-empty">No MCP servers configured. Install from the open MCP catalog below.</div>
            ) : mcpServers.map((server) => (
              <div className="extension-row" key={server.id}>
                <div>
                  <strong>{server.name}</strong>
                  <small>{server.enabled ? "enabled" : "disabled"} · mcp__{server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__*</small>
                </div>
                <p><code>{server.command} {server.args.join(" ")}</code></p>
                <button
                  type="button"
                  className="permission-delete"
                  aria-label={`Delete MCP server ${server.name}`}
                  disabled={busy}
                  onClick={() => void removeMcpServer(server.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
          <ExtensionStorePanel
            compact
            defaultKind="mcp"
            onListExtensionStores={onListExtensionStores}
            onListExtensionCatalog={onListExtensionCatalog}
            onInstallExtension={onInstallExtension}
            onInstallGithubSkill={onInstallGithubSkill}
          />
        </form>
      )}

      {show("permissions") && (
        <section className="permission-config settings-section-panel">
          <div className="permission-config-header">
            <div className="permission-config-title">
              <ShieldCheck size={17} />
              <div>
                <strong>Permission policy</strong>
                <small>{permissionRules.length} persistent rules on this node</small>
              </div>
            </div>
            <div className="permission-precedence">
              <span>DENY</span><i>→</i><span>ASK</span><i>→</i><span>ALLOW</span>
            </div>
          </div>
          <p className="permission-guidance">
            Shell compound commands are evaluated one subcommand at a time. MCP tools default to approval and can be allowed with exact tool names such as <code>mcp__echo__echo</code>.
          </p>
          <form className="permission-rule-form" onSubmit={submitPermissionRule}>
            <label>
              Tool
              <input
                list="permission-tool-options"
                aria-label="Permission tool"
                value={permissionTool}
                onChange={(event) => setPermissionTool(event.target.value)}
                required
                maxLength={80}
                placeholder="shell_command | write_file | mcp__server__tool"
              />
              <datalist id="permission-tool-options">
                <option value="shell_command" />
                <option value="write_file" />
                <option value="read_skill" />
                {mcpServers.map((server) => (
                  <option key={server.id} value={`mcp__${server.name.replace(/[^A-Za-z0-9_-]/g, "_")}__`} />
                ))}
              </datalist>
            </label>
            <label>
              Effect
              <select
                aria-label="Permission effect"
                value={permissionEffect}
                onChange={(event) => setPermissionEffect(event.target.value as PermissionRuleEffect)}
              >
                <option value="deny">Deny</option>
                <option value="ask">Ask every time</option>
                <option value="allow">Allow without prompt</option>
              </select>
            </label>
            <label className="permission-pattern-field">
              Pattern
              <input
                aria-label="Permission pattern"
                value={permissionPattern}
                onChange={(event) => setPermissionPattern(event.target.value)}
                required
                maxLength={2000}
                placeholder={permissionPlaceholder}
              />
            </label>
            <button className="primary-button" disabled={busy || !permissionPattern.trim() || !permissionTool.trim()}>Add rule</button>
          </form>
          <div className="permission-rule-list">
            {permissionRules.length === 0 ? (
              <div className="permission-empty">No persistent rules. Protected tools use cross-device approval.</div>
            ) : permissionRules.map((rule) => (
              <div className={`permission-rule-row ${rule.effect}`} key={rule.id}>
                <span className="permission-effect">{rule.effect}</span>
                <span className="permission-tool">{rule.toolName}</span>
                <code>{rule.pattern}</code>
                <button
                  type="button"
                  className="permission-delete"
                  aria-label={`Delete permission rule ${rule.pattern}`}
                  disabled={busy}
                  onClick={() => void removePermissionRule(rule.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );

  if (embedded) {
    return <div className="runtime-setup embedded">{body}</div>;
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="runtime-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        {body}
      </div>
    </div>
  );
}

function NavigationRail({
  activity,
  onChange,
}: {
  activity: ActivityId;
  onChange: (id: ActivityId) => void;
}) {
  const items: Array<{ id: ActivityId; label: string; icon: ReactNode }> = [
    { id: "explorer", label: "Explorer", icon: <Files size={18} /> },
    { id: "search", label: "Search", icon: <Search size={18} /> },
    { id: "sessions", label: "Sessions", icon: <MessageSquare size={18} /> },
    { id: "agents", label: "Agents", icon: <Bot size={18} /> },
    { id: "extensions", label: "Extensions", icon: <Plug size={18} /> },
    { id: "settings", label: "Settings", icon: <Settings2 size={18} /> },
  ];
  return (
    <nav className="navigation-rail activity-bar" aria-label="Primary activities">
      <div className="brand-mark" title="Prometheus"><span>P</span></div>
      <div className="rail-actions">
        {items.map((item) => (
          <button
            key={item.id}
            className={activity === item.id ? "rail-button active" : "rail-button"}
            title={item.label}
            aria-label={item.label}
            aria-pressed={activity === item.id}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
          </button>
        ))}
      </div>
    </nav>
  );
}

function TreeEntry({
  node,
  depth,
  expandedPaths,
  childrenByPath,
  selectedPath,
  onToggle,
  onOpenFile,
}: {
  node: WorkspaceNode;
  depth: number;
  expandedPaths: Set<string>;
  childrenByPath: Record<string, WorkspaceNode[]>;
  selectedPath?: string | null;
  onToggle: (path: string) => void | Promise<void>;
  onOpenFile?: (path: string) => void;
}) {
  const expanded = expandedPaths.has(node.path);
  const children = childrenByPath[node.path] ?? [];
  return (
    <div>
      <button
        className={selectedPath === node.path ? "tree-row selected" : "tree-row"}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={() => {
          if (node.kind === "directory") {
            void onToggle(node.path);
            return;
          }
          onOpenFile?.(node.path);
        }}
      >
        {node.kind === "directory" ? (
          <>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
          </>
        ) : (
          <><span className="tree-indent" /><FileCode2 size={14} /></>
        )}
        <span>{node.name}</span>
      </button>
      {expanded && children.map((child) => (
        <TreeEntry
          key={child.path}
          node={child}
          depth={depth + 1}
          expandedPaths={expandedPaths}
          childrenByPath={childrenByPath}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function ConversationPanel({
  events,
  streams,
  running,
  sending,
  pendingUserText,
  selectedAgentName,
  error,
  teamRuns,
  teamMessages,
  onApplyTeam,
  onDiscardTeam,
  onResolveApproval,
  onCancelRun,
  timelineEndRef,
  hasSession,
}: {
  events: SessionEvent[];
  streams: RunStreamSnapshot[];
  running: boolean;
  sending: boolean;
  pendingUserText: string | null;
  selectedAgentName: string | null;
  error: string | null;
  teamRuns: TeamRun[];
  teamMessages: TeamMessage[];
  onApplyTeam: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
  onDiscardTeam: (teamRunId: string, teamTaskId: string) => Promise<TeamRun>;
  onResolveApproval: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<unknown>;
  onCancelRun: (runId?: string | null) => void;
  timelineEndRef: RefObject<HTMLDivElement | null>;
  hasSession: boolean;
}) {
  const phase = deriveConversationPhase({
    sending,
    running,
    events,
    streams,
  });
  const items = buildConversationItems(events, streams, {
    pendingUserText: sending ? pendingUserText : null,
  });
  const pendingApproval = events.find((event) => {
    if (event.type !== "approval.requested") return false;
    const approvalId = typeof event.payload.approvalId === "string" ? event.payload.approvalId : null;
    if (!approvalId) return false;
    return !events.some(
      (candidate) =>
        candidate.type === "approval.resolved"
        && candidate.payload.approvalId === approvalId,
    );
  });

  return (
    <>
      <div className={"conversation-status " + phase.phase} aria-live="polite">
        <span className="conversation-status-dot" />
        <div className="conversation-status-copy">
          <strong>
            {phase.phase === "sending" ? "Sending"
              : phase.phase === "thinking" ? "Thinking"
              : phase.phase === "tool" ? "Using tools"
              : phase.phase === "streaming" ? "Writing reply"
              : phase.phase === "awaiting_approval" ? "Needs approval"
              : phase.phase === "failed" ? "Failed"
              : phase.phase === "cancelled" ? "Cancelled"
              : phase.phase === "completed" ? "Ready"
              : "Idle"}
          </strong>
          <small>{phase.detail}{selectedAgentName && running ? ` · ${selectedAgentName}` : ""}</small>
        </div>
        {running && (
          <button
            type="button"
            className="stop-button"
            onClick={() => {
              const runId = streams[0]?.runId
                ?? (typeof pendingApproval?.payload.runId === "string" ? pendingApproval.payload.runId : null);
              onCancelRun(runId);
            }}
          >
            Stop
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {teamRuns[0] && (
        <TeamRunSummary
          team={teamRuns[0]}
          messages={teamMessages}
          onApply={onApplyTeam}
          onDiscard={onDiscardTeam}
        />
      )}

      <div className="timeline conversation-feed">
        {!hasSession ? (
          <div className="empty-state">
            <div className="orbital-mark"><Command size={27} /></div>
            <span className="eyebrow">NO ACTIVE TASK</span>
            <h3>Create a session to begin.</h3>
            <p>Chat stays beside the editor. Create a task, then send a message to the agent.</p>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <div className="orbital-mark"><Sparkles size={27} /></div>
            <span className="eyebrow">CONVERSATION READY</span>
            <h3>Send a message to start.</h3>
            <p>You’ll see sending → thinking → tools → streaming reply here, so you always know what the agent is doing.</p>
          </div>
        ) : (
          items.map((item) => {
            if (item.kind === "user") {
              return (
                <article className={"chat-bubble user" + (item.pending ? " pending" : "")} key={item.id}>
                  <div className="chat-bubble-meta">
                    <strong>You</strong>
                    <span>{item.pending ? "sending…" : new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p>{item.text}</p>
                </article>
              );
            }
            if (item.kind === "agent") {
              return (
                <article className="chat-bubble agent" key={item.id}>
                  <div className="chat-bubble-meta">
                    <strong>{item.agentLabel}</strong>
                    <span>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <p>{item.text}</p>
                </article>
              );
            }
            if (item.kind === "stream") {
              return <StreamingEvent key={item.id} stream={item.stream} />;
            }
            return (
              <ActivityItem
                key={item.id}
                label={item.label}
                detail={item.detail}
                status={item.status}
                event={item.event}
                events={events}
                onResolveApproval={onResolveApproval}
              />
            );
          })
        )}
        <div ref={timelineEndRef} />
      </div>
    </>
  );
}

function ActivityItem({
  label,
  detail,
  status,
  event,
  events,
  onResolveApproval,
}: {
  label: string;
  detail: string;
  status: "running" | "done" | "error" | "info" | "approval";
  event: SessionEvent;
  events: SessionEvent[];
  onResolveApproval: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(status === "approval" || status === "running" || status === "error");
  const showTool = event.type === "tool.call.started" || event.type === "tool.call.completed";
  return (
    <article className={"activity-item " + status + (open ? " open" : "")}>
      <button type="button" className="activity-summary" onClick={() => setOpen((value) => !value)}>
        <span className={"activity-dot " + status} />
        <strong>{label}</strong>
        <span className="activity-status-text">{status}</span>
        <span className="activity-time">{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </button>
      {open && (
        <div className="activity-body">
          <p>{detail}</p>
          {showTool && (
            <div className={"tool-card" + (event.payload.isError === true ? " error" : "")}>
              <div className="tool-card-header">
                <strong>{String(event.payload.toolName ?? event.actor.label)}</strong>
                <span>{event.type === "tool.call.started" ? "running" : event.payload.isError === true ? "failed" : "done"}</span>
              </div>
              {event.type === "tool.call.started" && event.payload.arguments != null && (
                <pre>{JSON.stringify(event.payload.arguments, null, 2)}</pre>
              )}
              {event.type === "tool.call.completed" && typeof event.payload.output === "string" && event.payload.output && (
                <pre>{event.payload.output}</pre>
              )}
            </div>
          )}
          {event.type === "approval.requested" && (
            <TimelineEvent event={event} events={events} onResolveApproval={onResolveApproval} />
          )}
        </div>
      )}
    </article>
  );
}

function TimelineEvent({
  event,
  events,
  onResolveApproval,
}: {
  event: SessionEvent;
  events: SessionEvent[];
  onResolveApproval: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ) => Promise<unknown>;
}) {
  const [resolving, setResolving] = useState<ApprovalDecision | null>(null);
  const text = describeEvent(event);
  const isUser = event.actor.kind === "user";
  const approvalId = typeof event.payload.approvalId === "string" ? event.payload.approvalId : null;
  const resolution = event.type === "approval.requested" && approvalId
    ? events.find((candidate) =>
      candidate.type === "approval.resolved" && candidate.payload.approvalId === approvalId,
    )
    : undefined;
  const resolvedDecision = resolution?.payload.decision === "approved" || resolution?.payload.decision === "denied"
    ? resolution.payload.decision
    : null;

  const resolve = async (decision: ApprovalDecision) => {
    if (!approvalId || resolvedDecision || resolving) return;
    setResolving(decision);
    try {
      await onResolveApproval(event.sessionId, approvalId, decision);
    } catch {
      // The shared error banner is updated by the data hook.
    } finally {
      setResolving(null);
    }
  };

  return (
    <article className={`timeline-event ${isUser ? "user-event" : "system-event"}`}>
      <div className="event-rail">
        <span className="event-node">{String(event.sequence).padStart(2, "0")}</span>
        <span className="event-line" />
      </div>
      <div className="event-body">
        <div className="event-meta">
          <strong>{event.actor.label}</strong>
          <span>{event.type}</span>
          <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </div>
        <p>{text}</p>
        {(event.type === "tool.call.started" || event.type === "tool.call.completed") && (
          <div className={"tool-card" + (event.payload.isError === true ? " error" : "")}>
            <div className="tool-card-header">
              <strong>{String(event.payload.toolName ?? event.actor.label)}</strong>
              <span>{event.type === "tool.call.started" ? "running" : event.payload.isError === true ? "failed" : "done"}</span>
            </div>
            {event.type === "tool.call.started" && event.payload.arguments != null && (
              <pre>{JSON.stringify(event.payload.arguments, null, 2)}</pre>
            )}
            {event.type === "tool.call.completed" && typeof event.payload.output === "string" && event.payload.output && (
              <pre>{event.payload.output}</pre>
            )}
          </div>
        )}
        {event.type === "approval.requested" && approvalId && (
          <ApprovalRequest
            event={event}
            decision={resolvedDecision}
            resolving={resolving}
            onResolve={resolve}
          />
        )}
      </div>
    </article>
  );
}

function StreamingEvent({ stream }: { stream: RunStreamSnapshot }) {
  return (
    <article className="timeline-event system-event streaming-event" aria-label="Streaming agent response">
      <div className="event-rail">
        <span className="event-node"><Radio size={11} /></span>
        <span className="event-line" />
      </div>
      <div className="event-body">
        <div className="event-meta">
          <strong>{stream.agentLabel}</strong>
          <span>streaming · turn {stream.turn}</span>
          <span className="stream-revision">rev {stream.revision}</span>
        </div>
        <p className={stream.text ? "stream-text" : "stream-waiting"}>
          {stream.text || "Waiting for provider output…"}
          {stream.text && <span className="stream-cursor" aria-hidden="true" />}
        </p>
      </div>
    </article>
  );
}

function ApprovalRequest({
  event,
  decision,
  resolving,
  onResolve,
}: {
  event: SessionEvent;
  decision: ApprovalDecision | null;
  resolving: ApprovalDecision | null;
  onResolve: (decision: ApprovalDecision) => Promise<void>;
}) {
  const presentation = describeApprovalRequest(event);
  const disabled = decision !== null || resolving !== null;

  return (
    <div className={`approval-card ${decision ?? "pending"}`}>
      <div className="approval-summary">
        <ShieldCheck size={17} />
        <div>
          <strong>{presentation.title}</strong>
          <small>{presentation.detail}</small>
        </div>
      </div>
      {presentation.preview && <pre className="approval-preview">{presentation.preview}</pre>}
      {decision ? (
        <div className="approval-decision">{decision === "approved" ? "Approved on a connected terminal" : "Denied on a connected terminal"}</div>
      ) : (
        <div className="approval-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={disabled}
            aria-label={presentation.denyAriaLabel}
            onClick={() => void onResolve("denied")}
          >
            {resolving === "denied" ? "Denying…" : presentation.denyLabel}
          </button>
          <button
            type="button"
            className="approval-button"
            disabled={disabled}
            aria-label={presentation.approveAriaLabel}
            onClick={() => void onResolve("approved")}
          >
            {resolving === "approved" ? "Approving…" : presentation.approveLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function TelemetryCard({ icon, label, value, detail, tone }: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  tone: "good" | "neutral" | "quiet";
}) {
  return (
    <div className={`telemetry-card ${tone}`}>
      <div className="telemetry-icon">{icon}</div>
      <div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>
    </div>
  );
}

function Capability({ icon, label, status = "planned" }: {
  icon: ReactNode;
  label: string;
  status?: "connected" | "planned";
}) {
  return <div className={`capability-row ${status}`}>{icon}<span>{label}</span><small>{status}</small></div>;
}

function ExtensionStorePanel({
  compact = false,
  className,
  defaultKind = "all",
  onListExtensionStores,
  onListExtensionCatalog,
  onInstallExtension,
  onInstallGithubSkill,
  onInstalled,
}: {
  compact?: boolean;
  className?: string;
  defaultKind?: "all" | "skills" | "mcp";
  onListExtensionStores: () => Promise<ExtensionStore[]>;
  onListExtensionCatalog: (
    storeId: string,
    options?: { q?: string; refresh?: boolean },
  ) => Promise<ExtensionCatalogEntry[]>;
  onInstallExtension: (
    storeId: string,
    input: { entryId: string; env?: Record<string, string>; enabled?: boolean },
  ) => Promise<{ kind: string; skill?: SkillSummary; server?: McpServer }>;
  onInstallGithubSkill: (input: {
    repo: string;
    path: string;
    ref?: string;
    skillId?: string;
  }) => Promise<SkillSummary>;
  onInstalled?: () => void;
}) {
  const [stores, setStores] = useState<ExtensionStore[]>([]);
  const [storeId, setStoreId] = useState("");
  const [entries, setEntries] = useState<ExtensionCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [envDrafts, setEnvDrafts] = useState<Record<string, Record<string, string>>>({});
  const [githubRepo, setGithubRepo] = useState("openai/skills");
  const [githubPath, setGithubPath] = useState("skills/.system/skill-creator");
  const [githubRef, setGithubRef] = useState("main");

  const loadCatalog = async (nextStoreId: string, options?: { q?: string; refresh?: boolean }) => {
    if (!nextStoreId) return;
    setBusy(true);
    try {
      const nextEntries = await onListExtensionCatalog(nextStoreId, options);
      setEntries(nextEntries);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to load extension catalog");
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const nextStores = await onListExtensionStores();
        if (cancelled) return;
        const filtered = nextStores.filter((store) => {
          if (defaultKind === "all") return true;
          if (defaultKind === "skills") return store.kind === "skills";
          return store.kind === "mcp";
        });
        setStores(filtered);
        const initial = filtered[0]?.id ?? "";
        setStoreId(initial);
        if (initial) {
          const nextEntries = await onListExtensionCatalog(initial);
          if (!cancelled) setEntries(nextEntries);
        }
      } catch (reason) {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Failed to load extension stores");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [defaultKind, onListExtensionStores, onListExtensionCatalog]);

  const activeStore = stores.find((store) => store.id === storeId) ?? null;

  const installEntry = async (entry: ExtensionCatalogEntry) => {
    setBusy(true);
    try {
      const requiredEnv = entry.config?.requiredEnv ?? [];
      const env = envDrafts[entry.id] ?? {};
      for (const key of requiredEnv) {
        if (!env[key]?.trim()) {
          throw new Error(`Missing required env: ${key}`);
        }
      }
      await onInstallExtension(entry.storeId, {
        entryId: entry.id,
        env,
        enabled: requiredEnv.length === 0 ? true : undefined,
      });
      await loadCatalog(entry.storeId, { q: query });
      onInstalled?.();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Install failed");
    } finally {
      setBusy(false);
    }
  };

  const installFromGithub = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onInstallGithubSkill({
        repo: githubRepo.trim(),
        path: githubPath.trim(),
        ref: githubRef.trim() || "main",
      });
      if (storeId) await loadCatalog(storeId, { q: query });
      onInstalled?.();
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "GitHub skill install failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`extension-store-panel ${compact ? "compact" : ""} ${className ?? ""}`.trim()}>
      <div className="permission-config-header">
        <div className="permission-config-title">
          <Store size={17} />
          <div>
            <strong>{compact ? "Open catalog" : "Extension Store"}</strong>
            <small>
              {activeStore
                ? `${activeStore.name} · ${activeStore.source}${activeStore.defaultConnected ? " · default connected" : ""}`
                : "Curated open MCP/Skills sources"}
            </small>
          </div>
        </div>
        <div className="extension-store-actions">
          {stores.length > 1 && (
            <select
              value={storeId}
              disabled={busy}
              onChange={(event) => {
                const next = event.target.value;
                setStoreId(next);
                void loadCatalog(next, { q: query });
              }}
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={busy || !storeId}
            onClick={() => void loadCatalog(storeId, { q: query, refresh: true })}
          >
            Refresh
          </button>
        </div>
      </div>

      <div className="extension-store-search">
        <input
          value={query}
          placeholder="Search catalog"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void loadCatalog(storeId, { q: query });
            }
          }}
        />
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !storeId}
          onClick={() => void loadCatalog(storeId, { q: query })}
        >
          Search
        </button>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="extension-list">
        {entries.length === 0 ? (
          <div className="permission-empty">No catalog entries match the current filters.</div>
        ) : entries.map((entry) => {
          const requiredEnv = entry.config?.requiredEnv ?? [];
          return (
            <div className="extension-row store-entry" key={`${entry.storeId}:${entry.id}`}>
              <div>
                <strong>{entry.name}</strong>
                <small>
                  {entry.kind}
                  {entry.installed ? " · installed" : ""}
                  {entry.tags.length > 0 ? ` · ${entry.tags.slice(0, 3).join(", ")}` : ""}
                </small>
              </div>
              <p>{entry.description}</p>
              {requiredEnv.length > 0 && !entry.installed && (
                <div className="store-env-grid">
                  {requiredEnv.map((key) => (
                    <label key={key}>
                      {key}
                      <input
                        value={envDrafts[entry.id]?.[key] ?? ""}
                        onChange={(event) => {
                          const value = event.target.value;
                          setEnvDrafts((current) => ({
                            ...current,
                            [entry.id]: {
                              ...(current[entry.id] ?? {}),
                              [key]: value,
                            },
                          }));
                        }}
                        placeholder={key}
                        autoComplete="off"
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="store-entry-footer">
                {entry.homepage ? (
                  <a href={entry.homepage} target="_blank" rel="noreferrer">
                    Source
                  </a>
                ) : <span />}
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy || entry.installed}
                  onClick={() => void installEntry(entry)}
                >
                  {entry.installed ? "Installed" : "Install"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {(defaultKind === "all" || defaultKind === "skills") && (
        <form className="runtime-form extension-form store-github-form" onSubmit={installFromGithub}>
          <div className="runtime-form-title">
            <Sparkles size={16} />
            <strong>Install skill from GitHub</strong>
            <small>public repo path</small>
          </div>
          <label>
            Repo
            <input value={githubRepo} onChange={(event) => setGithubRepo(event.target.value)} placeholder="owner/repo" required />
          </label>
          <label>
            Path
            <input value={githubPath} onChange={(event) => setGithubPath(event.target.value)} placeholder="skills/my-skill" required />
          </label>
          <label>
            Ref
            <input value={githubRef} onChange={(event) => setGithubRef(event.target.value)} placeholder="main" />
          </label>
          <button className="primary-button" disabled={busy || !githubRepo.trim() || !githubPath.trim()}>
            Install from GitHub
          </button>
        </form>
      )}
    </section>
  );
}


