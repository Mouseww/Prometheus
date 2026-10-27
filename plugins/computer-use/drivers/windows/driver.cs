// Prometheus Computer Use driver for Windows (UI Automation).
//
// Compiled at runtime by Windows PowerShell's Add-Type against .NET Framework 4.x, so it needs
// nothing beyond a stock Windows install. Keep it to C# 5 syntax: no string interpolation, no
// `?.`, no expression-bodied members, no `nameof`.
//
// Protocol: JSON-RPC 2.0, one JSON object per line on stdin/stdout (UTF-8, no BOM). The driver only
// reads the tree and carries out actions; trimming, diffing, policy and redaction of what the model
// sees all live in the host. Passwords are still never read here (defence in depth).

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;

namespace PrometheusCU
{
    public class DriverError : Exception
    {
        public string Code;
        public DriverError(string code, string message) : base(message) { Code = code; }
    }

    class RefEntry
    {
        public AutomationElement Element;
        public int Hwnd;
        public string AutomationId;
        public string Name;
        public int ControlTypeId;
    }

    public static class Driver
    {
        const string VERSION = "0.1.0";
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 1000 };
        static TextWriter Out;
        static readonly object OutLock = new object();

        // ref -> element, and runtime id -> ref so an element keeps its ref across snapshots.
        static readonly Dictionary<string, RefEntry> Refs = new Dictionary<string, RefEntry>();
        static readonly Dictionary<string, string> RefByRuntimeId = new Dictionary<string, string>();
        static int NextRef = 1;
        const int MAX_REFS = 50000;

        public static void Run()
        {
            // UI Automation clients should live on an MTA thread; the PowerShell host thread is STA.
            Exception failure = null;
            var t = new Thread(delegate () { try { Loop(); } catch (Exception e) { failure = e; } });
            t.SetApartmentState(ApartmentState.MTA);
            t.IsBackground = false;
            t.Start();
            t.Join();
            if (failure != null) throw failure;
        }

        static void Loop()
        {
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            ((StreamWriter)Out).AutoFlush = true;
            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Trim().Length == 0) continue;
                object id = null;
                try
                {
                    var req = Json.Deserialize<Dictionary<string, object>>(line);
                    req.TryGetValue("id", out id);
                    object m; req.TryGetValue("method", out m);
                    object p; req.TryGetValue("params", out p);
                    var prms = p as Dictionary<string, object> ?? new Dictionary<string, object>();
                    var method = m as string ?? "";
                    if (method == "shutdown") { Reply(id, true, null); return; }
                    var result = Dispatch(method, prms);
                    Reply(id, result, null);
                }
                catch (DriverError e) { Reply(id, null, Err(e.Code, e.Message)); }
                catch (ElementNotAvailableException e) { Reply(id, null, Err("stale_ref", e.Message)); }
                catch (Exception e) { Reply(id, null, Err("internal", e.GetType().Name + ": " + e.Message)); }
            }
        }

        static Dictionary<string, object> Err(string code, string message)
        {
            var d = new Dictionary<string, object>();
            d["code"] = -32000;
            d["message"] = message;
            var data = new Dictionary<string, object>();
            data["code"] = code;
            d["data"] = data;
            return d;
        }

        static void Reply(object id, object result, object error)
        {
            var d = new Dictionary<string, object>();
            d["jsonrpc"] = "2.0";
            d["id"] = id;
            if (error != null) d["error"] = error; else d["result"] = result;
            var text = Json.Serialize(d);
            lock (OutLock) { Out.WriteLine(text); }
        }

        static object Dispatch(string method, Dictionary<string, object> p)
        {
            switch (method)
            {
                case "hello": return Hello();
                case "windows.list": return ListWindows(p.ContainsKey("all") && p["all"] is bool && (bool)p["all"]);
                case "window.activate": Activate(HwndOf(p)); return Ok("activate");
                case "apps.launch": return Launch(Str(p, "target"), Str(p, "args"));
                case "tree.snapshot": return Snapshot(HwndOf(p), Str(p, "scope"), Int(p, "maxNodes", 4000), Int(p, "maxDepth", 60));
                case "node.act": return Act(Str(p, "ref"), Str(p, "op"), Str(p, "value"));
                case "input.keys": return Keys(Str(p, "keys"), p.ContainsKey("window") ? (int?)HwndOf(p) : null);
                case "input.text": return TypeText(Str(p, "text"), p.ContainsKey("window") ? (int?)HwndOf(p) : null);
                default: throw new DriverError("unknown_method", "Unknown method: " + method);
            }
        }

        // ---------- params ----------

        static string Str(Dictionary<string, object> p, string k)
        {
            object v; return p.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null;
        }

        static int Int(Dictionary<string, object> p, string k, int dflt)
        {
            object v; if (!p.TryGetValue(k, out v) || v == null) return dflt;
            try { return Convert.ToInt32(v); } catch { return dflt; }
        }

        static int HwndOf(Dictionary<string, object> p)
        {
            var s = Str(p, "window");
            int h;
            if (s == null || !int.TryParse(s, out h) || h == 0) throw new DriverError("bad_params", "window must be a window id from windows.list");
            if (!IsWindow(new IntPtr(h))) throw new DriverError("window_gone", "The window no longer exists");
            return h;
        }

        static Dictionary<string, object> Ok(string how)
        {
            var d = new Dictionary<string, object>();
            d["ok"] = true;
            d["method"] = how;
            return d;
        }

        // ---------- hello ----------

        static object Hello()
        {
            var d = new Dictionary<string, object>();
            d["platform"] = "windows";
            d["version"] = VERSION;
            d["os"] = Environment.OSVersion.VersionString;
            d["pid"] = Process.GetCurrentProcess().Id;
            d["capabilities"] = new[] { "tree", "semantic_actions", "background_actions", "synthetic_input" };
            var perms = new Dictionary<string, object>();
            perms["accessibility"] = "granted"; // UIA needs no grant; elevated targets fail per window instead.
            perms["elevated"] = IsElevated();
            d["permissions"] = perms;
            return d;
        }

        static bool IsElevated()
        {
            try
            {
                var id = System.Security.Principal.WindowsIdentity.GetCurrent();
                return new System.Security.Principal.WindowsPrincipal(id).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator);
            }
            catch { return false; }
        }

        // ---------- windows ----------

        // all=true also returns untitled windows (Win32 menu popups, flyouts) so the host can notice them appear.
        static object ListWindows(bool all)
        {
            var list = new List<object>();
            var fg = GetForegroundWindow().ToInt32();
            var self = Process.GetCurrentProcess().Id;
            var names = new Dictionary<int, string>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h)) return true;
                if (!all && GetWindow(h, 4 /* GW_OWNER */) != IntPtr.Zero && GetWindowTextLength(h) == 0) return true;
                int cloaked = 0;
                if (DwmGetWindowAttribute(h, 14 /* DWMWA_CLOAKED */, out cloaked, 4) == 0 && cloaked != 0) return true;
                var len = GetWindowTextLength(h);
                if (len == 0 && !all) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(h, sb, sb.Capacity);
                uint pid; GetWindowThreadProcessId(h, out pid);
                if ((int)pid == self) return true;
                string pname;
                if (!names.TryGetValue((int)pid, out pname))
                {
                    try { pname = Process.GetProcessById((int)pid).ProcessName; } catch { pname = "?"; }
                    names[(int)pid] = pname;
                }
                var cls = new StringBuilder(256);
                GetClassName(h, cls, cls.Capacity);
                var w = new Dictionary<string, object>();
                w["id"] = h.ToInt32().ToString();
                w["pid"] = (int)pid;
                w["app"] = pname;
                w["title"] = sb.ToString();
                w["className"] = cls.ToString();
                w["focused"] = h.ToInt32() == fg;
                w["minimized"] = IsIconic(h);
                list.Add(w);
                return true;
            }, IntPtr.Zero);
            return list;
        }

        static void Activate(int hwnd)
        {
            var h = new IntPtr(hwnd);
            if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */);
            if (GetForegroundWindow() == h) return;
            // Windows only lets the foreground owner hand focus over; borrowing its input queue is the
            // documented workaround, and a fake Alt press covers the remaining cases.
            uint dummy;
            var fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out dummy);
            var me = GetCurrentThreadId();
            bool attached = fgThread != me && AttachThreadInput(me, fgThread, true);
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(h);
            BringWindowToTop(h);
            if (attached) AttachThreadInput(me, fgThread, false);
            Thread.Sleep(60);
        }

        static object Launch(string target, string args)
        {
            if (string.IsNullOrEmpty(target)) throw new DriverError("bad_params", "target is required");
            var psi = new ProcessStartInfo(target);
            if (!string.IsNullOrEmpty(args)) psi.Arguments = args;
            psi.UseShellExecute = true;
            var proc = Process.Start(psi);
            var d = new Dictionary<string, object>();
            d["ok"] = true;
            d["pid"] = proc != null ? (object)proc.Id : null;
            return d;
        }

        // ---------- tree ----------

        static CacheRequest BuildCache()
        {
            var cr = new CacheRequest();
            cr.TreeScope = TreeScope.Subtree;
            cr.TreeFilter = Automation.ControlViewCondition;
            cr.AutomationElementMode = AutomationElementMode.Full;
            var props = new AutomationProperty[] {
                AutomationElement.RuntimeIdProperty, AutomationElement.NameProperty, AutomationElement.ControlTypeProperty,
                AutomationElement.AutomationIdProperty, AutomationElement.ClassNameProperty, AutomationElement.IsEnabledProperty,
                AutomationElement.IsOffscreenProperty, AutomationElement.BoundingRectangleProperty, AutomationElement.HasKeyboardFocusProperty,
                AutomationElement.IsPasswordProperty, AutomationElement.HelpTextProperty, AutomationElement.NativeWindowHandleProperty,
                AutomationElement.IsInvokePatternAvailableProperty, AutomationElement.IsValuePatternAvailableProperty,
                AutomationElement.IsTogglePatternAvailableProperty, AutomationElement.IsExpandCollapsePatternAvailableProperty,
                AutomationElement.IsSelectionItemPatternAvailableProperty, AutomationElement.IsScrollPatternAvailableProperty,
                AutomationElement.IsScrollItemPatternAvailableProperty, AutomationElement.IsRangeValuePatternAvailableProperty,
                AutomationElement.IsTextPatternAvailableProperty,
                ValuePattern.ValueProperty, ValuePattern.IsReadOnlyProperty, TogglePattern.ToggleStateProperty,
                ExpandCollapsePattern.ExpandCollapseStateProperty, SelectionItemPattern.IsSelectedProperty,
                RangeValuePattern.ValueProperty,
            };
            foreach (var prop in props) cr.Add(prop);
            return cr;
        }

        static object Cached(AutomationElement e, AutomationProperty p)
        {
            try
            {
                var v = e.GetCachedPropertyValue(p, true);
                return v == AutomationElement.NotSupported ? null : v;
            }
            catch { return null; }
        }

        static bool CachedBool(AutomationElement e, AutomationProperty p)
        {
            var v = Cached(e, p);
            return v is bool && (bool)v;
        }

        static object Snapshot(int hwnd, string scope, int maxNodes, int maxDepth)
        {
            if (RefByRuntimeId.Count > MAX_REFS) { Refs.Clear(); RefByRuntimeId.Clear(); }
            var cr = BuildCache();
            AutomationElement root;
            using (cr.Activate())
            {
                if (!string.IsNullOrEmpty(scope))
                {
                    var entry = Resolve(scope);
                    root = entry.Element.GetUpdatedCache(cr);
                }
                else
                {
                    root = AutomationElement.FromHandle(new IntPtr(hwnd));
                    // Chromium builds its tree lazily on the first UIA request; one retry catches it up.
                    if (CountChildren(root) == 0) { Thread.Sleep(150); root = AutomationElement.FromHandle(new IntPtr(hwnd)); }
                }
            }
            int budget = maxNodes;
            var tree = Walk(root, hwnd, 0, maxDepth, ref budget);
            var d = new Dictionary<string, object>();
            d["root"] = tree;
            d["truncated"] = budget <= 0;
            var focus = FocusedRef(hwnd);
            if (focus != null) d["focus"] = focus;
            return d;
        }

        static int CountChildren(AutomationElement e)
        {
            try { return e.CachedChildren.Count; } catch { return 0; }
        }

        static Dictionary<string, object> Walk(AutomationElement e, int hwnd, int depth, int maxDepth, ref int budget)
        {
            budget--;
            var node = Describe(e, hwnd);
            if (depth >= maxDepth) return node;
            AutomationElementCollection kids = null;
            try { kids = e.CachedChildren; } catch { }
            if (kids == null || kids.Count == 0) return node;
            var list = new List<object>();
            int omitted = 0;
            foreach (AutomationElement k in kids)
            {
                if (budget <= 0) { omitted++; continue; }
                list.Add(Walk(k, hwnd, depth + 1, maxDepth, ref budget));
            }
            node["children"] = list;
            if (omitted > 0) node["omitted"] = omitted;
            return node;
        }

        static string RuntimeKey(AutomationElement e)
        {
            var rid = Cached(e, AutomationElement.RuntimeIdProperty) as int[];
            if (rid == null) { try { rid = e.GetRuntimeId(); } catch { return null; } }
            return string.Join(".", Array.ConvertAll(rid, x => x.ToString()));
        }

        static string RefFor(AutomationElement e, int hwnd)
        {
            var key = RuntimeKey(e);
            string r;
            if (key != null && RefByRuntimeId.TryGetValue(key, out r))
            {
                Refs[r].Element = e;
                return r;
            }
            r = "e" + (NextRef++);
            if (key != null) RefByRuntimeId[key] = r;
            var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
            Refs[r] = new RefEntry
            {
                Element = e,
                Hwnd = hwnd,
                AutomationId = Cached(e, AutomationElement.AutomationIdProperty) as string,
                Name = Cached(e, AutomationElement.NameProperty) as string,
                ControlTypeId = ct != null ? ct.Id : 0,
            };
            return r;
        }

        static Dictionary<string, object> Describe(AutomationElement e, int hwnd)
        {
            var n = new Dictionary<string, object>();
            n["ref"] = RefFor(e, hwnd);
            var ct = Cached(e, AutomationElement.ControlTypeProperty) as ControlType;
            n["role"] = RoleOf(ct);
            var name = Cached(e, AutomationElement.NameProperty) as string;
            if (!string.IsNullOrEmpty(name)) n["name"] = name;
            var aid = Cached(e, AutomationElement.AutomationIdProperty) as string;
            if (!string.IsNullOrEmpty(aid)) n["id"] = aid;
            var cls = Cached(e, AutomationElement.ClassNameProperty) as string;
            if (!string.IsNullOrEmpty(cls)) n["className"] = cls;
            var help = Cached(e, AutomationElement.HelpTextProperty) as string;
            if (!string.IsNullOrEmpty(help)) n["description"] = help;

            var states = new List<string>();
            var actions = new List<string>();
            bool isSecret = CachedBool(e, AutomationElement.IsPasswordProperty);
            if (isSecret) states.Add("password");
            if (!CachedBool(e, AutomationElement.IsEnabledProperty)) states.Add("disabled");
            if (CachedBool(e, AutomationElement.IsOffscreenProperty)) states.Add("offscreen");
            if (CachedBool(e, AutomationElement.HasKeyboardFocusProperty)) states.Add("focused");

            if (CachedBool(e, AutomationElement.IsValuePatternAvailableProperty))
            {
                bool ro = CachedBool(e, ValuePattern.IsReadOnlyProperty);
                if (!ro) { states.Add("editable"); actions.Add("set_value"); actions.Add("type"); actions.Add("clear"); }
                if (!isSecret)
                {
                    var v = Cached(e, ValuePattern.ValueProperty) as string;
                    if (!string.IsNullOrEmpty(v)) n["value"] = v;
                }
            }
            else if (CachedBool(e, AutomationElement.IsTextPatternAvailableProperty) && !isSecret && (ct == ControlType.Document || ct == ControlType.Edit))
            {
                try
                {
                    var tp = (TextPattern)e.GetCurrentPattern(TextPattern.Pattern);
                    var text = tp.DocumentRange.GetText(4000);
                    if (!string.IsNullOrEmpty(text)) n["value"] = text;
                }
                catch { }
                actions.Add("type");
            }
            if (CachedBool(e, AutomationElement.IsRangeValuePatternAvailableProperty))
            {
                var rv = Cached(e, RangeValuePattern.ValueProperty);
                if (rv != null) n["value"] = Convert.ToString(rv, System.Globalization.CultureInfo.InvariantCulture);
                if (!actions.Contains("set_value")) actions.Add("set_value");
            }
            if (CachedBool(e, AutomationElement.IsInvokePatternAvailableProperty)) actions.Add("click");
            if (CachedBool(e, AutomationElement.IsTogglePatternAvailableProperty))
            {
                var ts = Cached(e, TogglePattern.ToggleStateProperty);
                if (ts is ToggleState) states.Add((ToggleState)ts == ToggleState.On ? "checked" : (ToggleState)ts == ToggleState.Indeterminate ? "mixed" : "unchecked");
                actions.Add("toggle");
            }
            if (CachedBool(e, AutomationElement.IsSelectionItemPatternAvailableProperty))
            {
                if (CachedBool(e, SelectionItemPattern.IsSelectedProperty)) states.Add("selected");
                actions.Add("select");
            }
            if (CachedBool(e, AutomationElement.IsExpandCollapsePatternAvailableProperty))
            {
                var es = Cached(e, ExpandCollapsePattern.ExpandCollapseStateProperty);
                if (es is ExpandCollapseState)
                {
                    var s = (ExpandCollapseState)es;
                    if (s == ExpandCollapseState.Expanded || s == ExpandCollapseState.PartiallyExpanded) states.Add("expanded");
                    else if (s == ExpandCollapseState.Collapsed) states.Add("collapsed");
                }
                actions.Add("expand"); actions.Add("collapse");
            }
            if (CachedBool(e, AutomationElement.IsScrollPatternAvailableProperty)) actions.Add("scroll");
            if (CachedBool(e, AutomationElement.IsScrollItemPatternAvailableProperty) && !actions.Contains("scroll")) actions.Add("scroll");

            var rect = Cached(e, AutomationElement.BoundingRectangleProperty);
            if (rect is Rect)
            {
                var r = (Rect)rect;
                if (!r.IsEmpty && r.Width > 0 && r.Height > 0)
                {
                    // Any element with bounds can still be clicked through the pointer fallback.
                    n["bounds"] = new[] { (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height };
                }
            }
            if (states.Count > 0) n["states"] = states;
            if (actions.Count > 0) n["actions"] = actions;
            return n;
        }

        static string FocusedRef(int hwnd)
        {
            try
            {
                var f = AutomationElement.FocusedElement;
                if (f == null) return null;
                var key = string.Join(".", Array.ConvertAll(f.GetRuntimeId(), x => x.ToString()));
                string r;
                return RefByRuntimeId.TryGetValue(key, out r) ? r : null;
            }
            catch { return null; }
        }

        static string RoleOf(ControlType ct)
        {
            if (ct == null) return "unknown";
            if (ct == ControlType.Button || ct == ControlType.SplitButton) return "button";
            if (ct == ControlType.CheckBox) return "checkbox";
            if (ct == ControlType.ComboBox) return "combobox";
            if (ct == ControlType.Edit) return "textbox";
            if (ct == ControlType.Document) return "document";
            if (ct == ControlType.Hyperlink) return "link";
            if (ct == ControlType.Image) return "image";
            if (ct == ControlType.List) return "list";
            if (ct == ControlType.ListItem) return "listitem";
            if (ct == ControlType.Menu) return "menu";
            if (ct == ControlType.MenuBar) return "menubar";
            if (ct == ControlType.MenuItem) return "menuitem";
            if (ct == ControlType.ProgressBar) return "progressbar";
            if (ct == ControlType.RadioButton) return "radio";
            if (ct == ControlType.ScrollBar) return "scrollbar";
            if (ct == ControlType.Slider) return "slider";
            if (ct == ControlType.Spinner) return "spinbutton";
            if (ct == ControlType.StatusBar) return "statusbar";
            if (ct == ControlType.Tab) return "tablist";
            if (ct == ControlType.TabItem) return "tab";
            if (ct == ControlType.Text) return "text";
            if (ct == ControlType.ToolBar) return "toolbar";
            if (ct == ControlType.ToolTip) return "tooltip";
            if (ct == ControlType.Tree) return "tree";
            if (ct == ControlType.TreeItem) return "treeitem";
            if (ct == ControlType.Group) return "group";
            if (ct == ControlType.Pane) return "pane";
            if (ct == ControlType.Window) return "window";
            if (ct == ControlType.Table) return "table";
            if (ct == ControlType.DataGrid) return "grid";
            if (ct == ControlType.DataItem) return "row";
            if (ct == ControlType.Header) return "header";
            if (ct == ControlType.HeaderItem) return "columnheader";
            if (ct == ControlType.TitleBar) return "titlebar";
            if (ct == ControlType.Calendar) return "calendar";
            if (ct == ControlType.Separator) return "separator";
            if (ct == ControlType.Thumb) return "thumb";
            return "custom";
        }

        // ---------- actions ----------

        static RefEntry Resolve(string r)
        {
            RefEntry entry;
            if (string.IsNullOrEmpty(r) || !Refs.TryGetValue(r, out entry)) throw new DriverError("unknown_ref", "Unknown ref " + r + "; observe the window again");
            if (Alive(entry.Element)) return entry;
            // The element went away (re-render, virtualised list). Find it again by what identified it.
            if (!IsWindow(new IntPtr(entry.Hwnd))) throw new DriverError("window_gone", "The window of " + r + " no longer exists");
            var root = AutomationElement.FromHandle(new IntPtr(entry.Hwnd));
            Condition cond = null;
            var type = entry.ControlTypeId != 0 ? ControlType.LookupById(entry.ControlTypeId) : null;
            if (!string.IsNullOrEmpty(entry.AutomationId))
                cond = new PropertyCondition(AutomationElement.AutomationIdProperty, entry.AutomationId);
            else if (!string.IsNullOrEmpty(entry.Name))
                cond = new PropertyCondition(AutomationElement.NameProperty, entry.Name);
            if (cond != null && type != null) cond = new AndCondition(cond, new PropertyCondition(AutomationElement.ControlTypeProperty, type));
            if (cond != null)
            {
                var found = root.FindAll(TreeScope.Descendants, cond);
                if (found.Count == 1)
                {
                    entry.Element = found[0];
                    return entry;
                }
                if (found.Count > 1) throw new DriverError("stale_ref", r + " changed and " + found.Count + " elements now match it; observe again");
            }
            throw new DriverError("stale_ref", r + " no longer exists; observe again");
        }

        static bool Alive(AutomationElement e)
        {
            try { var x = e.Current.ProcessId; return true; } catch { return false; }
        }

        static object Pattern(AutomationElement e, AutomationPattern p)
        {
            object o; return e.TryGetCurrentPattern(p, out o) ? o : null;
        }

        static object Act(string r, string op, string value)
        {
            var entry = Resolve(r);
            var e = entry.Element;
            switch (op)
            {
                case "click":
                {
                    var inv = Pattern(e, InvokePattern.Pattern) as InvokePattern;
                    if (inv != null) { inv.Invoke(); return Ok("invoke"); }
                    var tg = Pattern(e, TogglePattern.Pattern) as TogglePattern;
                    if (tg != null) { tg.Toggle(); return Ok("toggle"); }
                    var si = Pattern(e, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (si != null) { si.Select(); return Ok("select"); }
                    var ec = Pattern(e, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    if (ec != null)
                    {
                        if (ec.Current.ExpandCollapseState == ExpandCollapseState.Expanded) ec.Collapse(); else ec.Expand();
                        return Ok("expand_collapse");
                    }
                    return PointerClick(entry, 1, false);
                }
                case "double_click": return PointerClick(entry, 2, false);
                case "right_click": return PointerClick(entry, 1, true);
                case "focus": e.SetFocus(); return Ok("focus");
                case "toggle":
                {
                    var tg = Pattern(e, TogglePattern.Pattern) as TogglePattern;
                    if (tg == null) throw new DriverError("unsupported", r + " cannot be toggled");
                    tg.Toggle(); return Ok("toggle");
                }
                case "select":
                {
                    if (!string.IsNullOrEmpty(value)) return SelectOption(entry, value);
                    var si = Pattern(e, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (si == null) throw new DriverError("unsupported", r + " cannot be selected");
                    si.Select(); return Ok("select");
                }
                case "expand":
                case "collapse":
                {
                    var ec = Pattern(e, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    if (ec == null) throw new DriverError("unsupported", r + " cannot " + op);
                    if (op == "expand") ec.Expand(); else ec.Collapse();
                    return Ok("expand_collapse");
                }
                case "set_value":
                case "clear":
                {
                    var text = op == "clear" ? "" : (value ?? "");
                    var rv = Pattern(e, RangeValuePattern.Pattern) as RangeValuePattern;
                    if (rv != null && op == "set_value")
                    {
                        double d;
                        if (!double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out d))
                            throw new DriverError("bad_params", "value must be a number for " + r);
                        rv.SetValue(d); return Ok("range_value");
                    }
                    var vp = Pattern(e, ValuePattern.Pattern) as ValuePattern;
                    if (vp != null && !vp.Current.IsReadOnly) { vp.SetValue(text); return Ok("value"); }
                    // No value pattern (rich edits, Win11 Notepad): select everything and type over it.
                    FocusFor(entry);
                    SendCombo("ctrl+a");
                    if (text.Length == 0) SendCombo("delete"); else SendUnicode(text);
                    return Ok("synthetic");
                }
                case "type":
                {
                    FocusFor(entry);
                    SendUnicode(value ?? "");
                    return Ok("synthetic");
                }
                case "scroll": return Scroll(entry, (value ?? "down").ToLowerInvariant());
                default: throw new DriverError("unsupported", "Unknown op " + op);
            }
        }

        static object SelectOption(RefEntry entry, string value)
        {
            var e = entry.Element;
            var ec = Pattern(e, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            if (ec != null) { try { ec.Expand(); Thread.Sleep(120); } catch { } }
            var match = e.FindFirst(TreeScope.Descendants, new AndCondition(
                new PropertyCondition(AutomationElement.NameProperty, value),
                new PropertyCondition(AutomationElement.IsSelectionItemPatternAvailableProperty, true)));
            if (match == null)
            {
                if (ec != null) { try { ec.Collapse(); } catch { } }
                throw new DriverError("not_found", "No option named \"" + value + "\" in " + "this control");
            }
            ((SelectionItemPattern)match.GetCurrentPattern(SelectionItemPattern.Pattern)).Select();
            if (ec != null) { try { ec.Collapse(); } catch { } }
            return Ok("select");
        }

        static object Scroll(RefEntry entry, string dir)
        {
            var e = entry.Element;
            if (dir == "into_view")
            {
                var sip = Pattern(e, ScrollItemPattern.Pattern) as ScrollItemPattern;
                if (sip == null) throw new DriverError("unsupported", "Cannot scroll this element into view");
                sip.ScrollIntoView(); return Ok("scroll_item");
            }
            // Use the element itself or the nearest scrollable ancestor.
            var walker = TreeWalker.ControlViewWalker;
            var cur = e;
            ScrollPattern sp = null;
            for (int i = 0; cur != null && i < 30; i++)
            {
                sp = Pattern(cur, ScrollPattern.Pattern) as ScrollPattern;
                if (sp != null) break;
                cur = walker.GetParent(cur);
            }
            if (sp == null) throw new DriverError("unsupported", "Nothing scrollable here");
            var none = ScrollAmount.NoAmount;
            switch (dir)
            {
                case "up": sp.Scroll(none, ScrollAmount.LargeDecrement); break;
                case "down": sp.Scroll(none, ScrollAmount.LargeIncrement); break;
                case "left": sp.Scroll(ScrollAmount.LargeDecrement, none); break;
                case "right": sp.Scroll(ScrollAmount.LargeIncrement, none); break;
                default: throw new DriverError("bad_params", "scroll value must be up, down, left, right or into_view");
            }
            return Ok("scroll");
        }

        static void FocusFor(RefEntry entry)
        {
            Activate(entry.Hwnd);
            try { entry.Element.SetFocus(); } catch { }
            Thread.Sleep(40);
        }

        static object PointerClick(RefEntry entry, int count, bool right)
        {
            Rect r;
            try { r = entry.Element.Current.BoundingRectangle; } catch { throw new DriverError("stale_ref", "Element is gone"); }
            if (r.IsEmpty || r.Width <= 0) throw new DriverError("unsupported", "Element has no on-screen position to click");
            Activate(entry.Hwnd);
            int x = (int)(r.X + r.Width / 2), y = (int)(r.Y + r.Height / 2);
            POINT old; GetCursorPos(out old);
            SetCursorPos(x, y);
            uint down = right ? 0x0008u : 0x0002u, up = right ? 0x0010u : 0x0004u;
            for (int i = 0; i < count; i++)
            {
                mouse_event(down, 0, 0, 0, UIntPtr.Zero);
                mouse_event(up, 0, 0, 0, UIntPtr.Zero);
                Thread.Sleep(40);
            }
            SetCursorPos(old.X, old.Y); // put the user's pointer back
            return Ok("synthetic");
        }

        // ---------- keyboard ----------

        static object Keys(string combo, int? hwnd)
        {
            if (string.IsNullOrEmpty(combo)) throw new DriverError("bad_params", "keys is required");
            if (hwnd.HasValue) Activate(hwnd.Value);
            foreach (var part in combo.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) { SendCombo(part); Thread.Sleep(30); }
            return Ok("synthetic");
        }

        static object TypeText(string text, int? hwnd)
        {
            if (hwnd.HasValue) Activate(hwnd.Value);
            SendUnicode(text ?? "");
            return Ok("synthetic");
        }

        static readonly Dictionary<string, ushort> KeyCodes = BuildKeyCodes();

        static Dictionary<string, ushort> BuildKeyCodes()
        {
            var k = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase);
            k["ctrl"] = 0x11; k["control"] = 0x11; k["shift"] = 0x10; k["alt"] = 0x12; k["win"] = 0x5B; k["meta"] = 0x5B; k["cmd"] = 0x11;
            k["enter"] = 0x0D; k["return"] = 0x0D; k["tab"] = 0x09; k["esc"] = 0x1B; k["escape"] = 0x1B; k["space"] = 0x20;
            k["backspace"] = 0x08; k["delete"] = 0x2E; k["del"] = 0x2E; k["insert"] = 0x2D; k["home"] = 0x24; k["end"] = 0x23;
            k["pageup"] = 0x21; k["pagedown"] = 0x22; k["up"] = 0x26; k["down"] = 0x28; k["left"] = 0x25; k["right"] = 0x27;
            k["menu"] = 0x5D; k["apps"] = 0x5D;
            for (int i = 1; i <= 24; i++) k["f" + i] = (ushort)(0x70 + i - 1);
            for (char c = 'a'; c <= 'z'; c++) k[c.ToString()] = (ushort)char.ToUpperInvariant(c);
            for (char c = '0'; c <= '9'; c++) k[c.ToString()] = (ushort)c;
            k["-"] = 0xBD; k["="] = 0xBB; k[","] = 0xBC; k["."] = 0xBE; k["/"] = 0xBF; k[";"] = 0xBA; k["'"] = 0xDE;
            k["["] = 0xDB; k["]"] = 0xDD; k["\\"] = 0xDC; k["`"] = 0xC0;
            return k;
        }

        static void SendCombo(string combo)
        {
            var parts = combo.Split('+');
            var codes = new List<ushort>();
            foreach (var raw in parts)
            {
                var p = raw.Trim();
                if (p.Length == 0) continue;
                ushort code;
                if (!KeyCodes.TryGetValue(p, out code)) throw new DriverError("bad_params", "Unknown key \"" + p + "\"");
                codes.Add(code);
            }
            var inputs = new List<INPUT>();
            foreach (var c in codes) inputs.Add(KeyInput(c, '\0', false));
            for (int i = codes.Count - 1; i >= 0; i--) inputs.Add(KeyInput(codes[i], '\0', true));
            Send(inputs);
        }

        static void SendUnicode(string text)
        {
            var inputs = new List<INPUT>();
            foreach (var ch in text)
            {
                if (ch == '\n') { inputs.Add(KeyInput(0x0D, '\0', false)); inputs.Add(KeyInput(0x0D, '\0', true)); continue; }
                if (ch == '\r') continue;
                inputs.Add(KeyInput(0, ch, false, true));
                inputs.Add(KeyInput(0, ch, true, true));
            }
            // Large batches overflow some apps' input queues; send in chunks.
            for (int i = 0; i < inputs.Count; i += 200) { Send(inputs.GetRange(i, Math.Min(200, inputs.Count - i))); Thread.Sleep(10); }
        }

        static INPUT KeyInput(ushort vk, char ch, bool up, bool unicode = false)
        {
            var i = new INPUT();
            i.type = 1;
            i.u.ki.wVk = unicode ? (ushort)0 : vk;
            i.u.ki.wScan = unicode ? ch : (ushort)0;
            uint flags = 0;
            if (unicode) flags |= 0x0004; // KEYEVENTF_UNICODE
            if (up) flags |= 0x0002;      // KEYEVENTF_KEYUP
            if (!unicode && IsExtended(vk)) flags |= 0x0001;
            i.u.ki.dwFlags = flags;
            return i;
        }

        static bool IsExtended(ushort vk)
        {
            return vk == 0x2E || vk == 0x2D || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || (vk >= 0x25 && vk <= 0x28);
        }

        static void Send(List<INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            var arr = inputs.ToArray();
            var sent = SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
            if (sent != arr.Length) throw new DriverError("input_blocked", "Windows rejected synthetic input (a higher-privilege window may be in front)");
        }

        // ---------- Win32 ----------

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public InputUnion u; }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    }
}
