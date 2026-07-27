import { Command, FileCode2, Search, Settings2, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type PaletteMode = "files" | "commands";

export type PaletteCommand = {
  id: string;
  label: string;
  detail?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  mode: PaletteMode;
  files: string[];
  commands: PaletteCommand[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
};

export function CommandPalette({
  open,
  mode,
  files,
  commands,
  onClose,
  onOpenFile,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open, mode]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (mode === "files") {
      const filtered = (q
        ? files.filter((path) => path.toLowerCase().includes(q))
        : files
      ).slice(0, 80);
      return filtered.map((path) => ({
        id: path,
        label: path.split("/").pop() ?? path,
        detail: path,
        kind: "file" as const,
      }));
    }
    const filtered = q
      ? commands.filter((command) =>
          `${command.label} ${command.detail ?? ""}`.toLowerCase().includes(q),
        )
      : commands;
    return filtered.map((command) => ({
      id: command.id,
      label: command.label,
      detail: command.detail,
      kind: "command" as const,
    }));
  }, [commands, files, mode, query]);

  useEffect(() => {
    setActive(0);
  }, [query, mode, open]);

  if (!open) return null;

  const runItem = (index: number) => {
    const item = items[index];
    if (!item) return;
    if (item.kind === "file") {
      onOpenFile(item.id);
    } else {
      commands.find((command) => command.id === item.id)?.run();
    }
    onClose();
  };

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label={mode === "files" ? "Quick Open" : "Command Palette"}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input-row">
          {mode === "files" ? <FileCode2 size={16} /> : <Command size={16} />}
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "files" ? "Search files by name…" : "Type a command…"}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((current) => Math.min(current + 1, Math.max(items.length - 1, 0)));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((current) => Math.max(current - 1, 0));
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                runItem(active);
              }
            }}
          />
          <span className="palette-mode">{mode === "files" ? "Ctrl+P" : "Ctrl+Shift+P"}</span>
        </div>
        <div className="palette-list" role="listbox">
          {items.length === 0 ? (
            <div className="palette-empty">No matches</div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={index === active ? "palette-item active" : "palette-item"}
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => runItem(index)}
              >
                <span className="palette-item-icon">
                  {item.kind === "file" ? <FileCode2 size={14} /> : item.id.includes("search") ? <Search size={14} /> : item.id.includes("settings") ? <Settings2 size={14} /> : <Sparkles size={14} />}
                </span>
                <span className="palette-item-copy">
                  <strong>{item.label}</strong>
                  {item.detail && <small>{item.detail}</small>}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
