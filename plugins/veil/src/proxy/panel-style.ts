/** Shared stylesheet for the panels. Inlined into each page; keeps the panels close to Prometheus' dark theme. */
export const PANEL_STYLE = `
:root {
  --bg: #0d0e11;
  --card: #15171c;
  --line: #262a33;
  --ink: #e6e8ec;
  --dim: #8b929f;
  --accent: #f0955a;
  --ok: #6fbf8b;
  --warn: #e0b25a;
  --bad: #e07a7a;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: var(--bg); color: var(--ink);
  font: 13px/1.55 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  padding: 18px; overflow-y: auto;
}
h1 { font-size: 17px; margin: 0 0 2px; font-weight: 600; letter-spacing: .01em; }
h2 { font-size: 13px; margin: 0 0 10px; font-weight: 600; color: var(--ink); }
p.sub { margin: 0 0 18px; color: var(--dim); font-size: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 14px; }
.row { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; padding: 9px 0; border-top: 1px solid var(--line); }
.row:first-of-type { border-top: 0; padding-top: 0; }
.row-text { min-width: 0; }
.row-title { font-size: 13px; }
.row-hint { color: var(--dim); font-size: 11.5px; margin-top: 2px; }
label.field { display: block; margin-bottom: 10px; }
label.field > span { display: block; font-size: 12px; color: var(--dim); margin-bottom: 4px; }
input[type=text], input[type=number], input[type=password], textarea, select {
  width: 100%; background: #0f1116; color: var(--ink);
  border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; font: inherit; font-size: 12.5px;
}
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px rgba(240,149,90,.15); }
textarea { resize: vertical; min-height: 62px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
button {
  font: inherit; font-size: 12.5px; border-radius: 7px; padding: 6px 12px; cursor: pointer;
  border: 1px solid var(--line); background: #1c1f26; color: var(--ink); transition: .12s;
}
button:hover:not(:disabled) { border-color: #3a404c; background: #22262e; }
button:disabled { opacity: .45; cursor: not-allowed; }
button.primary { background: var(--accent); border-color: var(--accent); color: #17191d; font-weight: 600; }
button.primary:hover:not(:disabled) { background: #f5a76f; border-color: #f5a76f; }
button.danger { color: var(--bad); border-color: #3a2626; }
button.ghost { background: transparent; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.toggle { position: relative; width: 38px; height: 21px; flex: none; }
.toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.toggle span { position: absolute; inset: 0; border-radius: 999px; background: #2b2f38; transition: .15s; pointer-events: none; }
.toggle span::after { content: ""; position: absolute; top: 3px; left: 3px; width: 15px; height: 15px; border-radius: 50%; background: #8b929f; transition: .15s; }
.toggle input:checked + span { background: rgba(240,149,90,.32); }
.toggle input:checked + span::after { transform: translateX(17px); background: var(--accent); }
.toggle input:disabled + span { opacity: .4; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
.pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line); color: var(--dim); }
.pill.ok { color: var(--ok); border-color: rgba(111,191,139,.35); background: rgba(111,191,139,.08); }
.pill.bad { color: var(--bad); border-color: rgba(224,122,122,.35); background: rgba(224,122,122,.08); }
.pill.warn { color: var(--warn); border-color: rgba(224,178,90,.35); background: rgba(224,178,90,.08); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th { text-align: left; color: var(--dim); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; padding: 0 8px 6px 0; }
td { padding: 6px 8px 6px 0; border-top: 1px solid var(--line); vertical-align: top; }
code, .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.mono { color: var(--dim); word-break: break-all; }
.empty { color: var(--dim); font-size: 12px; padding: 10px 0; }
.err { color: var(--bad); font-size: 12px; margin-top: 8px; white-space: pre-wrap; }
.okmsg { color: var(--ok); font-size: 12px; margin-top: 8px; }
.bar { display: flex; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
.bar button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; padding: 7px 10px; color: var(--dim); }
.bar button.on { color: var(--ink); border-bottom-color: var(--accent); }
.hidden { display: none !important; }
.rule-head { display: flex; align-items: center; gap: 8px; }
.type { color: var(--accent); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; }
.builtin { font-size: 10.5px; color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
details.rule { border-top: 1px solid var(--line); padding: 7px 0; }
details.rule > summary { cursor: pointer; list-style: none; display: flex; align-items: center; gap: 8px; }
details.rule > summary::-webkit-details-marker { display: none; }
details.rule[open] > summary { margin-bottom: 8px; }
`.trim();
