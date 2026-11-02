//! System tray: close-to-tray for the main window plus a small always-on-top panel listing running sessions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

const MAIN: &str = "main";
const PANEL: &str = "panel";
const PANEL_W: f64 = 340.0;
const PANEL_H: f64 = 440.0;
/// The right-click menu is drawn by the web app (same look as the in-app context menu), in its own small window.
/// The extra margin around the card leaves room for its shadow.
const TRAYMENU: &str = "traymenu";
const MENU_W: f64 = 216.0;
const MENU_H: f64 = 170.0;

pub struct TrayState {
    close_to_tray: AtomicBool,
    /// When the panel last lost focus; a tray click right after that must not reopen it.
    panel_blurred_at: Mutex<Option<Instant>>,
    /// Same for the menu: a right click on the icon while it is open first blurs it, which already closed it.
    menu_blurred_at: Mutex<Option<Instant>>,
    /// Where the tray was last clicked, so the work panel opens next to the icon even when chosen from the menu.
    last_anchor: Mutex<Option<PhysicalPosition<f64>>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            panel_blurred_at: Mutex::new(None),
            menu_blurred_at: Mutex::new(None),
            last_anchor: Mutex::new(None),
        }
    }
}

/// The main window starts hidden so WebView2's blank start-up never shows; it appears once the page has the
/// splash ready (`reveal_main_window`), or after a short fallback so a broken page cannot leave it invisible.
static REVEALED: AtomicBool = AtomicBool::new(false);

pub fn reveal_main(app: &AppHandle) {
    if REVEALED.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Called by index.html as soon as the splash is in the DOM. Only the first call shows the window, so a page
/// reload while the app sits in the tray does not pop it back up.
#[tauri::command]
pub fn reveal_main_window(app: AppHandle) {
    reveal_main(&app);
}

pub fn show_main(app: &AppHandle) {
    REVEALED.store(true, Ordering::SeqCst);
    hide_panel(app);
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.hide();
    }
}

fn hide_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.hide();
    }
}

fn hide_menu(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(TRAYMENU) {
        let _ = w.hide();
    }
}

/// Opens the menu at the tray click, above it when the icon is in the lower half of the screen (the usual taskbar).
fn show_menu(app: &AppHandle, anchor: PhysicalPosition<f64>) {
    let Some(menu) = app.get_webview_window(TRAYMENU) else { return };
    if menu.is_visible().unwrap_or(false) {
        let _ = menu.hide();
        return;
    }
    if let Some(t) = *app.state::<TrayState>().menu_blurred_at.lock().unwrap() {
        if t.elapsed() < Duration::from_millis(300) {
            return;
        }
    }
    *app.state::<TrayState>().last_anchor.lock().unwrap() = Some(anchor);
    hide_panel(app);
    let scale = menu.scale_factor().unwrap_or(1.0);
    let (w, h) = ((MENU_W * scale) as i32, (MENU_H * scale) as i32);
    let Some(m) = menu.monitor_from_point(anchor.x, anchor.y).ok().flatten().or_else(|| menu.primary_monitor().ok().flatten()) else { return };
    let (mx, my) = (m.position().x, m.position().y);
    let (mw, mh) = (m.size().width as i32, m.size().height as i32);
    let (ax, ay) = (anchor.x as i32, anchor.y as i32);
    let x = (ax - w / 2).clamp(mx, (mx + mw - w).max(mx));
    let y = if ay > my + mh / 2 { ay - h } else { ay };
    let y = y.clamp(my, (my + mh - h).max(my));
    let _ = menu.set_position(PhysicalPosition::new(x, y));
    let _ = menu.show();
    let _ = menu.set_focus();
    let _ = menu.emit("traymenu-open", ());
}

/// Puts the panel next to the tray click, flipping above/below by which half of the monitor it is in.
fn place_panel(panel: &WebviewWindow, anchor: Option<PhysicalPosition<f64>>) {
    let scale = panel.scale_factor().unwrap_or(1.0);
    let (w, h) = ((PANEL_W * scale) as i32, (PANEL_H * scale) as i32);
    let monitor = anchor
        .and_then(|a| panel.monitor_from_point(a.x, a.y).ok().flatten())
        .or_else(|| panel.primary_monitor().ok().flatten());
    let Some(m) = monitor else { return };
    let (mx, my) = (m.position().x, m.position().y);
    let (mw, mh) = (m.size().width as i32, m.size().height as i32);
    let (ax, ay) = anchor.map(|a| (a.x as i32, a.y as i32)).unwrap_or((mx + mw, my + mh));
    let margin = (8.0 * scale) as i32;
    let x = (ax - w / 2).clamp(mx + margin, (mx + mw - w - margin).max(mx + margin));
    let y = if ay > my + mh / 2 { ay - h - margin } else { ay + margin };
    let y = y.clamp(my + margin, (my + mh - h - margin).max(my + margin));
    let _ = panel.set_position(PhysicalPosition::new(x, y));
}

fn toggle_panel(app: &AppHandle, anchor: Option<PhysicalPosition<f64>>) {
    let Some(panel) = app.get_webview_window(PANEL) else { return };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    if let Some(t) = *app.state::<TrayState>().panel_blurred_at.lock().unwrap() {
        if t.elapsed() < Duration::from_millis(300) {
            return;
        }
    }
    let anchor = anchor.or(*app.state::<TrayState>().last_anchor.lock().unwrap());
    place_panel(&panel, anchor);
    let _ = panel.show();
    let _ = panel.set_focus();
}

fn build_panel(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, PANEL, WebviewUrl::default())
        .title("Prometheus")
        .inner_size(PANEL_W, PANEL_H)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .shadow(true)
        .initialization_script("window.__PROMETHEUS_PANEL__ = true;")
        .build()?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, TRAYMENU, WebviewUrl::default())
        .title("Prometheus")
        .inner_size(MENU_W, MENU_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .shadow(false)
        .initialization_script("window.__PROMETHEUS_TRAYMENU__ = true;")
        .build()?;
    Ok(())
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    build_panel(app)?;
    build_menu(app)?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Prometheus")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state: MouseButtonState::Up, position, .. } = event {
                let app = tray.app_handle();
                match button {
                    MouseButton::Left => {
                        *app.state::<TrayState>().last_anchor.lock().unwrap() = Some(position);
                        hide_menu(app);
                        toggle_panel(app, Some(position));
                    }
                    MouseButton::Right => show_menu(app, position),
                    _ => {}
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if window.label() == PANEL || window.label() == TRAYMENU {
                api.prevent_close();
                let _ = window.hide();
            } else if window.label() == MAIN {
                api.prevent_close();
                if app.state::<TrayState>().close_to_tray.load(Ordering::Relaxed) {
                    hide_panel(app);
                    let _ = window.hide();
                } else {
                    // The hidden panel window would otherwise keep the process alive.
                    app.exit(0);
                }
            }
        }
        WindowEvent::Focused(false) if window.label() == PANEL => {
            *app.state::<TrayState>().panel_blurred_at.lock().unwrap() = Some(Instant::now());
            let _ = window.hide();
        }
        WindowEvent::Focused(false) if window.label() == TRAYMENU => {
            *app.state::<TrayState>().menu_blurred_at.lock().unwrap() = Some(Instant::now());
            let _ = window.hide();
        }
        _ => {}
    }
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool, state: tauri::State<'_, TrayState>) {
    state.close_to_tray.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    show_main(&app);
}

/// An item chosen in the tray menu window.
#[tauri::command]
pub fn tray_menu_action(app: AppHandle, id: String) {
    hide_menu(&app);
    match id.as_str() {
        "show" => show_main(&app),
        "hide" => {
            hide_panel(&app);
            hide_main(&app);
        }
        "panel" => toggle_panel(&app, None),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Escape in the menu window.
#[tauri::command]
pub fn tray_menu_close(app: AppHandle) {
    hide_menu(&app);
}

/// Panel click: bring the main window forward and ask it to switch to that session.
#[tauri::command]
pub fn open_session_in_main(app: AppHandle, id: String) {
    show_main(&app);
    let _ = app.emit_to(MAIN, "open-session", id);
}
