import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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

// Explorer-style chooser (IFileOpenDialog in folder mode): address bar, search, favourites, new-folder button,
// instead of the old tree-only FolderBrowserDialog.
const WIN_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PrometheusFolderPick {
	[ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")] class FileOpenDialogCls {}
	[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IShellItem {
		void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
		void GetParent(out IShellItem ppsi);
		void GetDisplayName(uint sigdnName, out IntPtr ppszName);
		void GetAttributes(uint mask, out uint attrs);
		void Compare(IShellItem psi, uint hint, out int order);
	}
	[ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	interface IFileDialog {
		[PreserveSig] int Show(IntPtr parent);
		void SetFileTypes(uint c, IntPtr types);
		void SetFileTypeIndex(uint i);
		void GetFileTypeIndex(out uint i);
		void Advise(IntPtr events, out uint cookie);
		void Unadvise(uint cookie);
		void SetOptions(uint options);
		void GetOptions(out uint options);
		void SetDefaultFolder(IShellItem item);
		void SetFolder(IShellItem item);
		void GetFolder(out IShellItem item);
		void GetCurrentSelection(out IShellItem item);
		void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
		void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
		void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
		void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
		void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
		void GetResult(out IShellItem item);
	}
	[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
	static extern void SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, out IShellItem item);
	[DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);

	public static string Pick(IntPtr owner, string start, string title) {
		IFileDialog dlg = (IFileDialog)new FileOpenDialogCls();
		uint opts; dlg.GetOptions(out opts);
		dlg.SetOptions(opts | 0x20u | 0x40u | 0x800u);
		dlg.SetTitle(title);
		if (!string.IsNullOrEmpty(start)) {
			try {
				Guid iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
				IShellItem folder; SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out folder);
				dlg.SetFolder(folder);
			} catch { }
		}
		int hr = dlg.Show(owner);
		if (hr != 0) return null;
		IShellItem item; dlg.GetResult(out item);
		IntPtr ptr; item.GetDisplayName(0x80058000u, out ptr);
		string path = Marshal.PtrToStringUni(ptr);
		CoTaskMemFree(ptr);
		return path;
	}
}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = 'CenterScreen' }
$owner.Show()
$path = [PrometheusFolderPick]::Pick($owner.Handle, $env:PROMETHEUS_PICK_START, $env:PROMETHEUS_PICK_TITLE)
$owner.Close()
if ($path) { Write-Output $path }
`;
/**
 * Shows the operating system's folder chooser on the machine running this process.
 * Resolves to null when the user cancels; rejects when no dialog tool is available (e.g. a headless Linux box).
 */
export async function pickFolderNative(start?: string): Promise<string | null> {
	const env = { ...process.env, PROMETHEUS_PICK_START: start ?? "", PROMETHEUS_PICK_TITLE: "选择文件夹" };
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

/** Opens an http(s) link in the default browser of the machine the server runs on. */
export async function openUrlNative(url: string): Promise<void> {
	if (!/^https?:\/\/[^\s\x00-\x1f]+$/i.test(url)) throw new Error("only http(s) links can be opened");
	const [cmd, args] =
		process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
	const r = await run(cmd as string, args as string[]);
	if (r.code !== 0) throw new Error("could not open the default browser");
}

// ---------- open a folder in an external app ----------

export interface ExternalApp {
	id: string;
	label: string;
}

const EDITORS: { id: string; label: string; win: string[]; mac: string; bin: string }[] = [
	{
		id: "vscode",
		label: "VS Code",
		win: ["%LOCALAPPDATA%/Programs/Microsoft VS Code/Code.exe", "%ProgramFiles%/Microsoft VS Code/Code.exe", "%ProgramFiles(x86)%/Microsoft VS Code/Code.exe"],
		mac: "Visual Studio Code",
		bin: "code",
	},
	{ id: "cursor", label: "Cursor", win: ["%LOCALAPPDATA%/Programs/cursor/Cursor.exe", "%ProgramFiles%/Cursor/Cursor.exe"], mac: "Cursor", bin: "cursor" },
	{ id: "windsurf", label: "Windsurf", win: ["%LOCALAPPDATA%/Programs/Windsurf/Windsurf.exe"], mac: "Windsurf", bin: "windsurf" },
];

const expandEnv = (p: string) => p.replace(/%([^%]+)%/g, (_, k: string) => process.env[k] ?? "");

async function onPath(bin: string): Promise<string | null> {
	const r = await run(process.platform === "win32" ? "where.exe" : "which", [bin]);
	return r.code === 0 ? (r.stdout.split(/\r?\n/).find((l) => l.trim()) ?? null) : null;
}

/** Where an editor's launcher lives on this machine, or null when it isn't installed. */
async function findEditor(e: (typeof EDITORS)[number]): Promise<string | null> {
	if (process.platform === "win32") {
		for (const c of e.win) {
			const exe = expandEnv(c);
			if (exe && !exe.startsWith("\\") && existsSync(exe)) return exe;
		}
		// `code.cmd` sits in <install>\bin; the real executable is one level up.
		const cmd = await onPath(e.bin);
		if (cmd) {
			const exe = join(dirname(dirname(cmd.trim())), `${e.win[0]?.split("/").pop() ?? ""}`);
			if (existsSync(exe)) return exe;
		}
		return null;
	}
	if (process.platform === "darwin") return existsSync(`/Applications/${e.mac}.app`) || existsSync(join(process.env.HOME ?? "", "Applications", `${e.mac}.app`)) ? e.mac : null;
	return onPath(e.bin);
}

/** Apps that can open a workspace folder here: the file manager always, editors only when installed. */
export async function listExternalApps(): Promise<ExternalApp[]> {
	const manager = process.platform === "win32" ? "资源管理器" : process.platform === "darwin" ? "Finder" : "文件管理器";
	const apps: ExternalApp[] = [{ id: "files", label: manager }];
	const found = await Promise.all(EDITORS.map(async (e) => ((await findEditor(e)) ? { id: e.id, label: e.label } : null)));
	for (const f of found) if (f) apps.push(f);
	return apps;
}

function launch(cmd: string, args: string[]): void {
	const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: false });
	child.on("error", () => {});
	child.unref();
}

/** Opens a folder in the chosen app. The caller must already have checked that `path` is a workspace. */
export async function openInExternalApp(app: string, path: string): Promise<void> {
	if (!existsSync(path)) throw new Error("目录不存在");
	if (app === "files") {
		if (process.platform === "win32") launch("explorer.exe", [path]);
		else launch(process.platform === "darwin" ? "open" : "xdg-open", [path]);
		return;
	}
	const editor = EDITORS.find((e) => e.id === app);
	if (!editor) throw new Error("不支持的应用");
	const found = await findEditor(editor);
	if (!found) throw new Error(`未检测到 ${editor.label}`);
	if (process.platform === "darwin") launch("open", ["-a", found, path]);
	else launch(found, [path]);
}
