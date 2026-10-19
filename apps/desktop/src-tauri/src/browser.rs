//! Built-in browser: a native child webview laid over the main window's viewer panel.
//!
//! The page cannot talk to Tauri (it has no IPC capability), so scripts the app runs inside it hand their
//! result back through the URL fragment, which this side polls and then restores.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl};

const LABEL: &str = "wb";
const MAIN: &str = "main";

/// Links that would open a new tab are kept in this one.
const SAME_TAB: &str = "document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[target]');if(a)a.target='_self';},true);window.open=function(u){if(u)location.href=u;return null;};";

const RUN: &str = r#"(async()=>{let r;try{r=JSON.stringify({ok:true,v:await (async()=>{__SCRIPT__})()})}catch(e){r=JSON.stringify({ok:false,e:String((e&&e.message)||e)})}
const b=btoa(unescape(encodeURIComponent(r))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
history.replaceState(history.state,'',location.pathname+location.search+'#__PREFIX__'+b);})();"#;

/// Scripts run one at a time: each borrows the URL fragment while it waits for its answer.
#[derive(Default)]
pub struct BrowserState {
    exec: Mutex<()>,
}

#[derive(Deserialize, Clone, Copy)]
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

fn webview(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(LABEL).ok_or_else(|| "浏览器未打开".to_string())
}

/// Creates the browser view at `rect` (CSS pixels of the main window), or moves it there if it exists.
#[tauri::command]
pub fn wb_open(app: AppHandle, url: String, rect: Rect) -> Result<(), String> {
    let url = web_url(&url)?;
    if let Some(existing) = app.get_webview(LABEL) {
        existing.set_position(LogicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
        existing.set_size(LogicalSize::new(rect.w, rect.h)).map_err(|e| e.to_string())?;
        existing.show().map_err(|e| e.to_string())?;
        if existing.url().map(|u| u != url).unwrap_or(true) {
            existing.navigate(url).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = app.get_window(MAIN).ok_or("找不到主窗口")?;
    let handle = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .initialization_script(SAME_TAB)
        .on_navigation(|u| matches!(u.scheme(), "http" | "https" | "about"))
        .on_page_load(move |_, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = handle.emit("wb-load", json!({ "phase": phase, "url": payload.url().as_str() }));
        });
    window
        .add_child(builder, LogicalPosition::new(rect.x, rect.y), LogicalSize::new(rect.w, rect.h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn wb_bounds(app: AppHandle, rect: Rect) -> Result<(), String> {
    let Some(wv) = app.get_webview(LABEL) else { return Ok(()) };
    wv.set_position(LogicalPosition::new(rect.x, rect.y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(rect.w.max(1.0), rect.h.max(1.0))).map_err(|e| e.to_string())
}

/// Hide while something in the app has to be drawn over it: a native view always sits above HTML.
#[tauri::command]
pub fn wb_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let Some(wv) = app.get_webview(LABEL) else { return Ok(()) };
    if visible {
        return wv.show().map_err(|e| e.to_string());
    }
    // Hiding alone has not been enough to stop it swallowing clicks, so also park it off-screen at 1px.
    let _ = wv.hide();
    park(&wv);
    Ok(())
}

fn park(wv: &tauri::Webview) {
    let _ = wv.set_size(LogicalSize::new(1.0, 1.0));
    let _ = wv.set_position(LogicalPosition::new(-20000.0, -20000.0));
}

#[tauri::command]
pub fn wb_navigate(app: AppHandle, url: String) -> Result<(), String> {
    webview(&app)?.navigate(web_url(&url)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn wb_url(app: AppHandle) -> Result<String, String> {
    Ok(webview(&app)?.url().map_err(|e| e.to_string())?.to_string())
}

#[tauri::command]
pub fn wb_close(app: AppHandle) -> Result<(), String> {
    if let Some(wv) = app.get_webview(LABEL) {
        park(&wv);
        wv.close().map_err(|e| e.to_string())?;
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
