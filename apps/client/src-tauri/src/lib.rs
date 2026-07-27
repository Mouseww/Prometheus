use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{AppHandle, Manager, RunEvent};

struct SidecarState(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState(Mutex::new(None)))
        .setup(|app| {
            #[cfg(desktop)]
            {
                start_desktop_sidecar(app.handle())?;
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

#[cfg(desktop)]
fn start_desktop_sidecar(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let workspace_dir = data_dir.join("workspace");
    let web_root = data_dir.join("web-fallback");
    std::fs::create_dir_all(&data_dir)?;
    std::fs::create_dir_all(&workspace_dir)?;
    std::fs::create_dir_all(&web_root)?;

    let server = resolve_sidecar_path()?;
    if !server.exists() {
        eprintln!(
            "Prometheus control-plane sidecar not found at {}. Desktop shell will still open; start the server separately if needed.",
            server.display()
        );
        return Ok(());
    }

    let db_file = data_dir.join("prometheus.db");
    let runtime_file = data_dir.join("runtime.json");
    let (host, port, workspace_root) = read_runtime_bind(&runtime_file, &workspace_dir);
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

    wait_for_health(&host, port, Duration::from_secs(20));

    if let Ok(mut guard) = app.state::<SidecarState>().0.lock() {
        *guard = Some(child);
    }
    Ok(())
}

#[cfg(desktop)]
fn resolve_sidecar_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut exe_dir = std::env::current_exe()?;
    exe_dir.pop();

    // Prefer exact names first, then Tauri externalBin target-triple suffixes.
    let mut candidates = vec![
        exe_dir.join(if cfg!(windows) {
            "prometheus-server.exe"
        } else {
            "prometheus-server"
        }),
    ];

    if let Ok(entries) = std::fs::read_dir(&exe_dir) {
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
                candidates.push(entry.path());
            }
        }
    }

    // macOS app bundles sometimes place helpers one directory up from MacOS.
    if cfg!(target_os = "macos") {
        if let Some(parent) = exe_dir.parent() {
            for sub in ["MacOS", "Resources", "Helpers"] {
                let dir = parent.join(sub);
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if name == "prometheus-server" || name.starts_with("prometheus-server-") {
                            candidates.push(entry.path());
                        }
                    }
                }
            }
        }
    }

    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }

    // Dev / CI fallback: repo-built server binary.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        for profile in ["debug", "release"] {
            let candidate = PathBuf::from(&manifest_dir)
                .join("../../server-rs/target")
                .join(profile)
                .join(if cfg!(windows) {
                    "prometheus-server.exe"
                } else {
                    "prometheus-server"
                });
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    Ok(candidates
        .into_iter()
        .next()
        .unwrap_or_else(|| exe_dir.join("prometheus-server")))
}

#[cfg(desktop)]
fn read_runtime_bind(runtime_file: &PathBuf, default_workspace: &PathBuf) -> (String, u16, PathBuf) {
    let mut host = "127.0.0.1".to_string();
    let mut port = 4310_u16;
    let mut workspace = default_workspace.clone();
    if let Ok(raw) = std::fs::read_to_string(runtime_file) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(v) = value.get("host").and_then(|v| v.as_str()) {
                if !v.trim().is_empty() {
                    host = v.trim().to_string();
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

#[cfg(desktop)]
fn wait_for_health(host: &str, port: u16, timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if control_plane_ready(host, port) {
            return;
        }
        thread::sleep(Duration::from_millis(200));
    }
    eprintln!(
        "Prometheus control-plane sidecar did not become healthy on {}:{} within {:?}",
        host, port, timeout
    );
}

#[cfg(desktop)]
fn control_plane_ready(host: &str, port: u16) -> bool {
    use std::io::{Read, Write};

    let addr = format!("{host}:{port}");
    let Ok(socket_addr) = addr.parse() else {
        return false;
    };
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&socket_addr, Duration::from_millis(250)) else {
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
    if let Ok(mut guard) = app.state::<SidecarState>().0.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
