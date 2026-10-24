use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{Manager, RunEvent};

mod runtimes;

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

/// The Node runtime shipped inside the installer (`node/` resource, see scripts/bundle-node.ts).
#[cfg(not(target_os = "android"))]
fn bundled_node(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Windows keeps node.exe at the top (npm.cmd looks for node_modules beside it); Unix uses bin/ + lib/.
    let root = strip_verbatim(app.path().resource_dir().ok()?.join("node"));
    let p = if cfg!(windows) { root.join(NODE_EXE) } else { root.join("bin").join(NODE_EXE) };
    #[cfg(unix)]
    if p.is_file() && !is_executable(&p) {
        // Resource copying can drop the exec bit; restore it rather than fail to start.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
    }
    is_executable(&p).then_some(p)
}

/// What to run and how: the runtime, the server script, extra environment and an optional working directory.
struct Launch {
    node: PathBuf,
    entry: PathBuf,
    env: Vec<(&'static str, std::ffi::OsString)>,
    /// Variables from on-demand runtimes (GOROOT, CARGO_HOME, ...); names come from the manifest, so they are owned.
    extra_env: Vec<(String, std::ffi::OsString)>,
    cwd: Option<PathBuf>,
}

/// True when `p` is an executable file we could actually spawn.
fn is_executable(p: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

const NODE_EXE: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// First `node` on the given PATH entries, recording every candidate it looked at for error messages.
#[cfg(not(target_os = "android"))]
fn find_node_in(path: Option<std::ffi::OsString>, tried: &mut Vec<String>) -> Option<PathBuf> {
    for dir in std::env::split_paths(&path?) {
        let candidate = dir.join(NODE_EXE);
        tried.push(candidate.display().to_string());
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

/// Thin wrappers (nvm, volta, asdf, fnm) install `node` as a shim that needs its own tool directory on PATH,
/// so the directories we found are also handed to the child process.
#[cfg(not(target_os = "android"))]
fn node_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        // GUI launches (Finder, Dock, Login Items) get a minimal PATH: no Homebrew, nvm or MacPorts.
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"].map(PathBuf::from));
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let home = PathBuf::from(home);
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".asdf/shims"));
        dirs.push(home.join(".local/share/fnm/aliases/default/bin"));
        dirs.push(home.join("n/bin"));
        // nvm keeps versions under ~/.nvm/versions/node/vX.Y.Z/bin; prefer the default alias, then the newest.
        let versions = home.join(".nvm/versions/node");
        let default_alias = std::fs::read_to_string(home.join(".nvm/alias/default"))
            .ok()
            .map(|s| s.trim().trim_start_matches('v').to_string())
            .filter(|s| !s.is_empty());
        let mut found: Vec<(Option<u64>, PathBuf)> = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&versions) {
            for entry in rd.flatten() {
                let bin = entry.path().join("bin");
                let name = entry.file_name().to_string_lossy().into_owned();
                let version = name.trim_start_matches('v');
                let matches_default = default_alias.as_deref().is_some_and(|d| version == d || version.starts_with(&format!("{d}.")));
                let major = version.split('.').next().and_then(|s| s.parse().ok());
                found.push((matches_default.then_some(u64::MAX).or(major), bin));
            }
        }
        found.sort_by(|a, b| b.0.cmp(&a.0));
        dirs.extend(found.into_iter().map(|(_, p)| p));
    }
    dirs
}

/// Locates a `node` binary. `PROMETHEUS_NODE` wins, then the runtime bundled in the installer; only when that
/// is missing (dev builds, stripped installs) does it search PATH and the usual install locations.
/// Returns the binary and the extra directories that should be prepended to the child PATH.
#[cfg(not(target_os = "android"))]
fn resolve_node(bundled: Option<PathBuf>) -> Result<(PathBuf, Vec<PathBuf>, Vec<PathBuf>), String> {
    if let Some(custom) = std::env::var_os("PROMETHEUS_NODE").filter(|v| !v.is_empty()) {
        let p = PathBuf::from(custom);
        // A bare name is left to the OS path search; an explicit path is checked before we try to run it.
        if p.components().count() > 1 && !is_executable(&p) {
            return Err(format!("PROMETHEUS_NODE 指向的 Node 不可执行：{}", p.display()));
        }
        return Ok((p, Vec::new(), Vec::new()));
    }
    if let Some(node) = bundled {
        // npm and npx sit next to the bundled node; appended, so a tool the user installed still wins.
        let dir = node.parent().map(PathBuf::from).into_iter().collect();
        return Ok((node, Vec::new(), dir));
    }
    // `Command::new("node")` lets the OS search PATH, which keeps Windows working the way it always has.
    if cfg!(windows) {
        return Ok((PathBuf::from(NODE_EXE), Vec::new(), Vec::new()));
    }
    let mut tried: Vec<String> = Vec::new();
    if let Some(found) = find_node_in(std::env::var_os("PATH"), &mut tried) {
        return Ok((found, node_dirs(), Vec::new()));
    }
    for dir in node_dirs() {
        let candidate = dir.join(NODE_EXE);
        tried.push(candidate.display().to_string());
        if is_executable(&candidate) {
            return Ok((candidate, node_dirs(), Vec::new()));
        }
    }
    Err(format!(
        "找不到 Node（node）：GUI 启动的 Prometheus 拿不到终端里的 PATH。请安装 Node ≥ 22.19，或在设置里把 PROMETHEUS_NODE 指向 node 的完整路径。已尝试：{}",
        tried.join("、")
    ))
}

/// Homebrew and version managers put node outside the PATH a GUI launch inherits, so the child gets
/// those directories prepended: npm, npx and any tool the agent runs then resolve too.
/// `append` goes last (the bundled runtime's directory, which must not shadow the user's own tools).
#[cfg(not(target_os = "android"))]
fn node_env(prepend: Vec<PathBuf>, append: Vec<PathBuf>) -> Vec<(&'static str, std::ffi::OsString)> {
    if prepend.is_empty() && append.is_empty() {
        return Vec::new();
    }
    let mut parts = prepend;
    if let Some(existing) = std::env::var_os("PATH") {
        parts.extend(std::env::split_paths(&existing));
    }
    parts.extend(append);
    match std::env::join_paths(parts) {
        Ok(joined) => vec![("PATH", joined)],
        Err(_) => Vec::new(),
    }
}

#[cfg(not(target_os = "android"))]
fn launch_target(app: &tauri::AppHandle) -> Result<Launch, String> {
    let entry = server_entry(app).ok_or("找不到 Prometheus 服务端入口（可设置 PROMETHEUS_SERVER_ENTRY）")?;
    let (node, mut prepend, append) = resolve_node(bundled_node(app))?;
    // Runtimes the user installed from the app win over whatever else is on PATH.
    let (rt_bins, extra_env) = runtimes::desktop_env(app);
    prepend.splice(0..0, rt_bins);
    let cwd = if std::env::var_os("PROMETHEUS_CWD").is_none() { app.path().home_dir().ok() } else { None };
    Ok(Launch { node, entry, env: node_env(prepend, append), extra_env, cwd })
}

#[cfg(target_os = "android")]
fn launch_target(app: &tauri::AppHandle) -> Result<Launch, String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let runtime = android::prepare(&data)?;
    let (home, tmp) = (data.join("home"), data.join("tmp"));
    // Prefer shared storage so the user can see the files; that needs "all files access", which the app asks for on first launch.
    let work = android::workspace_dir(&data);
    for d in [&home, &tmp, &work] {
        std::fs::create_dir_all(d).map_err(|e| format!("无法创建目录：{e}"))?;
    }
    let mut env: Vec<(&'static str, std::ffi::OsString)> = vec![
        ("HOME", home.into()),
        ("TMPDIR", tmp.into()),
        ("PROMETHEUS_HOME", data.join("prometheus").into()),
        ("PROMETHEUS_CWD", work.clone().into()),
        ("LD_LIBRARY_PATH", runtime.lib_dir.clone().into()),
    ];
    let rt_root = runtimes::root_dir(app)?;
    let guest_ids = runtimes::installed_guest_ids(app);
    env.extend(android::tool_env(&data, &runtime, &rt_root, &guest_ids));
    Ok(Launch { node: runtime.node, entry: runtime.entry, env, extra_env: Vec::new(), cwd: Some(work) })
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
        .envs(launch.extra_env.iter().map(|(k, v)| (k, v)))
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

    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("找不到 Node（node）：{e}。请安装 Node ≥ 22.19，或设置 PROMETHEUS_NODE 指向 node 的完整路径"),
        _ => format!("无法启动 Node（{node}）：{e}。请确认它是可执行的 Node ≥ 22.19，或设置 PROMETHEUS_NODE"),
    })?;
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

/// Opens an http(s) link in the system's default browser; anything else is refused.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) || url.chars().any(|c| c.is_control() || c == ' ') {
        return Err("only http(s) links can be opened".into());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", &url]);
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
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
            open_external,
            local_supported,
            runtimes::runtime_list,
            runtimes::runtime_install,
            runtimes::runtime_env,
            runtimes::runtime_install_msvc,
            runtimes::runtime_cancel,
            runtimes::runtime_uninstall,
            tray::set_close_to_tray,
            tray::show_main_window,
            tray::open_session_in_main,
        ]);
    #[cfg(mobile)]
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            start_local_backend,
            stop_local_backend,
            relaunch_app,
            local_supported,
            runtimes::runtime_list,
            runtimes::runtime_install,
            runtimes::runtime_env,
            runtimes::runtime_install_msvc,
            runtimes::runtime_cancel,
            runtimes::runtime_uninstall,
        ]);
    let app = builder
        .manage(backend.clone())
        .manage(runtimes::Installs::default())
        .build(tauri::generate_context!())
        .expect("failed to build Prometheus desktop");

    app.run(move |_, event| {
        if let RunEvent::Exit = event {
            backend.kill();
        }
    });
}

#[cfg(all(test, not(target_os = "android")))]
mod tests {
    use super::*;

    /// A unique empty scratch directory; the caller removes it.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prometheus-node-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fake_node(dir: &std::path::Path) -> PathBuf {
        let p = dir.join(NODE_EXE);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    /// Windows has no executable bit, so only the directory case is universal there.
    #[test]
    fn skips_directories_and_non_executables() {
        let root = scratch("skip");
        // A directory named node is never a candidate, on any platform.
        std::fs::create_dir_all(root.join("dir").join(NODE_EXE)).unwrap();
        let mut tried = Vec::new();
        let path = std::env::join_paths([root.join("dir")]).unwrap();
        assert_eq!(find_node_in(Some(path), &mut tried), None, "a directory is not a runtime");
        assert_eq!(tried.len(), 1);

        // Unix additionally rejects a file without the exec bit.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let plain = root.join("plain");
            std::fs::create_dir_all(&plain).unwrap();
            let file = plain.join(NODE_EXE);
            std::fs::write(&file, "not executable").unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            let mut tried = Vec::new();
            let path = std::env::join_paths([plain]).unwrap();
            assert!(!is_executable(&file));
            assert_eq!(find_node_in(Some(path), &mut tried), None);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn finds_node_further_down_the_path() {
        let root = scratch("found");
        let (empty, real) = (root.join("empty"), root.join("real"));
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        let node = fake_node(&real);
        let mut tried = Vec::new();
        let path = std::env::join_paths([empty, real]).unwrap();
        assert_eq!(find_node_in(Some(path), &mut tried), Some(node));
        assert_eq!(tried.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_path_is_not_a_panic() {
        assert_eq!(find_node_in(None, &mut Vec::new()), None);
    }

    #[test]
    fn node_env_none_without_dirs() {
        assert!(node_env(Vec::new(), Vec::new()).is_empty());
    }

    #[test]
    fn node_env_prepends_dirs_to_the_inherited_path() {
        let dirs = vec![PathBuf::from("/opt/homebrew/bin")];
        let env = node_env(dirs, vec![PathBuf::from("/bundled/bin")]);
        let path = env.iter().find(|(k, _)| *k == "PATH").map(|(_, v)| v.clone());
        let path = path.expect("PATH is set");
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, PathBuf::from("/opt/homebrew/bin"));
        assert_eq!(std::env::split_paths(&path).last().unwrap(), PathBuf::from("/bundled/bin"));
    }
}
