//! System tray: close-to-tray for the main window plus a small always-on-top panel listing running sessions.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

const MAIN: &str = "main";
const PANEL: &str = "panel";
const PANEL_W: f64 = 340.0;
const PANEL_H: f64 = 440.0;

pub struct TrayState {
    close_to_tray: AtomicBool,
    /// When the panel last lost focus; a tray click right after that must not reopen it.
    panel_blurred_at: Mutex<Option<Instant>>,
}

impl TrayState {
    pub fn new() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            panel_blurred_at: Mutex::new(None),
        }
    }
}

pub fn show_main(app: &AppHandle) {
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

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    build_panel(app)?;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "隐藏主窗口", true, None::<&str>)?;
    let panel = MenuItem::with_id(app, "panel", "工作面板", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Prometheus", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &panel, &sep, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Prometheus")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "hide" => {
                hide_panel(app);
                hide_main(app);
            }
            "panel" => toggle_panel(app, None),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                toggle_panel(tray.app_handle(), Some(position));
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
            if window.label() == PANEL {
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

/// Panel click: bring the main window forward and ask it to switch to that session.
#[tauri::command]
pub fn open_session_in_main(app: AppHandle, id: String) {
    show_main(&app);
    let _ = app.emit_to(MAIN, "open-session", id);
}
