#!/usr/bin/env python3
"""Prometheus Computer Use driver for Linux (AT-SPI2).

Protocol: JSON-RPC 2.0, one JSON object per line on stdin/stdout, same methods as the other drivers.
Actions use the accessibility interfaces (Action, EditableText, Value, Selection, Component), so
they work on background windows without moving the pointer. Needs python3-gi and gir1.2-atspi-2.0
(preinstalled on GNOME desktops).
"""
import json
import os
import shlex
import shutil
import subprocess
import sys
import time

VERSION = "0.1.0"

try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib, Gio
except Exception as e:  # noqa: BLE001
    sys.stderr.write("需要 python3-gi 和 gir1.2-atspi-2.0（Debian/Ubuntu: sudo apt install python3-gi gir1.2-atspi-2.0 at-spi2-core）：%s\n" % e)
    sys.exit(70)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass


class DriverError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def reply(rid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": rid}
    if error is not None:
        msg["error"] = {"code": -32000, "message": error.message, "data": {"code": error.code}}
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# ---------- a11y bus ----------

def enable_a11y_status():
    """Toolkits such as Chromium/Electron only build their tree once a client says accessibility is on."""
    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        bus.call_sync(
            "org.a11y.Bus", "/org/a11y/bus", "org.freedesktop.DBus.Properties", "Set",
            GLib.Variant("(ssv)", ("org.a11y.Status", "IsEnabled", GLib.Variant("b", True))),
            None, Gio.DBusCallFlags.NONE, 1500, None,
        )
    except Exception:  # noqa: BLE001
        pass


Atspi.init()
enable_a11y_status()
DESKTOP = Atspi.get_desktop(0)


# ---------- helpers ----------

def safe(fn, default=None):
    try:
        v = fn()
        return default if v is None else v
    except Exception:  # noqa: BLE001
        return default


def has_state(acc, st):
    try:
        return acc.get_state_set().contains(st)
    except Exception:  # noqa: BLE001
        return False


def children(acc):
    out = []
    n = safe(acc.get_child_count, 0)
    for i in range(n):
        c = safe(lambda: acc.get_child_at_index(i))
        if c is not None:
            out.append(c)
    return out


ROLES = {
    "push button": "button", "toggle button": "button", "check box": "checkbox", "check menu item": "menuitem",
    "radio button": "radio", "radio menu item": "menuitem", "entry": "textbox", "password text": "textbox",
    "label": "text", "static": "text", "heading": "text", "link": "link", "image": "image", "icon": "image",
    "panel": "group", "filler": "group", "section": "group", "viewport": "group", "form": "group", "grouping": "group",
    "scroll pane": "pane", "layered pane": "pane", "split pane": "pane", "tool bar": "toolbar", "menu bar": "menubar",
    "menu": "menu", "popup menu": "menu", "menu item": "menuitem", "tearoff menu item": "menuitem", "list": "list", "list box": "list",
    "list item": "listitem", "table": "table", "tree table": "table", "table row": "row", "table cell": "cell",
    "table column header": "columnheader", "column header": "columnheader", "table row header": "columnheader",
    "page tab list": "tablist", "page tab": "tab", "slider": "slider", "progress bar": "progressbar", "spin button": "spinbutton",
    "combo box": "combobox", "frame": "window", "window": "window", "dialog": "window", "alert": "window", "file chooser": "window",
    "application": "window", "status bar": "statusbar", "title bar": "titlebar", "tool tip": "tooltip", "separator": "separator",
    "scroll bar": "scrollbar", "tree": "tree", "tree item": "treeitem", "document frame": "document", "document web": "document",
    "document text": "document", "document email": "document", "terminal": "document", "calendar": "calendar",
    "text": "textbox",
}
DROP_FROM_WINDOWS = {"menu", "popup menu", "tool tip", "separator"}


def role_of(acc):
    name = safe(acc.get_role_name, "") or ""
    role = ROLES.get(name, "custom")
    if name == "text" and has_state(acc, Atspi.StateType.MULTI_LINE):
        role = "document"
    return name, role


# ---------- refs ----------

refs = {}      # ref -> (accessible, window_id, role, name, ident)
ref_of = {}    # accessible -> ref
next_ref = [1]


def make_ref(acc, win, role, name, ident):
    r = ref_of.get(acc)
    if r is None:
        r = "e%d" % next_ref[0]
        next_ref[0] += 1
        ref_of[acc] = r
        if len(ref_of) > 60000:
            ref_of.clear()
            refs.clear()
            ref_of[acc] = r
    refs[r] = (acc, win, role, name, ident)
    return r


# ---------- windows ----------

TOPLEVEL = {"frame", "dialog", "alert", "file chooser", "window", "page tab list", "embedded component"}
windows = {}  # id -> (accessible, pid, app name)


def win_key(acc, pid, idx):
    wid = safe(lambda: acc.get_id(), None)
    return "%d.%s" % (pid, wid if wid is not None else "i%d" % idx)


def list_windows(include_all=False):
    out = []
    cache = {}
    for ai in range(safe(DESKTOP.get_child_count, 0)):
        app = safe(lambda: DESKTOP.get_child_at_index(ai))
        if app is None:
            continue
        app_name = safe(app.get_name, "") or "?"
        pid = safe(app.get_process_id, 0)
        for wi in range(safe(app.get_child_count, 0)):
            w = safe(lambda: app.get_child_at_index(wi))
            if w is None:
                continue
            rname = safe(w.get_role_name, "") or ""
            title = safe(w.get_name, "") or ""
            if rname not in TOPLEVEL:
                continue
            if not title and not include_all:
                continue
            wid = win_key(w, pid, wi)
            cache[wid] = (w, pid, app_name)
            out.append({
                "id": wid, "pid": pid, "app": app_name, "title": title, "className": rname,
                "focused": has_state(w, Atspi.StateType.ACTIVE),
                "minimized": has_state(w, Atspi.StateType.ICONIFIED),
            })
    windows.clear()
    windows.update(cache)
    return out


def window_entry(wid):
    if wid not in windows:
        list_windows(True)
    if wid not in windows:
        raise DriverError("window_gone", "The window no longer exists")
    return windows[wid]


# ---------- tree ----------

def action_names(acc):
    names = []
    try:
        for i in range(Atspi.Action.get_n_actions(acc)):
            names.append((Atspi.Action.get_action_name(acc, i) or "").lower())
    except Exception:  # noqa: BLE001
        pass
    return names


def extents(acc):
    try:
        r = Atspi.Component.get_extents(acc, Atspi.CoordType.SCREEN)
        if r is not None and r.width > 0 and r.height > 0:
            return [r.x, r.y, r.width, r.height]
    except Exception:  # noqa: BLE001
        pass
    return None


def describe(acc, win):
    rname, role = role_of(acc)
    n = {"role": role}
    name = safe(acc.get_name, "") or ""
    if not name and role in ("text",):
        name = safe(lambda: Atspi.Text.get_text(acc, 0, min(400, Atspi.Text.get_character_count(acc))), "") or ""
    if name:
        n["name"] = name[:400]
    desc = safe(acc.get_description, "")
    if desc:
        n["description"] = desc
    attrs = safe(acc.get_attributes, {}) or {}
    ident = attrs.get("id")
    if ident:
        n["id"] = ident
    n["className"] = rname

    states, actions = [], []
    secret = rname == "password text"
    if secret:
        states.append("password")
    if not has_state(acc, Atspi.StateType.ENABLED) and not has_state(acc, Atspi.StateType.SENSITIVE):
        states.append("disabled")
    if has_state(acc, Atspi.StateType.FOCUSED):
        states.append("focused")
    if has_state(acc, Atspi.StateType.SELECTED):
        states.append("selected")
    if has_state(acc, Atspi.StateType.CHECKED):
        states.append("checked")
    elif role in ("checkbox",) or rname in ("toggle button", "check menu item"):
        states.append("mixed" if has_state(acc, Atspi.StateType.INDETERMINATE) else "unchecked")
    if has_state(acc, Atspi.StateType.EXPANDABLE):
        states.append("expanded" if has_state(acc, Atspi.StateType.EXPANDED) else "collapsed")
        actions += ["expand", "collapse"]
    if not has_state(acc, Atspi.StateType.SHOWING):
        states.append("offscreen")

    editable = has_state(acc, Atspi.StateType.EDITABLE)
    if editable:
        states.append("editable")
        actions += ["set_value", "type", "clear"]
    if role in ("textbox", "document") and not secret:
        txt = safe(lambda: Atspi.Text.get_text(acc, 0, min(4000, Atspi.Text.get_character_count(acc))), "")
        if txt:
            n["value"] = txt
    if role in ("slider", "progressbar", "spinbutton"):
        v = safe(lambda: Atspi.Value.get_current_value(acc))
        if v is not None:
            n["value"] = ("%g" % v)
        if role != "progressbar":
            actions.append("set_value")
    if role == "combobox" and not editable:
        actions.append("select")

    names = action_names(acc)
    if any(a in names for a in ("click", "press", "activate", "jump", "open", "push")):
        actions.append("click")
    if "toggle" in names or rname in ("check box", "toggle button"):
        actions.append("toggle")
    if rname in ("list item", "page tab", "radio button", "table row", "table cell", "tree item", "menu item") or "select" in names:
        actions.append("select")
    if role in ("pane", "list", "table", "document") or has_state(acc, Atspi.StateType.SCROLLABLE):
        actions.append("scroll")

    b = extents(acc)
    if b:
        n["bounds"] = b
    if states:
        n["states"] = states
    if actions:
        n["actions"] = list(dict.fromkeys(actions))
    n["ref"] = make_ref(acc, win, role, name or None, ident)
    return n, rname


def walk(acc, win, depth, budget):
    budget[0] -= 1
    n, rname = describe(acc, win)
    if depth >= budget[1]:
        return n
    kids = children(acc)
    # Menus are collapsed: reach their items with scope=<ref>.
    if rname in ("menu", "menu item", "popup menu") and not has_state(acc, Atspi.StateType.EXPANDED):
        return n
    out, omitted = [], 0
    for k in kids:
        if budget[0] <= 0:
            omitted += 1
            continue
        out.append(walk(k, win, depth + 1, budget))
    if out:
        n["children"] = out
    if omitted:
        n["omitted"] = omitted
    return n


def snapshot(p):
    budget = [int(p.get("maxNodes", 4000)), int(p.get("maxDepth", 60))]
    scope = p.get("scope")
    if scope:
        acc, win, *_ = resolve(scope)
        return {"root": walk(acc, win, 0, budget), "truncated": budget[0] <= 0}
    wid = p.get("window") or ""
    acc, pid, _app = window_entry(wid)
    register_listener()
    tree = walk(acc, wid, 0, budget)
    result = {"root": tree, "truncated": budget[0] <= 0}
    focus = find_focus(acc)
    if focus is not None and focus in ref_of:
        result["focus"] = ref_of[focus]
    return result


def find_focus(acc, depth=0):
    if depth > 40:
        return None
    if has_state(acc, Atspi.StateType.FOCUSED):
        return acc
    for k in children(acc):
        f = find_focus(k, depth + 1)
        if f is not None:
            return f
    return None


# ---------- refs ----------

def resolve(ref):
    ent = refs.get(ref)
    if ent is None:
        raise DriverError("unknown_ref", "Unknown ref %s; observe the window again" % ref)
    acc = ent[0]
    try:
        acc.get_role()
        if safe(acc.get_name, None) is None and safe(acc.get_child_count, -1) == -1:
            raise RuntimeError("dead")
        return ent
    except Exception:  # noqa: BLE001
        found = refind(ent)
        if found is None:
            raise DriverError("stale_ref", "%s no longer exists; observe again" % ref)
        refs[ref] = found
        return found


def refind(ent):
    _acc, win, role, name, ident = ent
    try:
        root = window_entry(win)[0]
    except DriverError:
        return None
    matches = []

    def scan(a, depth):
        if depth > 40 or len(matches) > 1:
            return
        _rn, r = role_of(a)
        if r == role:
            attrs = safe(a.get_attributes, {}) or {}
            if ident and attrs.get("id") == ident:
                matches.append(a)
            elif not ident and name and (safe(a.get_name, "") or "") == name:
                matches.append(a)
        for k in children(a):
            scan(k, depth + 1)

    scan(root, 0)
    if len(matches) != 1:
        return None
    return (matches[0], win, role, name, ident)


# ---------- events (settle) ----------

state = {"listener": None, "count": 0, "last": time.time(), "ok": False}


def on_event(_event):
    state["count"] += 1
    state["last"] = time.time()


def register_listener():
    if state["listener"] is not None:
        return
    try:
        lst = Atspi.EventListener.new(on_event)
        for t in ("object:children-changed", "object:text-changed", "object:state-changed", "object:property-change",
                  "object:visible-data-changed", "object:selection-changed", "window:create", "window:destroy",
                  "window:activate", "object:active-descendant-changed"):
            lst.register(t)
        state["listener"] = lst
        state["ok"] = True
    except Exception:  # noqa: BLE001
        state["listener"] = False


def pump(seconds):
    ctx = GLib.MainContext.default()
    end = time.time() + seconds
    while True:
        while ctx.iteration(False):
            pass
        if time.time() >= end:
            return
        time.sleep(0.01)


def settle(p):
    window_entry(p.get("window") or "")
    register_listener()
    quiet = int(p.get("quietMs", 250)) / 1000.0
    limit = int(p.get("timeoutMs", 3000)) / 1000.0
    start, c0 = time.time(), state["count"]
    while True:
        pump(0.03)
        since, elapsed = time.time() - state["last"], time.time() - start
        if since >= quiet and elapsed >= min(quiet, 0.15):
            return {"settled": True, "events": state["count"] - c0, "elapsedMs": int(elapsed * 1000)}
        if elapsed >= limit:
            return {"settled": False, "events": state["count"] - c0, "elapsedMs": int(elapsed * 1000)}


# ---------- input ----------

KEYSYMS = {
    "enter": 0xFF0D, "return": 0xFF0D, "tab": 0xFF09, "esc": 0xFF1B, "escape": 0xFF1B, "backspace": 0xFF08, "delete": 0xFFFF,
    "del": 0xFFFF, "home": 0xFF50, "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54, "pageup": 0xFF55,
    "pagedown": 0xFF56, "end": 0xFF57, "space": 0x20, "insert": 0xFF63, "menu": 0xFF67,
}
for _i in range(1, 13):
    KEYSYMS["f%d" % _i] = 0xFFBE + _i - 1
MODS = {"ctrl": 0xFFE3, "control": 0xFFE3, "shift": 0xFFE1, "alt": 0xFFE9, "option": 0xFFE9, "super": 0xFFEB, "win": 0xFFEB, "meta": 0xFFEB, "cmd": 0xFFE3}


def wayland():
    return os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" and not os.environ.get("DISPLAY")


def send_combo(combo):
    if wayland():
        raise DriverError("input_blocked", "Wayland 不允许合成按键；请改用 computer_act 的元素操作，或在 X11 会话中运行")
    mods, key = [], None
    for part in [x.strip().lower() for x in combo.split("+") if x.strip()]:
        if part in MODS:
            mods.append(MODS[part])
        elif part in KEYSYMS:
            key = KEYSYMS[part]
        elif len(part) == 1:
            key = ord(part)
        else:
            raise DriverError("bad_params", 'Unknown key "%s"' % part)
    if key is None:
        raise DriverError("bad_params", 'No key in "%s"' % combo)
    for m in mods:
        Atspi.generate_keyboard_event(m, None, Atspi.KeySynthType.PRESS)
    Atspi.generate_keyboard_event(key, None, Atspi.KeySynthType.PRESSRELEASE)
    for m in reversed(mods):
        Atspi.generate_keyboard_event(m, None, Atspi.KeySynthType.RELEASE)


def send_text(text):
    if wayland():
        raise DriverError("input_blocked", "Wayland 不允许合成输入；请改用 set_value / type 元素操作")
    for line_i, line in enumerate(text.split("\n")):
        if line_i:
            send_combo("return")
        if line:
            Atspi.generate_keyboard_event(0, line.replace("\r", ""), Atspi.KeySynthType.STRING)


def focus_window(wid):
    acc = window_entry(wid)[0]
    safe(lambda: Atspi.Component.grab_focus(acc))
    if shutil.which("wmctrl"):
        title = safe(acc.get_name, "")
        if title:
            subprocess.run(["wmctrl", "-a", title], check=False, capture_output=True)
    time.sleep(0.1)


def ok(how):
    return {"ok": True, "method": how}


# ---------- actions ----------

CLICK_NAMES = ("click", "press", "activate", "jump", "open", "push", "toggle")


def do_named(acc, names):
    try:
        for i in range(Atspi.Action.get_n_actions(acc)):
            if (Atspi.Action.get_action_name(acc, i) or "").lower() in names:
                return bool(Atspi.Action.do_action(acc, i))
    except Exception:  # noqa: BLE001
        pass
    return False


def pointer_click(acc, button="b1c", count=1):
    b = extents(acc)
    if not b:
        raise DriverError("unsupported", "Element has no on-screen position to click")
    if wayland():
        raise DriverError("input_blocked", "Wayland 不允许合成指针事件")
    x, y = b[0] + b[2] // 2, b[1] + b[3] // 2
    for _ in range(count):
        Atspi.generate_mouse_event(x, y, button)
        time.sleep(0.04)
    return ok("synthetic")


def act(p):
    op, value = p.get("op"), p.get("value")
    ref = p.get("ref") or ""
    acc, win, role, _name, _ident = resolve(ref)
    register_listener()
    pump(0.0)  # drain old events so settle only sees what this action causes
    state["last"] = time.time()
    rname = safe(acc.get_role_name, "")

    if op == "click":
        if do_named(acc, CLICK_NAMES):
            return ok("action")
        if rname in ("list item", "table row", "tree item", "page tab"):
            parent = safe(acc.get_parent)
            if parent is not None and safe(lambda: Atspi.Selection.select_child(parent, acc.get_index_in_parent())):
                return ok("select")
        if safe(lambda: Atspi.Component.grab_focus(acc)) and role in ("textbox", "document"):
            return ok("focus")
        return pointer_click(acc)
    if op == "double_click":
        return pointer_click(acc, "b1d")
    if op == "right_click":
        return pointer_click(acc, "b3c")
    if op == "focus":
        if safe(lambda: Atspi.Component.grab_focus(acc)):
            return ok("focus")
        raise DriverError("unsupported", "%s cannot take focus" % ref)
    if op == "toggle":
        if do_named(acc, ("toggle", "click", "press", "activate")):
            return ok("action")
        raise DriverError("unsupported", "Cannot toggle this element")
    if op == "select":
        if value:
            do_named(acc, CLICK_NAMES + ("expand or contract",))
            for _ in range(8):
                pump(0.12)
                found = find_named_child(acc, value)
                if found is not None:
                    if do_named(found, CLICK_NAMES) or pointer_click(found):
                        return ok("action")
            raise DriverError("not_found", 'No option named "%s" in this control' % value)
        parent = safe(acc.get_parent)
        if parent is not None and safe(lambda: Atspi.Selection.select_child(parent, acc.get_index_in_parent())):
            return ok("select")
        if do_named(acc, CLICK_NAMES):
            return ok("action")
        raise DriverError("unsupported", "Cannot select this element")
    if op in ("expand", "collapse"):
        want = op == "expand"
        cur = has_state(acc, Atspi.StateType.EXPANDED)
        if cur != want:
            if not do_named(acc, ("expand or contract", "expand", "collapse", "click", "activate", "press")):
                raise DriverError("unsupported", "Cannot %s this element" % op)
        return ok("action")
    if op in ("set_value", "clear"):
        text = "" if op == "clear" else (value or "")
        if role in ("slider", "spinbutton"):
            try:
                Atspi.Value.set_current_value(acc, float(text))
                return ok("value")
            except ValueError:
                raise DriverError("bad_params", "value must be a number")
        if has_state(acc, Atspi.StateType.EDITABLE) and safe(lambda: Atspi.EditableText.set_text_contents(acc, text)):
            return ok("value")
        raise DriverError("unsupported", "Cannot set a value here")
    if op == "type":
        text = value or ""
        safe(lambda: Atspi.Component.grab_focus(acc))
        if has_state(acc, Atspi.StateType.EDITABLE):
            pos = safe(lambda: Atspi.Text.get_caret_offset(acc), -1)
            if pos is None or pos < 0:
                pos = safe(lambda: Atspi.Text.get_character_count(acc), 0)
            if safe(lambda: Atspi.EditableText.insert_text(acc, pos, text, len(text.encode("utf-8")))):
                safe(lambda: Atspi.Text.set_caret_offset(acc, pos + len(text)))
                return ok("insert")
        send_text(text)
        return ok("synthetic")
    if op == "scroll":
        d = (value or "down").lower()
        if d == "into_view":
            if safe(lambda: Atspi.Component.scroll_to(acc, Atspi.ScrollType.ANYWHERE)):
                return ok("scroll_to")
            raise DriverError("unsupported", "Cannot scroll this element into view")
        b = extents(acc)
        if not b or wayland():
            raise DriverError("unsupported", "Nothing scrollable here")
        Atspi.generate_mouse_event(b[0] + b[2] // 2, b[1] + b[3] // 2, "abs")
        btn = {"up": "b4c", "down": "b5c", "left": "b6c", "right": "b7c"}.get(d)
        if not btn:
            raise DriverError("bad_params", "scroll value must be up, down, left, right or into_view")
        for _ in range(5):
            Atspi.generate_mouse_event(b[0] + b[2] // 2, b[1] + b[3] // 2, btn)
        return ok("synthetic")
    raise DriverError("unsupported", "Unknown op %s" % op)


def find_named_child(acc, title, depth=0):
    if depth > 4:
        return None
    for k in children(acc):
        if (safe(k.get_name, "") or "") == title and action_names(k):
            return k
        f = find_named_child(k, title, depth + 1)
        if f is not None:
            return f
    return None


# ---------- misc methods ----------

def launch(p):
    target = (p.get("target") or "").strip()
    if not target:
        raise DriverError("bad_params", "target is required")
    extra = shlex.split(p.get("args") or "")
    first = shlex.split(target)[0]
    if shutil.which(first):
        argv = shlex.split(target) + extra
    elif os.path.exists(os.path.expanduser(target)) or "://" in target:
        argv = ["xdg-open", os.path.expanduser(target)]
    elif shutil.which("gtk-launch"):
        argv = ["gtk-launch", target] + extra
    else:
        raise DriverError("not_found", "Cannot find %s" % target)
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    return {"ok": True, "pid": proc.pid}


def hello():
    ok_bus = True
    try:
        DESKTOP.get_child_count()
    except Exception:  # noqa: BLE001
        ok_bus = False
    caps = ["tree", "semantic_actions", "background_actions", "settle_events"]
    if not wayland():
        caps.append("synthetic_input")
    return {
        "platform": "linux", "version": VERSION, "os": " ".join(os.uname()[:1] + os.uname()[2:3]), "pid": os.getpid(),
        "capabilities": caps,
        "permissions": {
            "accessibility": "granted" if ok_bus else "denied",
            "session": os.environ.get("XDG_SESSION_TYPE", "unknown"),
            "synthetic_input": "unavailable (Wayland)" if wayland() else "available",
        },
    }


def dispatch(method, p):
    if method == "hello":
        return hello()
    if method == "windows.list":
        return list_windows(bool(p.get("all")))
    if method == "window.activate":
        focus_window(p.get("window") or "")
        return ok("activate")
    if method == "apps.launch":
        return launch(p)
    if method == "tree.snapshot":
        return snapshot(p)
    if method == "node.act":
        return act(p)
    if method == "input.keys":
        if p.get("window"):
            focus_window(p["window"])
        for part in (p.get("keys") or "").split():
            send_combo(part)
            time.sleep(0.03)
        return ok("synthetic")
    if method == "input.text":
        if p.get("window"):
            focus_window(p["window"])
        send_text(p.get("text") or "")
        return ok("synthetic")
    if method == "ui.settle":
        return settle(p)
    raise DriverError("unknown_method", "Unknown method: %s" % method)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            method = req.get("method", "")
            if method == "shutdown":
                reply(rid, True)
                return
            reply(rid, dispatch(method, req.get("params") or {}))
        except DriverError as e:
            reply(rid, error=e)
        except Exception as e:  # noqa: BLE001
            reply(rid, error=DriverError("internal", "%s: %s" % (type(e).__name__, e)))


if __name__ == "__main__":
    main()
