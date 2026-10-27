// Prometheus Computer Use driver for macOS (Accessibility API).
//
// Protocol: JSON-RPC 2.0, one JSON object per line on stdin/stdout. Same methods as the Windows
// driver. Actions go through AX actions and attributes, so they work on background apps without
// moving the user's pointer or stealing focus; keys are posted straight to the target process.
//
// Build: swiftc -O driver.swift -o cu-driver   (Xcode Command Line Tools)
// Permission: System Settings > Privacy & Security > Accessibility, for the app that launched us.

import AppKit
import ApplicationServices
import Foundation

let VERSION = "0.1.0"

// ---------- JSON helpers ----------

typealias J = [String: Any]

struct DriverError: Error {
    let code: String
    let message: String
}

func writeLine(_ obj: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]),
          var s = String(data: data, encoding: .utf8) else { return }
    s += "\n"
    FileHandle.standardOutput.write(s.data(using: .utf8)!)
}

func reply(_ id: Any?, result: Any?, error: DriverError?) {
    var d: J = ["jsonrpc": "2.0", "id": id ?? NSNull()]
    if let e = error {
        d["error"] = ["code": -32000, "message": e.message, "data": ["code": e.code]] as J
    } else {
        d["result"] = result ?? NSNull()
    }
    writeLine(d)
}

func str(_ p: J, _ k: String) -> String? { p[k] as? String }
func int(_ p: J, _ k: String, _ d: Int) -> Int {
    if let n = p[k] as? NSNumber { return n.intValue }
    return d
}

// ---------- AX helpers ----------

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var v: CFTypeRef?
    let r = AXUIElementCopyAttributeValue(el, name as CFString, &v)
    return r == .success ? (v as AnyObject?) : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    if let s = axAttr(el, name) as? String, !s.isEmpty { return s }
    return nil
}

func axBool(_ el: AXUIElement, _ name: String) -> Bool? {
    if let n = axAttr(el, name) as? NSNumber { return n.boolValue }
    return nil
}

/// An attribute that holds another element, checked by type instead of force-cast.
func axElement(_ el: AXUIElement, _ name: String) -> AXUIElement? {
    guard let v = axAttr(el, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func axChildren(_ el: AXUIElement, role: String) -> [AXUIElement] {
    // Big tables and lists expose only their visible rows, which keeps snapshots fast.
    if role == "AXTable" || role == "AXOutline" || role == "AXList" {
        if let rows = axAttr(el, "AXVisibleRows") as? [AXUIElement], !rows.isEmpty { return rows }
    }
    return (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func axActions(_ el: AXUIElement) -> [String] {
    var a: CFArray?
    if AXUIElementCopyActionNames(el, &a) == .success, let arr = a as? [String] { return arr }
    return []
}

func axSettable(_ el: AXUIElement, _ name: String) -> Bool {
    var s: DarwinBoolean = false
    return AXUIElementIsAttributeSettable(el, name as CFString, &s) == .success && s.boolValue
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    var pos = CGPoint.zero
    var size = CGSize.zero
    guard let p = axAttr(el, kAXPositionAttribute), let s = axAttr(el, kAXSizeAttribute) else { return nil }
    guard AXValueGetValue(p as! AXValue, .cgPoint, &pos), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: pos, size: size)
}

func axPid(_ el: AXUIElement) -> pid_t {
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    return pid
}

typealias GetWindowFn = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
let getWindowFn: GetWindowFn? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(sym, to: GetWindowFn.self)
}()

func windowNumber(_ el: AXUIElement) -> Int? {
    guard let fn = getWindowFn else { return nil }
    var id: CGWindowID = 0
    return fn(el, &id) == .success && id != 0 ? Int(id) : nil
}

// ---------- roles ----------

func roleOf(_ role: String, _ sub: String?) -> String {
    switch role {
    case "AXButton", "AXMenuButton": return "button"
    case "AXPopUpButton", "AXComboBox": return "combobox"
    case "AXCheckBox": return "checkbox"
    case "AXRadioButton": return "radio"
    case "AXTextField", "AXSearchField": return "textbox"
    case "AXTextArea": return "document"
    case "AXStaticText": return "text"
    case "AXLink": return "link"
    case "AXImage": return "image"
    case "AXGroup", "AXLayoutArea", "AXLayoutItem", "AXMatte", "AXRadioGroup": return "group"
    case "AXScrollArea", "AXSplitGroup", "AXSplitter", "AXBrowser": return "pane"
    case "AXToolbar": return "toolbar"
    case "AXMenuBar": return "menubar"
    case "AXMenuBarItem", "AXMenuItem": return "menuitem"
    case "AXMenu": return "menu"
    case "AXList": return "list"
    case "AXTable", "AXOutline": return "table"
    case "AXRow": return "row"
    case "AXColumn": return "column"
    case "AXCell": return "cell"
    case "AXTabGroup": return "tablist"
    case "AXSlider": return "slider"
    case "AXProgressIndicator", "AXLevelIndicator", "AXBusyIndicator": return "progressbar"
    case "AXIncrementor", "AXStepper": return "spinbutton"
    case "AXDisclosureTriangle": return "button"
    case "AXWindow", "AXSheet", "AXDrawer": return "window"
    case "AXPopover": return "pane"
    case "AXScrollBar": return "scrollbar"
    case "AXValueIndicator": return "thumb"
    case "AXGrowArea", "AXRuler", "AXRulerMarker": return "separator"
    case "AXHelpTag": return "tooltip"
    case "AXWebArea": return "document"
    case "AXHeading": return "text"
    default: return "custom"
    }
}

// ---------- element registry ----------

final class Ref {
    let element: AXUIElement
    let windowId: String
    let role: String
    let title: String?
    let identifier: String?
    init(_ e: AXUIElement, _ w: String, _ r: String, _ t: String?, _ i: String?) {
        element = e; windowId = w; role = r; title = t; identifier = i
    }
}

var refs: [String: Ref] = [:]
var refByHash: [Int: [(AXUIElement, String)]] = [:]
var nextRef = 1

func refFor(_ el: AXUIElement, window: String, role: String, title: String?, identifier: String?) -> String {
    let h = Int(CFHash(el))
    if let bucket = refByHash[h] {
        for (e, r) in bucket where CFEqual(e, el) {
            refs[r] = Ref(el, window, role, title, identifier)
            return r
        }
    }
    let r = "e\(nextRef)"
    nextRef += 1
    refByHash[h, default: []].append((el, r))
    refs[r] = Ref(el, window, role, title, identifier)
    if refs.count > 60000 { refs.removeAll(); refByHash.removeAll() }
    return r
}

// ---------- apps and windows ----------

struct WinEntry {
    let id: String
    let el: AXUIElement
    let pid: pid_t
    let app: NSRunningApplication
}

var windowCache: [String: WinEntry] = [:]

func pumpRunLoop(_ seconds: Double = 0.02) {
    RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
}

func requireTrust() throws {
    if !AXIsProcessTrusted() {
        throw DriverError(code: "permission_denied",
                          message: "没有辅助功能权限。请在 系统设置 > 隐私与安全性 > 辅助功能 中允许启动本程序的应用（Prometheus 或终端），然后重试。")
    }
}

func listWindows(includeAll: Bool) throws -> [J] {
    try requireTrust()
    pumpRunLoop()
    var out: [J] = []
    var cache: [String: WinEntry] = [:]
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular && !app.isTerminated {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 1.5)
        let wins = (axAttr(ax, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        let focusedWin = axElement(ax, kAXFocusedWindowAttribute)
        for (i, w) in wins.enumerated() {
            let title = axString(w, kAXTitleAttribute) ?? ""
            if title.isEmpty && !includeAll && wins.count > 1 { continue }
            let num = windowNumber(w)
            let id = num.map { String($0) } ?? "p\(app.processIdentifier).\(i)"
            let minimized = axBool(w, kAXMinimizedAttribute) ?? false
            var focused = false
            if let f = focusedWin { focused = CFEqual(f, w) && app.processIdentifier == front }
            cache[id] = WinEntry(id: id, el: w, pid: app.processIdentifier, app: app)
            out.append([
                "id": id, "pid": Int(app.processIdentifier),
                "app": app.localizedName ?? app.bundleIdentifier ?? "?",
                "bundleId": app.bundleIdentifier ?? NSNull(),
                "title": title, "className": axString(w, kAXRoleAttribute) ?? "AXWindow",
                "focused": focused, "minimized": minimized,
            ])
        }
    }
    windowCache = cache
    return out
}

func windowEntry(_ id: String) throws -> WinEntry {
    if windowCache[id] == nil { _ = try listWindows(includeAll: true) }
    guard let w = windowCache[id] else { throw DriverError(code: "window_gone", message: "The window no longer exists") }
    return w
}

// ---------- tree ----------

var enhancedPids = Set<pid_t>()

/// Chromium and Electron build their accessibility tree only when asked.
func enableWebAccessibility(_ app: NSRunningApplication) {
    let pid = app.processIdentifier
    if enhancedPids.contains(pid) { return }
    enhancedPids.insert(pid)
    let ax = AXUIElementCreateApplication(pid)
    AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    pumpRunLoop(0.25)
}

struct Budget { var nodes: Int; let maxDepth: Int }

func describe(_ el: AXUIElement, window: String, windowFrame: CGRect?) -> (J, String, [AXUIElement]) {
    let role = axString(el, kAXRoleAttribute) ?? "AXUnknown"
    let sub = axString(el, kAXSubroleAttribute)
    var n: J = [:]
    let unified = sub == "AXSecureTextField" ? "textbox" : roleOf(role, sub)
    n["role"] = unified

    let title = axString(el, kAXTitleAttribute)
    var name = title ?? axString(el, kAXDescriptionAttribute)
    if name == nil, let ui = axElement(el, "AXTitleUIElement") {
        name = axString(ui, kAXValueAttribute)
    }
    if name == nil { name = axString(el, kAXPlaceholderValueAttribute) }
    let ident = axString(el, kAXIdentifierAttribute)
    if let i = ident { n["id"] = i }
    if let h = axString(el, kAXHelpAttribute) { n["description"] = h }
    n["className"] = sub != nil ? "\(role)/\(sub!)" : role

    var states: [String] = []
    var actions: [String] = []
    let secure = sub == "AXSecureTextField"
    if secure { states.append("password") }
    if axBool(el, kAXEnabledAttribute) == false { states.append("disabled") }
    if axBool(el, kAXFocusedAttribute) == true { states.append("focused") }
    if axBool(el, kAXSelectedAttribute) == true { states.append("selected") }

    let valueObj = axAttr(el, kAXValueAttribute)
    let textual = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"].contains(role)
    if textual {
        if axSettable(el, kAXValueAttribute) && !secure {
            states.append("editable"); actions += ["set_value", "type", "clear"]
        } else if secure && axSettable(el, kAXValueAttribute) {
            states.append("editable"); actions += ["set_value", "type", "clear"]
        }
    }
    switch role {
    case "AXCheckBox", "AXRadioButton":
        if let v = valueObj as? NSNumber { states.append(v.intValue == 1 ? "checked" : v.intValue == 2 ? "mixed" : "unchecked") }
        if role == "AXCheckBox" { actions.append("toggle") }
    case "AXSlider", "AXIncrementor", "AXStepper", "AXLevelIndicator":
        if let v = valueObj as? NSNumber { n["value"] = v.stringValue }
        if axSettable(el, kAXValueAttribute) { actions.append("set_value") }
    case "AXProgressIndicator":
        if let v = valueObj as? NSNumber { n["value"] = v.stringValue }
    case "AXPopUpButton":
        if let v = valueObj as? String { n["value"] = v }
        actions.append("select")
    case "AXStaticText":
        if name == nil, let v = valueObj as? String { name = v }
    case "AXDisclosureTriangle":
        if let v = valueObj as? NSNumber { states.append(v.intValue == 1 ? "expanded" : "collapsed") }
        actions += ["expand", "collapse"]
    default:
        if textual && !secure, let v = valueObj as? String, !v.isEmpty {
            n["value"] = v.count > 4000 ? String(v.prefix(4000)) : v
        } else if !textual, !secure, let v = valueObj as? String, !v.isEmpty, name == nil {
            n["value"] = v
        }
    }
    if let e = axBool(el, "AXExpanded") {
        states.append(e ? "expanded" : "collapsed")
        actions += ["expand", "collapse"]
    }
    if let nm = name { n["name"] = nm.count > 400 ? String(nm.prefix(400)) : nm }

    let ax = axActions(el)
    if ax.contains("AXPress") || ax.contains("AXConfirm") || ax.contains("AXPick") || ax.contains("AXOpen") { actions.append("click") }
    if role == "AXRow" || role == "AXCell" {
        if axSettable(el, kAXSelectedAttribute) { actions.append("select") }
    }
    if ax.contains("AXShowMenu") { actions.append("right_click") }
    if ax.contains("AXScrollToVisible") || role == "AXScrollArea" { actions.append("scroll") }

    var kids: [AXUIElement] = axChildren(el, role: role)
    if role == "AXMenuItem" || role == "AXMenuBarItem" {
        // Menus are collapsed by default; their items are reached with scope=<ref>.
        if !kids.isEmpty && !states.contains("expanded") { states.append("collapsed") }
    }

    if let f = axFrame(el) {
        if f.width > 0 && f.height > 0 {
            n["bounds"] = [Int(f.origin.x), Int(f.origin.y), Int(f.size.width), Int(f.size.height)]
            if let wf = windowFrame, !f.intersects(wf) { states.append("offscreen") }
        }
    }
    if !states.isEmpty { n["states"] = states }
    if !actions.isEmpty { n["actions"] = Array(NSOrderedSet(array: actions)) as! [String] }
    n["ref"] = refFor(el, window: window, role: unified, title: name, identifier: ident)
    // Collapsed menus: do not walk their children into the tree.
    if (role == "AXMenuItem" || role == "AXMenuBarItem") && !states.contains("expanded") && !kids.isEmpty {
        kids = []
    }
    return (n, role, kids)
}

func walk(_ el: AXUIElement, window: String, wf: CGRect?, depth: Int, budget: inout Budget) -> J {
    budget.nodes -= 1
    var (n, _, kids) = describe(el, window: window, windowFrame: wf)
    if depth >= budget.maxDepth || kids.isEmpty { return n }
    var out: [J] = []
    var omitted = 0
    for k in kids {
        if budget.nodes <= 0 { omitted += 1; continue }
        out.append(walk(k, window: window, wf: wf, depth: depth + 1, budget: &budget))
    }
    if !out.isEmpty { n["children"] = out }
    if omitted > 0 { n["omitted"] = omitted }
    return n
}

func snapshot(_ p: J) throws -> J {
    try requireTrust()
    let wid = str(p, "window") ?? ""
    var budget = Budget(nodes: int(p, "maxNodes", 4000), maxDepth: int(p, "maxDepth", 60))

    if let scope = str(p, "scope"), !scope.isEmpty {
        let r = try resolve(scope)
        let win = windowCache[r.windowId]
        let tree = walk(r.element, window: r.windowId, wf: win.flatMap { axFrame($0.el) }, depth: 0, budget: &budget)
        return ["root": tree, "truncated": budget.nodes <= 0]
    }

    var w = try windowEntry(wid)
    enableWebAccessibility(w.app)
    let appAX = AXUIElementCreateApplication(w.pid)
    AXUIElementSetMessagingTimeout(appAX, 1.5)
    registerObserver(pid: w.pid)
    var tree = walk(w.el, window: wid, wf: axFrame(w.el), depth: 0, budget: &budget)
    // A web app that was just asked for its tree needs a moment: look again once if the window is nearly empty.
    if (tree["children"] as? [J])?.count ?? 0 <= 3, !(w.app.bundleIdentifier ?? "").hasPrefix("com.apple.") {
        pumpRunLoop(0.3)
        w = try windowEntry(wid)
        budget = Budget(nodes: int(p, "maxNodes", 4000), maxDepth: int(p, "maxDepth", 60))
        tree = walk(w.el, window: wid, wf: axFrame(w.el), depth: 0, budget: &budget)
    }
    // The menu bar belongs to the app, not the window; add it as a sibling subtree so menus are reachable.
    if let mb = axElement(appAX, kAXMenuBarAttribute) {
        var mbBudget = Budget(nodes: 200, maxDepth: 1)
        let menu = walk(mb, window: wid, wf: nil, depth: 0, budget: &mbBudget)
        var kids = (tree["children"] as? [J]) ?? []
        kids.append(menu)
        tree["children"] = kids
    }
    var result: J = ["root": tree, "truncated": budget.nodes <= 0]
    if let f = axElement(appAX, kAXFocusedUIElementAttribute) {
        let h = Int(CFHash(f))
        if let b = refByHash[h], let m = b.first(where: { CFEqual($0.0, f) }) { result["focus"] = m.1 }
    }
    return result
}

// ---------- resolving refs ----------

func resolve(_ ref: String) throws -> Ref {
    guard let r = refs[ref] else { throw DriverError(code: "unknown_ref", message: "Unknown ref \(ref); observe the window again") }
    // Probe: a dead element answers with invalidUIElement.
    var v: CFTypeRef?
    let e = AXUIElementCopyAttributeValue(r.element, kAXRoleAttribute as CFString, &v)
    if e == .success { return r }
    if e == .invalidUIElement || e == .cannotComplete {
        if let found = try? refind(r) { refs[ref] = found; return found }
        throw DriverError(code: "stale_ref", message: "\(ref) no longer exists; observe again")
    }
    return r
}

func refind(_ r: Ref) throws -> Ref? {
    let w = try windowEntry(r.windowId)
    var matches: [AXUIElement] = []
    func scan(_ el: AXUIElement, _ depth: Int) {
        if depth > 40 || matches.count > 1 { return }
        let role = axString(el, kAXRoleAttribute) ?? ""
        let sub = axString(el, kAXSubroleAttribute)
        if roleOf(role, sub) == r.role {
            let t = axString(el, kAXTitleAttribute) ?? axString(el, kAXDescriptionAttribute)
            let id = axString(el, kAXIdentifierAttribute)
            if let rid = r.identifier, !rid.isEmpty { if id == rid { matches.append(el) } }
            else if let rt = r.title, !rt.isEmpty, t == rt { matches.append(el) }
        }
        for k in axChildren(el, role: role) { scan(k, depth + 1) }
    }
    scan(w.el, 0)
    guard matches.count == 1 else { return nil }
    return Ref(matches[0], r.windowId, r.role, r.title, r.identifier)
}

// ---------- AX observer (settle) ----------

final class ObserverBox {
    var observer: AXObserver?
    var lastEvent = Date()
    var count = 0
}
var observers: [pid_t: ObserverBox] = [:]

let observerCallback: AXObserverCallback = { _, _, _, refcon in
    guard let refcon = refcon else { return }
    let box = Unmanaged<ObserverBox>.fromOpaque(refcon).takeUnretainedValue()
    box.lastEvent = Date()
    box.count += 1
}

func registerObserver(pid: pid_t) {
    if observers[pid] != nil { return }
    let box = ObserverBox()
    var obs: AXObserver?
    guard AXObserverCreate(pid, observerCallback, &obs) == .success, let o = obs else { return }
    let app = AXUIElementCreateApplication(pid)
    let refcon = Unmanaged.passUnretained(box).toOpaque()
    for n in [kAXValueChangedNotification, kAXUIElementDestroyedNotification, kAXCreatedNotification, kAXFocusedUIElementChangedNotification,
              kAXFocusedWindowChangedNotification, kAXWindowCreatedNotification, kAXTitleChangedNotification, kAXMenuOpenedNotification,
              kAXMenuClosedNotification, kAXSelectedChildrenChangedNotification, kAXSelectedRowsChangedNotification,
              kAXRowCountChangedNotification, kAXLayoutChangedNotification, kAXSelectedTextChangedNotification, kAXWindowMovedNotification,
              kAXWindowResizedNotification, kAXApplicationActivatedNotification] {
        AXObserverAddNotification(o, app, n as CFString, refcon)
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
    box.observer = o
    observers[pid] = box
}

func settle(_ p: J) throws -> J {
    let w = try windowEntry(str(p, "window") ?? "")
    registerObserver(pid: w.pid)
    let box = observers[w.pid]!
    let quiet = Double(int(p, "quietMs", 250)) / 1000
    let limit = Double(int(p, "timeoutMs", 3000)) / 1000
    let start = Date()
    let startCount = box.count
    // Events sent before this call (the action itself) are already counted; wait for a quiet period after the last one.
    while true {
        pumpRunLoop(0.03)
        let sinceLast = Date().timeIntervalSince(box.lastEvent)
        let elapsed = Date().timeIntervalSince(start)
        if sinceLast >= quiet && elapsed >= min(quiet, 0.15) {
            return ["settled": true, "events": box.count - startCount, "elapsedMs": Int(elapsed * 1000)]
        }
        if elapsed >= limit { return ["settled": false, "events": box.count - startCount, "elapsedMs": Int(elapsed * 1000)] }
    }
}

// ---------- keyboard / mouse ----------

let keyCodes: [String: CGKeyCode] = {
    var k: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47, "`": 50,
        "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 117, "del": 117, "esc": 53, "escape": 53,
        "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]
    k["menu"] = 110
    return k
}()

func modifierFlag(_ name: String) -> CGEventFlags? {
    switch name {
    // On a Mac, "ctrl" in cross-platform habits (ctrl+s, ctrl+c) means Command. Say "control" for the real Control key.
    case "cmd", "command", "meta", "win", "super", "ctrl": return .maskCommand
    case "control": return .maskControl
    case "alt", "option", "opt": return .maskAlternate
    case "shift": return .maskShift
    case "fn": return .maskSecondaryFn
    default: return nil
    }
}

let eventSource = CGEventSource(stateID: .privateState)

func post(_ ev: CGEvent?, pid: pid_t?) {
    guard let ev = ev else { return }
    if let pid = pid { ev.postToPid(pid) } else { ev.post(tap: .cghidEventTap) }
}

func sendCombo(_ combo: String, pid: pid_t?) throws {
    var flags: CGEventFlags = []
    var key: CGKeyCode?
    for raw in combo.split(separator: "+") {
        let part = raw.trimmingCharacters(in: .whitespaces).lowercased()
        if part.isEmpty { continue }
        if let f = modifierFlag(part) { flags.insert(f); continue }
        guard let c = keyCodes[part] else { throw DriverError(code: "bad_params", message: "Unknown key \"\(part)\"") }
        key = c
    }
    guard let code = key else { throw DriverError(code: "bad_params", message: "No key in \"\(combo)\"") }
    for down in [true, false] {
        let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: code, keyDown: down)
        ev?.flags = flags
        post(ev, pid: pid)
        usleep(8000)
    }
}

func sendText(_ text: String, pid: pid_t?) throws {
    for (i, line) in text.components(separatedBy: "\n").enumerated() {
        if i > 0 { try sendCombo("return", pid: pid) }
        let units = Array(line.replacingOccurrences(of: "\r", with: "").utf16)
        var idx = 0
        while idx < units.count {
            let end = min(idx + 16, units.count)
            var chunk = Array(units[idx..<end])
            for down in [true, false] {
                let ev = CGEvent(keyboardEventSource: eventSource, virtualKey: 0, keyDown: down)
                ev?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                post(ev, pid: pid)
            }
            usleep(12000)
            idx = end
        }
    }
}

func syntheticClick(at p: CGPoint, right: Bool, count: Int) {
    let old = CGEvent(source: nil)?.location ?? p
    let btn: CGMouseButton = right ? .right : .left
    let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = right ? .rightMouseUp : .leftMouseUp
    for i in 1...max(1, count) {
        let d = CGEvent(mouseEventSource: eventSource, mouseType: down, mouseCursorPosition: p, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        d?.post(tap: .cghidEventTap)
        let u = CGEvent(mouseEventSource: eventSource, mouseType: up, mouseCursorPosition: p, mouseButton: btn)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        u?.post(tap: .cghidEventTap)
        usleep(30000)
    }
    CGWarpMouseCursorPosition(old)
}

// ---------- actions ----------

func ok(_ how: String) -> J { ["ok": true, "method": how] }

func activate(_ w: WinEntry) {
    w.app.activate(options: [.activateIgnoringOtherApps])
    AXUIElementPerformAction(w.el, kAXRaiseAction as CFString)
    if axBool(w.el, kAXMinimizedAttribute) == true { AXUIElementSetAttributeValue(w.el, kAXMinimizedAttribute as CFString, kCFBooleanFalse) }
    pumpRunLoop(0.12)
}

func press(_ el: AXUIElement) -> Bool {
    for a in ["AXPress", "AXConfirm", "AXPick", "AXOpen"] where axActions(el).contains(a) {
        let r = AXUIElementPerformAction(el, a as CFString)
        // A press that opens a menu can block until it closes; the menu did open, so treat a timeout as success.
        if r == .success || r == .cannotComplete { return true }
    }
    return false
}

func centre(_ el: AXUIElement) -> CGPoint? {
    guard let f = axFrame(el), f.width > 0 else { return nil }
    return CGPoint(x: f.midX, y: f.midY)
}

func pointerClick(_ r: Ref, count: Int, right: Bool) throws -> J {
    guard let c = centre(r.element) else { throw DriverError(code: "unsupported", message: "Element has no on-screen position to click") }
    if let w = windowCache[r.windowId] { activate(w) }
    syntheticClick(at: c, right: right, count: count)
    return ok("synthetic")
}

func findChild(_ el: AXUIElement, title: String, depth: Int = 0) -> AXUIElement? {
    if depth > 4 { return nil }
    for k in (axAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] {
        if axString(k, kAXTitleAttribute) == title, axActions(k).contains("AXPress") { return k }
        if let f = findChild(k, title: title, depth: depth + 1) { return f }
    }
    return nil
}

func act(_ p: J) throws -> J {
    try requireTrust()
    let op = str(p, "op") ?? ""
    let value = str(p, "value")
    let r = try resolve(str(p, "ref") ?? "")
    let el = r.element
    let role = axString(el, kAXRoleAttribute) ?? ""
    let w = windowCache[r.windowId]
    if let w = w { registerObserver(pid: w.pid) }

    switch op {
    case "click":
        if press(el) { return ok("press") }
        if role == "AXRow" || role == "AXCell" || axSettable(el, kAXSelectedAttribute) {
            if AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return ok("select") }
        }
        if role == "AXTextField" || role == "AXTextArea" {
            if AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success { return ok("focus") }
        }
        return try pointerClick(r, count: 1, right: false)
    case "double_click":
        if axActions(el).contains("AXOpen") { _ = AXUIElementPerformAction(el, "AXOpen" as CFString); return ok("open") }
        return try pointerClick(r, count: 2, right: false)
    case "right_click":
        if axActions(el).contains("AXShowMenu") { _ = AXUIElementPerformAction(el, "AXShowMenu" as CFString); return ok("show_menu") }
        return try pointerClick(r, count: 1, right: true)
    case "focus":
        if AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success { return ok("focus") }
        throw DriverError(code: "unsupported", message: "\(str(p, "ref") ?? "") cannot take focus")
    case "toggle":
        if press(el) { return ok("press") }
        throw DriverError(code: "unsupported", message: "Cannot toggle this element")
    case "select":
        if let v = value, !v.isEmpty {
            _ = press(el)
            for _ in 0..<8 {
                pumpRunLoop(0.12)
                if let item = findChild(el, title: v) {
                    _ = AXUIElementPerformAction(item, kAXPressAction as CFString)
                    return ok("press")
                }
            }
            throw DriverError(code: "not_found", message: "No option named \"\(v)\" in this control")
        }
        if axSettable(el, kAXSelectedAttribute), AXUIElementSetAttributeValue(el, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success { return ok("select") }
        if press(el) { return ok("press") }
        throw DriverError(code: "unsupported", message: "Cannot select this element")
    case "expand", "collapse":
        let want = op == "expand"
        if axSettable(el, "AXExpanded"), AXUIElementSetAttributeValue(el, "AXExpanded" as CFString, want as CFBoolean) == .success { return ok("expanded") }
        if role == "AXDisclosureTriangle" {
            let cur = (axAttr(el, kAXValueAttribute) as? NSNumber)?.intValue == 1
            if cur != want { _ = press(el) }
            return ok("press")
        }
        if press(el) { return ok("press") }
        throw DriverError(code: "unsupported", message: "Cannot \(op) this element")
    case "set_value", "clear":
        let text = op == "clear" ? "" : (value ?? "")
        if role == "AXSlider" || role == "AXIncrementor" || role == "AXStepper" {
            guard let d = Double(text) else { throw DriverError(code: "bad_params", message: "value must be a number") }
            if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, NSNumber(value: d)) == .success { return ok("value") }
            throw DriverError(code: "unsupported", message: "Cannot set this value")
        }
        if axSettable(el, kAXValueAttribute),
           AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, text as CFString) == .success { return ok("value") }
        // Rich editors: replace the selection after selecting everything.
        if let w = w {
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            try sendCombo("cmd+a", pid: w.pid)
            if text.isEmpty { try sendCombo("backspace", pid: w.pid) } else { try sendText(text, pid: w.pid) }
            return ok("synthetic")
        }
        throw DriverError(code: "unsupported", message: "Cannot set a value here")
    case "type":
        _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let t = value ?? ""
        // Inserting at the caret through the accessibility API works on background windows and needs no key events.
        if axSettable(el, kAXSelectedTextAttribute),
           AXUIElementSetAttributeValue(el, kAXSelectedTextAttribute as CFString, t as CFString) == .success { return ok("insert") }
        guard let w = w else { throw DriverError(code: "window_gone", message: "The window no longer exists") }
        try sendText(t, pid: w.pid)
        return ok("synthetic")
    case "scroll":
        let dir = (value ?? "down").lowercased()
        if dir == "into_view" {
            if AXUIElementPerformAction(el, "AXScrollToVisible" as CFString) == .success { return ok("scroll_to_visible") }
            throw DriverError(code: "unsupported", message: "Cannot scroll this element into view")
        }
        // Find the enclosing scroll area and nudge its scrollbar, which works without the pointer.
        var cur: AXUIElement? = el
        var depth = 0
        while let c = cur, depth < 30 {
            if axString(c, kAXRoleAttribute) == "AXScrollArea" {
                let attr = (dir == "left" || dir == "right") ? "AXHorizontalScrollBar" : "AXVerticalScrollBar"
                if let bar = axElement(c, attr), let v = (axAttr(bar, kAXValueAttribute) as? NSNumber)?.doubleValue {
                    let step = 0.25
                    let nv = (dir == "down" || dir == "right") ? min(1, v + step) : max(0, v - step)
                    if AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: nv)) == .success { return ok("scrollbar") }
                }
                break
            }
            cur = axElement(c, kAXParentAttribute)
            depth += 1
        }
        throw DriverError(code: "unsupported", message: "Nothing scrollable here")
    default:
        throw DriverError(code: "unsupported", message: "Unknown op \(op)")
    }
}

func keys(_ p: J) throws -> J {
    try requireTrust()
    var pid: pid_t?
    if let wid = str(p, "window") { pid = try windowEntry(wid).pid }
    let combo = str(p, "keys") ?? ""
    if combo.isEmpty { throw DriverError(code: "bad_params", message: "keys is required") }
    // Keys go straight to the target process: the user keeps working in their own app.
    for part in combo.split(separator: " ") { try sendCombo(String(part), pid: pid); usleep(30000) }
    return ok("synthetic")
}

func typeText(_ p: J) throws -> J {
    try requireTrust()
    var pid: pid_t?
    if let wid = str(p, "window") { pid = try windowEntry(wid).pid }
    try sendText(str(p, "text") ?? "", pid: pid)
    return ok("synthetic")
}

func launch(_ p: J) throws -> J {
    guard let target = str(p, "target"), !target.isEmpty else { throw DriverError(code: "bad_params", message: "target is required") }
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    var args = ["-g"] // do not bring it to the front
    let isPath = target.hasPrefix("/") || target.hasPrefix("~") || target.contains("://")
    if isPath { args.append(target) }
    else if target.contains(".") && !target.lowercased().hasSuffix(".app") { args += ["-b", target] }
    else { args += ["-a", target] }
    if let extra = str(p, "args"), !extra.isEmpty { args += ["--args"] + extra.split(separator: " ").map(String.init) }
    proc.arguments = args
    let errPipe = Pipe()
    proc.standardError = errPipe
    try proc.run()
    proc.waitUntilExit()
    if proc.terminationStatus != 0 {
        let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "open failed"
        throw DriverError(code: "not_found", message: msg.trimmingCharacters(in: .whitespacesAndNewlines))
    }
    return ["ok": true, "pid": NSNull()]
}

func hello() -> J {
    let trusted = AXIsProcessTrusted()
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return [
        "platform": "macos", "version": VERSION,
        "os": "macOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
        "pid": Int(getpid()),
        "capabilities": ["tree", "semantic_actions", "background_actions", "background_keys", "settle_events", "synthetic_input"],
        "permissions": ["accessibility": trusted ? "granted" : "denied"],
    ]
}

func dispatch(_ method: String, _ p: J) throws -> Any {
    switch method {
    case "hello": return hello()
    case "windows.list": return try listWindows(includeAll: (p["all"] as? Bool) ?? false)
    case "window.activate": activate(try windowEntry(str(p, "window") ?? "")); return ok("activate")
    case "apps.launch": return try launch(p)
    case "tree.snapshot": return try snapshot(p)
    case "node.act": return try act(p)
    case "input.keys": return try keys(p)
    case "input.text": return try typeText(p)
    case "ui.settle": return try settle(p)
    default: throw DriverError(code: "unknown_method", message: "Unknown method: \(method)")
    }
}

// ---------- main loop ----------

setvbuf(stdout, nil, _IOLBF, 0)
if !AXIsProcessTrusted() {
    // Shows the system prompt naming the app that launched us, once.
    _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
}
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.5)

while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    var id: Any?
    do {
        guard let data = line.data(using: .utf8), let req = try JSONSerialization.jsonObject(with: data) as? J else { continue }
        id = req["id"]
        let method = (req["method"] as? String) ?? ""
        if method == "shutdown" { reply(id, result: true, error: nil); break }
        let result = try dispatch(method, (req["params"] as? J) ?? [:])
        reply(id, result: result, error: nil)
    } catch let e as DriverError {
        reply(id, result: nil, error: e)
    } catch {
        reply(id, result: nil, error: DriverError(code: "internal", message: "\(error)"))
    }
}
