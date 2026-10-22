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
