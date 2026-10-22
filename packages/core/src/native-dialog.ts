import { execFile } from "node:child_process";

const TIMEOUT_MS = 10 * 60_000;

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; missing: boolean }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: false, maxBuffer: 1 << 20, encoding: "utf8" }, (err, stdout) => {
			if (!err) return resolve({ code: 0, stdout, missing: false });
			const e = err as NodeJS.ErrnoException & { code?: string | number };
			resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", missing: e.code === "ENOENT" });
		});
	});
}

const WIN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
$owner.Show()
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.ShowNewFolderButton = $true
$start = $env:PROMETHEUS_PICK_START
if ($start -and (Test-Path -LiteralPath $start)) { $dlg.SelectedPath = $start }
$result = $dlg.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
`;

/**
 * Shows the operating system's folder chooser on the machine running this process.
 * Resolves to null when the user cancels; rejects when no dialog tool is available (e.g. a headless Linux box).
 */
export async function pickFolderNative(start?: string): Promise<string | null> {
	const env = { ...process.env, PROMETHEUS_PICK_START: start ?? "" };
	const clean = (s: string) => s.replace(/[\r\n]+$/g, "").trim() || null;

	if (process.platform === "win32") {
		const encoded = Buffer.from(WIN_SCRIPT, "utf16le").toString("base64");
		const r = await new Promise<{ code: number; stdout: string; missing: boolean }>((resolve) =>
			execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded], { env, timeout: TIMEOUT_MS, encoding: "utf8" }, (err, stdout) =>
				resolve({ code: err ? 1 : 0, stdout: stdout ?? "", missing: (err as NodeJS.ErrnoException | null)?.code === "ENOENT" }),
			),
		);
		if (r.missing) throw new Error("找不到 PowerShell，无法打开系统文件夹选择框");
		return clean(r.stdout);
	}

	if (process.platform === "darwin") {
		const script = start
			? `POSIX path of (choose folder with prompt "选择文件夹" default location POSIX file ${JSON.stringify(start)})`
			: `POSIX path of (choose folder with prompt "选择文件夹")`;
		const r = await run("osascript", ["-e", script]);
		if (r.missing) throw new Error("找不到 osascript");
		return r.code === 0 ? clean(r.stdout) : null;
	}

	const zenity = await run("zenity", ["--file-selection", "--directory", "--title=选择文件夹", ...(start ? [`--filename=${start.replace(/\/?$/, "/")}`] : [])]);
	if (!zenity.missing) return zenity.code === 0 ? clean(zenity.stdout) : null;
	const kdialog = await run("kdialog", ["--getexistingdirectory", start || process.env.HOME || "/"]);
	if (!kdialog.missing) return kdialog.code === 0 ? clean(kdialog.stdout) : null;
	throw new Error("系统缺少图形文件夹选择工具（zenity / kdialog）或没有桌面环境");
}
