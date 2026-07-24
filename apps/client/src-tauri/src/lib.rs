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
    let mut child = Command::new(&server)
        .env("PROMETHEUS_HOST", "127.0.0.1")
        .env("PROMETHEUS_PORT", "4310")
        .env("PROMETHEUS_DATA_FILE", &db_file)
        .env("PROMETHEUS_WORKSPACE_ROOT", &workspace_dir)
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

    wait_for_health(Duration::from_secs(20));

    if let Ok(mut guard) = app.state::<SidecarState>().0.lock() {
        *guard = Some(child);
    }
    Ok(())
}

#[cfg(desktop)]
fn resolve_sidecar_path() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let mut path = std::env::current_exe()?;
    path.pop();
    // externalBin is placed next to the app executable.
    let candidate = path.join(if cfg!(windows) {
        "prometheus-server.exe"
    } else {
        "prometheus-server"
    });
    if candidate.exists() {
        return Ok(candidate);
    }
    // Dev / CI fallback: repo-built server binary.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let debug = PathBuf::from(&manifest_dir)
            .join("../../server-rs/target/debug")
            .join(if cfg!(windows) {
                "prometheus-server.exe"
            } else {
                "prometheus-server"
            });
        if debug.exists() {
            return Ok(debug);
        }
        let release = PathBuf::from(&manifest_dir)
            .join("../../server-rs/target/release")
            .join(if cfg!(windows) {
                "prometheus-server.exe"
            } else {
                "prometheus-server"
            });
        if release.exists() {
            return Ok(release);
        }
    }
    Ok(candidate)
}

#[cfg(desktop)]
fn wait_for_health(timeout: Duration) {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if let Ok(response) = std::net::TcpStream::connect_timeout(
            &"127.0.0.1:4310".parse().expect("addr"),
            Duration::from_millis(250),
        ) {
            drop(response);
            return;
        }
        thread::sleep(Duration::from_millis(200));
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
