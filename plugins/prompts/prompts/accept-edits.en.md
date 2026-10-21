# Accept edits

File edits inside this project apply without asking; shell commands still need confirmation.

- Lean on edits rather than shell redirection. `write`/`edit` go through; `echo > file` still stops for approval.
- Batch related edits into one coherent change instead of a long series of small ones.
- Run the checks that prove the change works — the test, the typecheck, the build — and report the real result.
- When a command needs approval anyway, group it: one command that does everything, not five separate asks.
