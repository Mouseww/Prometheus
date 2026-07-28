use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeStatus {
    pub available: bool,
    pub running: bool,
    pub healthy: bool,
    pub host: String,
    pub port: u16,
    pub url: String,
    pub workspace_root: String,
    pub binary_path: Option<String>,
    pub message: String,
    pub desktop: bool,
}

struct SidecarState {
    child: Mutex<Option<Child>>,
    host: Mutex<String>,
    port: Mutex<u16>,
    workspace: Mutex<PathBuf>,
    binary: Mutex<Option<PathBuf>>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            child: Mutex::new(None),
            host: Mutex::new("127.0.0.1".into()),
            port: Mutex::new(4310),
            workspace: Mutex::new(PathBuf::from(".")),
            binary: Mutex::new(None),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            local_runtime_status,
            ensure_local_runtime,
            restart_local_runtime
        ])
        .setup(|app| {
            #[cfg(desktop)]
            {
                // Best-effort boot of embedded control plane. UI can retry via ensure_local_runtime.
                let _ = start_desktop_sidecar(app.handle(), false);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Prometheus")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_sidecar(app);
            }
        });
}

#[tauri::command]
fn local_runtime_status(app: AppHandle, state: State<SidecarState>) -> LocalRuntimeStatus {
    build_status(&app, &state)
}

#[tauri::command]
fn ensure_local_runtime(app: AppHandle, state: State<SidecarState>) -> Result<LocalRuntimeStatus, String> {
    #[cfg(desktop)]
    {
        start_desktop_sidecar(&app, false).map_err(|error| error.to_string())?;
        return Ok(build_status(&app, &state));
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        Err("Embedded local runtime is only available on desktop builds".into())
    }
}

#[tauri::command]
fn restart_local_runtime(app: AppHandle, state: State<SidecarState>) -> Result<LocalRuntimeStatus, String> {
    #[cfg(desktop)]
    {
        stop_sidecar(&app);
        thread::sleep(Duration::from_millis(300));
        start_desktop_sidecar(&app, true).map_err(|error| error.to_string())?;
        return Ok(build_status(&app, &state));
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, state);
        Err("Embedded local runtime is only available on desktop builds".into())
    }
}

fn build_status(app: &AppHandle, state: &State<SidecarState>) -> LocalRuntimeStatus {
    let host = state
        .host
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "127.0.0.1".into());
    let port = state.port.lock().map(|value| *value).unwrap_or(4310);
    let workspace = state
        .workspace
        .lock()
        .map(|value| value.display().to_string())
        .unwrap_or_else(|_| String::new());
    let binary = state
        .binary
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .map(|path| path.display().to_string());
    let running = state
        .child
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false);
    let healthy = control_plane_ready(&host, port);
    let available = binary
        .as_ref()
        .map(|path| PathBuf::from(path).is_file())
        .unwrap_or_else(|| resolve_sidecar_path(app).map(|path| path.is_file()).unwrap_or(false));

    let message = if healthy {
        "Local control plane is running".into()
    } else if running {
        "Local control plane process started but not healthy yet".into()
    } else if available {
        "Local control plane binary is present but not running".into()
    } else {
        "Local control plane binary is missing. Build/stage prometheus-server sidecar for this desktop app.".into()
    };

    LocalRuntimeStatus {
        available,
        running: running || healthy,
        healthy,
        host: host.clone(),
        port,
        url: format!("http://{host}:{port}"),
        workspace_root: workspace,
        binary_path: binary,
        message,
        desktop: cfg!(desktop),
    }
}

#[cfg(desktop)]
fn start_desktop_sidecar(app: &AppHandle, force_restart: bool) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<SidecarState>();
    if !force_restart {
        let host = state.host.lock().map(|value| value.clone()).unwrap_or_else(|_| "127.0.0.1".into());
        let port = state.port.lock().map(|value| *value).unwrap_or(4310);
        if control_plane_ready(&host, port) {
            return Ok(());
        }
        if let Ok(guard) = state.child.lock() {
            if guard.is_some() {
                // Process claimed; give health another chance without double-spawn.
                wait_for_health(&host, port, Duration::from_secs(8));
                if control_plane_ready(&host, port) {
                    return Ok(());
                }
            }
        }
    }

    let data_dir = app.path().app_data_dir()?;
    let default_workspace = data_dir.join("workspace");
    let web_root = resolve_web_root(app, &data_dir);
    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(&default_workspace)?;
    std::fs::create_dir_all(&web_root)?;

    let server = resolve_sidecar_path(app)?;
    if let Ok(mut guard) = state.binary.lock() {
        *guard = Some(server.clone());
    }

    if !server.exists() {
        return Err(format!(
            "Embedded control-plane sidecar not found at {}",
            server.display()
        )
        .into());
    }

    // Reject CI/dev placeholders so we fail loudly instead of spawning junk.
    let meta = std::fs::metadata(&server)?;
    if meta.len() < 1024 * 1024 {
        return Err(format!(
            "Sidecar at {} looks like a placeholder ({} bytes). Stage a real prometheus-server build first.",
            server.display(),
            meta.len()
        )
        .into());
    }

    let db_file = data_dir.join("prometheus.db");
    let runtime_file = data_dir.join("runtime.json");
    let (host, port, workspace_root) = read_runtime_bind(&runtime_file, &default_workspace);

    // If something else already owns the port and is healthy, reuse it.
    if control_plane_ready(&host, port) {
        if let Ok(mut guard) = state.host.lock() {
            *guard = host;
        }
        if let Ok(mut guard) = state.port.lock() {
            *guard = port;
        }
        if let Ok(mut guard) = state.workspace.lock() {
            *guard = workspace_root;
        }
        return Ok(());
    }

    // Ensure previous child is gone before rebinding.
    stop_sidecar(app);

    let mut child = Command::new(&server)
        .env("PROMETHEUS_HOST", &host)
        .env("PROMETHEUS_PORT", port.to_string())
        .env("PROMETHEUS_DATA_FILE", &db_file)
        .env("PROMETHEUS_RUNTIME_FILE", &runtime_file)
        .env("PROMETHEUS_WORKSPACE_ROOT", &workspace_root)
        .env("PROMETHEUS_WEB_ROOT", &web_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                eprintln!("[prometheus-server] {line}");
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                eprintln!("[prometheus-server:err] {line}");
            }
        });
    }

    if let Ok(mut guard) = state.host.lock() {
        *guard = host.clone();
    }
    if let Ok(mut guard) = state.port.lock() {
        *guard = port;
    }
    if let Ok(mut guard) = state.workspace.lock() {
        *guard = workspace_root;
    }
    if let Ok(mut guard) = state.child.lock() {
        *guard = Some(child);
    }

    if !wait_for_health(&host, port, Duration::from_secs(20)) {
        return Err(format!(
            "Local control plane did not become healthy on http://{host}:{port}"
        )
        .into());
    }
    Ok(())
}


fn resolve_web_root(app: &AppHandle, data_dir: &Path) -> PathBuf {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(manifest_dir);
        candidates.push(manifest.join("../dist"));
        candidates.push(manifest.join("../../client/dist"));
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("dist"));
        candidates.push(resource_dir.join("web"));
        candidates.push(resource_dir.join("client/dist"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("apps/client/dist"));
        candidates.push(cwd.join("dist"));
        candidates.push(cwd.join("client/dist"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("dist"));
            candidates.push(exe_dir.join("web"));
            if let Some(parent) = exe_dir.parent() {
                candidates.push(parent.join("dist"));
                candidates.push(parent.join("Resources/dist"));
                candidates.push(parent.join("resources/dist"));
            }
        }
    }

    for candidate in candidates {
        if candidate.join("index.html").is_file() {
            return candidate;
        }
    }

    let fallback = data_dir.join("web-fallback");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_sidecar_candidates(&mut candidates, exe_dir);
            // Tauri resource / externalBin layouts
            push_sidecar_candidates(&mut candidates, &exe_dir.join("binaries"));
            if let Some(parent) = exe_dir.parent() {
                for sub in ["Resources", "resources", "MacOS", "Helpers"] {
                    push_sidecar_candidates(&mut candidates, &parent.join(sub));
                    push_sidecar_candidates(&mut candidates, &parent.join(sub).join("binaries"));
                }
            }
        }
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        push_sidecar_candidates(&mut candidates, &resource_dir);
        push_sidecar_candidates(&mut candidates, &resource_dir.join("binaries"));
    }

    // Dev fallbacks: staged externalBin + cargo build outputs.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let manifest = PathBuf::from(&manifest_dir);
        push_sidecar_candidates(&mut candidates, &manifest.join("binaries"));
        for profile in ["debug", "release"] {
            candidates.push(
                manifest
                    .join("../../server-rs/target")
                    .join(profile)
                    .join(if cfg!(windows) {
                        "prometheus-server.exe"
                    } else {
                        "prometheus-server"
                    }),
            );
            // Also check target/<triple>/<profile>
            if let Ok(entries) = std::fs::read_dir(manifest.join("../../server-rs/target")) {
                for entry in entries.flatten() {
                    let path = entry
                        .path()
                        .join(profile)
                        .join(if cfg!(windows) {
                            "prometheus-server.exe"
                        } else {
                            "prometheus-server"
                        });
                    candidates.push(path);
                }
            }
        }
    }

    // Prefer the largest existing candidate so placeholders lose to real builds.
    let mut best: Option<(u64, PathBuf)> = None;
    for candidate in candidates {
        if !candidate.is_file() {
            continue;
        }
        let len = std::fs::metadata(&candidate).map(|meta| meta.len()).unwrap_or(0);
        if len < 1024 {
            continue;
        }
        match &best {
            Some((best_len, _)) if *best_len >= len => {}
            _ => best = Some((len, candidate)),
        }
    }

    if let Some((_, path)) = best {
        return Ok(path);
    }

    Ok(PathBuf::from(if cfg!(windows) {
        "prometheus-server.exe"
    } else {
        "prometheus-server"
    }))
}

fn push_sidecar_candidates(out: &mut Vec<PathBuf>, dir: &Path) {
    if !dir.exists() {
        return;
    }
    out.push(dir.join(if cfg!(windows) {
        "prometheus-server.exe"
    } else {
        "prometheus-server"
    }));
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_sidecar = if cfg!(windows) {
                name.eq_ignore_ascii_case("prometheus-server.exe")
                    || (name.starts_with("prometheus-server-")
                        && name.to_ascii_lowercase().ends_with(".exe"))
            } else {
                name == "prometheus-server" || name.starts_with("prometheus-server-")
            };
            if is_sidecar {
                out.push(entry.path());
            }
        }
    }
}

fn read_runtime_bind(runtime_file: &Path, default_workspace: &Path) -> (String, u16, PathBuf) {
    let mut host = "127.0.0.1".to_string();
    let mut port = 4310_u16;
    let mut workspace = default_workspace.to_path_buf();
    if let Ok(raw) = std::fs::read_to_string(runtime_file) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(v) = value.get("host").and_then(|v| v.as_str()) {
                if !v.trim().is_empty() {
                    // Desktop embedded mode always binds loopback for local independence.
                    // Non-loopback hosts are for dedicated shared servers, not the app sidecar.
                    if v == "127.0.0.1" || v == "localhost" || v == "::1" {
                        host = v.trim().to_string();
                    }
                }
            }
            if let Some(v) = value.get("port").and_then(|v| v.as_u64()) {
                if v > 0 && v <= u16::MAX as u64 {
                    port = v as u16;
                }
            }
            if let Some(v) = value.get("workspaceRoot").and_then(|v| v.as_str()) {
                let path = PathBuf::from(v);
                if path.is_dir() {
                    workspace = path;
                }
            }
        }
    }
    (host, port, workspace)
}

fn wait_for_health(host: &str, port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if control_plane_ready(host, port) {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    eprintln!(
        "Prometheus control-plane sidecar did not become healthy on {}:{} within {:?}",
        host, port, timeout
    );
    false
}

fn control_plane_ready(host: &str, port: u16) -> bool {
    use std::io::{Read, Write};

    let addr = format!("{host}:{port}");
    let Ok(socket_addr) = addr.parse() else {
        return false;
    };
    let Ok(mut stream) =
        std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_millis(250))
    else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(400)));
    let request = format!(
        "GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0_u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let body = String::from_utf8_lossy(&buf[..n]);
            body.contains("200") && body.contains("ok")
        }
        _ => false,
    }
}

fn stop_sidecar(app: &AppHandle) {
    let Some(state) = app.try_state::<SidecarState>() else {
        return;
    };
    // Take the child out before dropping State so the MutexGuard cannot outlive it.
    let child = state.child.lock().ok().and_then(|mut guard| guard.take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}
