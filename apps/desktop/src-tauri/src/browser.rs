//! Built-in browser: a standalone webview window. (A child webview inside the main window is a system-level
//! window that always paints above the app's HTML, covering settings pages and dialogs, so it is not used.)
//!
//! The page cannot talk to Tauri (it has no IPC capability), so scripts the app runs inside it hand their
//! result back through the URL fragment, which this side polls and then restores.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "wb";

/// Links that would open a new tab are kept in this one.
const SAME_TAB: &str = "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[target]');if(a)a.target='_self';},true);window.open=function(u){if(u)location.href=u;return null;};";

const RUN: &str = r#"(async()=>{let r;try{r=JSON.stringify({ok:true,v:await (async()=>{__SCRIPT__})()})}catch(e){r=JSON.stringify({ok:false,e:String((e&&e.message)||e)})}
const b=btoa(unescape(encodeURIComponent(r))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
history.replaceState(history.state,'',location.pathname+location.search+'#__PREFIX__'+b);})();"#;

/// Scripts run one at a time: each borrows the URL fragment while it waits for its answer.
#[derive(Default)]
pub struct BrowserState {
    exec: Mutex<()>,
    /// Two quick opens (React remounts) must not both try to create the view.
    open: Mutex<()>,
}

#[derive(Deserialize, Clone, Copy)]
#[allow(dead_code)]
pub struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn web_url(raw: &str) -> Result<Url, String> {
    if raw == "about:blank" {
        return Url::parse(raw).map_err(|e| e.to_string());
    }
    let url = Url::parse(raw).map_err(|e| format!("网址无效：{e}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        _ => Err("只允许打开 http / https 网址".into()),
    }
}

fn webview(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window(LABEL).ok_or_else(|| "浏览器未打开".to_string())
}

/// Async on purpose (all of these): a sync command runs inside WebView2's IPC callback on the main thread,
/// where creating another WebView2 never completes and leaves an empty, click-swallowing host window behind.
/// Creates the browser view at `rect` (CSS pixels of the main window), or moves it there if it exists.
#[tauri::command]
pub async fn wb_open(app: AppHandle, url: String, _rect: Option<Rect>) -> Result<(), String> {
    let url = web_url(&url)?;
    let state = app.state::<BrowserState>();
    let _guard = state.open.lock().map_err(|_| "浏览器状态异常".to_string())?;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let _ = existing.show();
        let _ = existing.set_focus();
        if existing.url().map(|u| u != url).unwrap_or(true) {
            existing.navigate(url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let handle = app.clone();
    WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(url))
        .title("Prometheus 浏览器")
        .inner_size(1100.0, 760.0)
        .initialization_script(SAME_TAB)
        .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about"))
        .on_page_load(move |_, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = handle.emit("wb-load", json!({ "phase": phase, "url": payload.url().as_str() }));
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Kept so older frontends keep working; the window positions itself.
#[tauri::command]
pub async fn wb_bounds(_rect: Option<Rect>) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn wb_visible(_visible: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn wb_navigate(app: AppHandle, url: String) -> Result<(), String> {
    webview(&app)?.navigate(web_url(&url)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn wb_url(app: AppHandle) -> Result<String, String> {
    Ok(webview(&app)?.url().map_err(|e| e.to_string())?.to_string())
}

#[tauri::command]
pub async fn wb_close(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn fragment_suffix(url: &Url) -> String {
    url.fragment().map(|f| format!("#{f}")).unwrap_or_default()
}

/// Runs `script` as the body of an async function in the page and returns its JSON result
/// (`{"ok":true,"v":…}` or `{"ok":false,"e":"…"}`).
#[tauri::command]
pub async fn wb_exec(app: AppHandle, script: String, timeout_ms: Option<u64>) -> Result<String, String> {
    let wv = webview(&app)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(15_000).min(60_000));
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        // Held for the whole wait; a blocking thread is the right place for a std lock.
        let state = app.state::<BrowserState>();
        let _guard = state.exec.lock().map_err(|_| "浏览器状态异常".to_string())?;
        let before = wv.url().map_err(|e| e.to_string())?;
        let mut raw = [0u8; 8];
        getrandom::fill(&mut raw).map_err(|e| e.to_string())?;
        let prefix = format!("__pi_{}=", raw.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let body = RUN.replace("__PREFIX__", &prefix).replace("__SCRIPT__", &script);
        wv.eval(body).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + timeout;
        loop {
            std::thread::sleep(Duration::from_millis(40));
            if let Ok(now) = wv.url() {
                if let Some(answer) = now.fragment().and_then(|f| f.strip_prefix(prefix.as_str())) {
                    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(answer).map_err(|e| e.to_string())?;
                    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
                    let restore = serde_json::to_string(&fragment_suffix(&before)).unwrap_or_else(|_| "\"\"".into());
                    let _ = wv.eval(format!("history.replaceState(history.state,'',location.pathname+location.search+{restore});"));
                    return Ok(text);
                }
            }
            if Instant::now() >= deadline {
                return Err("页面脚本超时（页面可能正在跳转）".into());
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
