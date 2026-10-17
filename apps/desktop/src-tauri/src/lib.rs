use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent};

#[cfg(desktop)]
mod tray;

#[cfg(target_os = "android")]
mod android;

#[derive(Clone, Serialize)]
struct BackendInfo {
    port: u16,
    token: String,
}

enum Status {
    Idle,
    Starting,
    Ready(BackendInfo),
    Failed(String),
}

#[derive(Clone)]
struct Backend {
    status: Arc<(Mutex<Status>, Condvar)>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Backend {
    fn new() -> Self {
        Self {
            status: Arc::new((Mutex::new(Status::Idle), Condvar::new())),
            child: Arc::new(Mutex::new(None)),
        }
    }

    fn set(&self, status: Status) {
        let (lock, cvar) = &*self.status;
        *lock.lock().unwrap() = status;
        cvar.notify_all();
    }

    /// Atomically claims the right to spawn: true if the caller should start the server now.
    fn claim_start(&self) -> bool {
        let (lock, _) = &*self.status;
        let mut guard = lock.lock().unwrap();
        if matches!(*guard, Status::Idle | Status::Failed(_)) {
            *guard = Status::Starting;
            true
        } else {
            false
        }
    }

    fn wait(&self, timeout: Duration) -> Result<BackendInfo, String> {
        let (lock, cvar) = &*self.status;
        let guard = lock.lock().unwrap();
        let (guard, _) = cvar
            .wait_timeout_while(guard, timeout, |s| matches!(s, Status::Starting))
            .unwrap();
        match &*guard {
            Status::Ready(info) => Ok(info.clone()),
            Status::Failed(e) => Err(e.clone()),
            Status::Idle => Err("本地后端未启动".into()),
            Status::Starting => Err("本地后端启动超时".into()),
        }
    }

    fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("OS RNG unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Node cannot resolve Windows verbatim paths (`\\?\D:\...`), which Tauri's resource_dir returns.
#[cfg(not(target_os = "android"))]
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        p
    }
}

/// Resolution order: PROMETHEUS_SERVER_ENTRY, bundled resource, then the repo source in debug builds.
#[cfg(not(target_os = "android"))]
fn server_entry(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PROMETHEUS_SERVER_ENTRY") {
        return Some(PathBuf::from(p));
    }
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("server").join("main.js");
        if bundled.exists() {
            return Some(strip_verbatim(bundled));
        }
    }
    if cfg!(debug_assertions) {
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../server/src/main.ts");
        if dev.exists() {
            return Some(dev);
        }
    }
    None
}

/// What to run and how: the runtime, the server script, extra environment and an optional working directory.
struct Launch {
    node: PathBuf,
    entry: PathBuf,
    env: Vec<(&'static str, PathBuf)>,
    cwd: Option<PathBuf>,
}

#[cfg(not(target_os = "android"))]
fn launch_target(app: &tauri::AppHandle) -> Result<Launch, String> {
    let entry = server_entry(app).ok_or("找不到 Prometheus 服务端入口（可设置 PROMETHEUS_SERVER_ENTRY）")?;
    let node = PathBuf::from(std::env::var("PROMETHEUS_NODE").unwrap_or_else(|_| "node".into()));
    let cwd = if std::env::var_os("PROMETHEUS_CWD").is_none() { app.path().home_dir().ok() } else { None };
    Ok(Launch { node, entry, env: Vec::new(), cwd })
}

#[cfg(target_os = "android")]
fn launch_target(app: &tauri::AppHandle) -> Result<Launch, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let runtime = android::prepare(&data)?;
    let (home, work, tmp) = (data.join("home"), data.join("workspace"), data.join("tmp"));
    for d in [&home, &work, &tmp] {
        std::fs::create_dir_all(d).map_err(|e| format!("无法创建目录：{e}"))?;
    }
    Ok(Launch {
        node: runtime.node,
        entry: runtime.entry,
        env: vec![
            ("HOME", home),
            ("TMPDIR", tmp),
            ("PROMETHEUS_HOME", data.join("prometheus")),
            ("PROMETHEUS_CWD", work.clone()),
            ("LD_LIBRARY_PATH", runtime.lib_dir),
        ],
        cwd: Some(work),
    })
}

fn spawn_backend(app: &tauri::AppHandle, backend: &Backend) -> Result<(), String> {
    let launch = launch_target(app)?;
    let node = launch.node.to_string_lossy().into_owned();
    let token = random_token();

    let mut cmd = Command::new(&launch.node);
    cmd.arg(&launch.entry)
        .env("PROMETHEUS_HOST", "127.0.0.1")
        .env("PROMETHEUS_PORT", "0")
        .env("PROMETHEUS_TOKEN", &token)
        .env("PROMETHEUS_PARENT_WATCH", "1")
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // `tauri dev` serves the UI from the Vite dev server, whose origin the server would otherwise reject.
    if cfg!(debug_assertions) && std::env::var_os("PROMETHEUS_ALLOWED_ORIGINS").is_none() {
        cmd.env("PROMETHEUS_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173");
    }
    if let Some(dir) = &launch.cwd {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 Node（{node}）：{e}。请安装 Node ≥ 22.19 或设置 PROMETHEUS_NODE"))?;
    let stdout = child.stdout.take().ok_or("无法读取后端输出")?;
    let stderr = child.stderr.take().ok_or("无法读取后端输出")?;
    *backend.child.lock().unwrap() = Some(child);

    let stderr_tail = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_thread = {
        let tail = stderr_tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("[server] {line}");
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 12 {
                    t.remove(0);
                }
            }
        })
    };

    let backend = backend.clone();
    std::thread::spawn(move || {
        let mut ready = false;
        // Keep draining after READY so a full pipe never blocks the server.
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if !ready {
                if let Some(port) = line.strip_prefix("PROMETHEUS_READY ").and_then(|p| p.trim().parse().ok()) {
                    ready = true;
                    backend.set(Status::Ready(BackendInfo { port, token: token.clone() }));
                    continue;
                }
            }
            println!("[server] {line}");
        }
        if !ready {
            let _ = stderr_thread.join();
            let tail = stderr_tail.lock().unwrap().join("\n");
            let msg = if tail.trim().is_empty() {
                "本地后端在就绪前退出".to_string()
            } else {
                format!("本地后端在就绪前退出：\n{tail}")
            };
            backend.set(Status::Failed(msg));
        }
    });
    Ok(())
}

/// Local mode: spawns the bundled server on first use, then returns its port and one-time token.
#[tauri::command]
async fn start_local_backend(app: tauri::AppHandle, state: tauri::State<'_, Backend>) -> Result<Option<BackendInfo>, String> {
    if !local_supported() {
        return Ok(None);
    }
    let backend = state.inner().clone();
    if backend.claim_start() {
        if let Err(e) = spawn_backend(&app, &backend) {
            eprintln!("[prometheus] {e}");
            backend.set(Status::Failed(e.clone()));
            return Err(e);
        }
    }
    tauri::async_runtime::spawn_blocking(move || backend.wait(Duration::from_secs(90)))
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
}

/// Stops the bundled server so an installer can replace its files (Windows locks them while running).
#[tauri::command]
fn stop_local_backend(state: tauri::State<'_, Backend>) {
    state.kill();
    state.set(Status::Idle);
}

#[tauri::command]
fn relaunch_app(app: tauri::AppHandle, state: tauri::State<'_, Backend>) {
    state.kill();
    app.restart();
}

/// Whether this build can host a local server: desktop always, Android only when the APK carries a Node runtime.
#[tauri::command]
fn local_supported() -> bool {
    #[cfg(target_os = "android")]
    return android::runtime_present();
    #[cfg(not(target_os = "android"))]
    return cfg!(desktop);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let backend = Backend::new();
    let builder = tauri::Builder::default();
    // Single-instance must be registered first so a second launch just surfaces the hidden window.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(tray::TrayState::new())
        .on_window_event(tray::on_window_event)
        .setup(|app| {
            tray::init(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_local_backend,
            stop_local_backend,
            relaunch_app,
            local_supported,
            tray::set_close_to_tray,
            tray::show_main_window,
            tray::open_session_in_main
        ]);
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![start_local_backend, stop_local_backend, relaunch_app, local_supported]);
    let app = builder
        .manage(backend.clone())
        .build(tauri::generate_context!())
        .expect("failed to build Prometheus desktop");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            backend.kill();
        }
    });
}
