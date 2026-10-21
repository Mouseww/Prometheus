//! Android local mode: the APK carries a Node runtime and the server as native-library files
//! (the only place an app may execute from), and unpacks the server into app storage on first run.

use std::fs::{self, File};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;

/// Node, repackaged as a shared-library name so Gradle ships and extracts it.
const NODE_BIN: &str = "libnode.so";
/// The server tarball, also named like a library for the same reason.
const SERVER_ARCHIVE: &str = "libserver_bundle.so";
const APP_LIB: &str = "libprometheus_desktop_lib.so";

/// Where Android extracted our native libraries, found through this very library's mapping.
pub fn native_lib_dir() -> Option<PathBuf> {
    let maps = fs::read_to_string("/proc/self/maps").ok()?;
    maps.lines()
        .filter_map(|line| line.split_whitespace().last())
        .find(|path| path.ends_with(APP_LIB))
        .and_then(|path| Path::new(path).parent().map(Path::to_path_buf))
}

/// True when this APK was built with a Node runtime inside.
pub fn runtime_present() -> bool {
    native_lib_dir().is_some_and(|dir| dir.join(NODE_BIN).is_file() && dir.join(SERVER_ARCHIVE).is_file())
}

pub struct Runtime {
    pub node: PathBuf,
    pub entry: PathBuf,
    /// Shared libraries Node needs, shipped inside the server archive (a library directory cannot hold versioned names).
    pub lib_dir: PathBuf,
}

/// Unpacks the server into `data_dir/server` when it is missing or the APK changed, then returns what to launch.
pub fn prepare(data_dir: &Path) -> Result<Runtime, String> {
    let native = native_lib_dir().ok_or("找不到应用的原生库目录")?;
    let node = native.join(NODE_BIN);
    let archive = native.join(SERVER_ARCHIVE);
    if !node.is_file() || !archive.is_file() {
        return Err("此安装包未内置本机服务（Node 运行时缺失），请使用「连接服务器」".into());
    }

    let target = data_dir.join("server");
    let runtime = Runtime { node, entry: target.join("main.js"), lib_dir: target.join("lib") };
    // The archive size changes with every release, which is enough to know the unpacked copy is stale.
    let stamp = format!("{}:{}", env!("CARGO_PKG_VERSION"), fs::metadata(&archive).map(|m| m.len()).unwrap_or(0));
    let marker = target.join(".stamp");
    if runtime.entry.is_file() && fs::read_to_string(&marker).is_ok_and(|s| s == stamp) {
        return Ok(runtime);
    }

    // Unpack beside the target and rename, so an interrupted first run never leaves a half-written server behind.
    let staging = data_dir.join("server.new");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|e| format!("无法创建目录：{e}"))?;
    let file = File::open(&archive).map_err(|e| format!("无法读取内置服务包：{e}"))?;
    tar::Archive::new(GzDecoder::new(file))
        .unpack(&staging)
        .map_err(|e| format!("解压内置服务包失败：{e}"))?;
    fs::write(staging.join(".stamp"), &stamp).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(&target);
    fs::rename(&staging, &target).map_err(|e| format!("无法安装内置服务：{e}"))?;
    Ok(runtime)
}

/// Prefix for executables shipped as native libraries; `libexec_git.so` becomes `bin/git`.
const EXEC_PREFIX: &str = "libexec_";
/// Prefix for git's helper programs (`git-remote-https` and friends), linked into `git-core/`.
const GITCORE_PREFIX: &str = "libgitcore_";

/// Shared storage the user can browse. Only usable once "all files access" is granted, so probe by writing.
pub fn workspace_dir(data_dir: &Path) -> PathBuf {
    let shared = PathBuf::from("/storage/emulated/0/Prometheus");
    if fs::create_dir_all(&shared).is_ok() {
        let probe = shared.join(".write-test");
        if fs::write(&probe, b"").is_ok() {
            let _ = fs::remove_file(&probe);
            return shared;
        }
    }
    data_dir.join("workspace")
}

fn link(target: &Path, at: &Path) {
    let _ = fs::remove_file(at);
    let _ = std::os::unix::fs::symlink(target, at);
}

/// Android only runs files from the native-library directory, so every tool lives there under a `lib*.so` name.
/// The kernel resolves symlinks before the exec check, so links in app storage give them their real names
/// (`git`, `npm`, ...) and a PATH entry. Rebuilt on every launch: it is cheap and survives app updates that move the library directory.
fn link_tools(data_dir: &Path, native: &Path) -> (PathBuf, PathBuf) {
    let bin = data_dir.join("bin");
    let git_core = data_dir.join("git-core");
    for dir in [&bin, &git_core] {
        let _ = fs::remove_dir_all(dir);
        let _ = fs::create_dir_all(dir);
    }
    link(&native.join(NODE_BIN), &bin.join("node"));
    if let Ok(entries) = fs::read_dir(native) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = file.strip_suffix(".so") else { continue };
            if let Some(name) = stem.strip_prefix(EXEC_PREFIX) {
                link(&entry.path(), &bin.join(name));
            } else if let Some(name) = stem.strip_prefix(GITCORE_PREFIX) {
                link(&entry.path(), &git_core.join(name));
            }
        }
    }
    (bin, git_core)
}

/// Environment that makes the shipped tools (node, npm, git, bash, ...) usable from the server and from commands it runs.
pub fn tool_env(data_dir: &Path, runtime: &Runtime) -> Vec<(&'static str, std::ffi::OsString)> {
    use std::ffi::OsString;
    let Some(native) = native_lib_dir() else { return Vec::new() };
    let (bin, git_core) = link_tools(data_dir, &native);
    let server = runtime.entry.parent().map(Path::to_path_buf).unwrap_or_default();
    let cacert = server.join("etc/cacert.pem");
    let npm_cli = server.join("tools/npm/bin/npm-cli.js");
    let cache = data_dir.join("cache");
    let _ = fs::create_dir_all(&cache);
    let empty_templates = data_dir.join("git-templates");
    let _ = fs::create_dir_all(&empty_templates);

    let mut path = OsString::from(&bin);
    path.push(":/system/bin:/system/xbin");
    if let Some(old) = std::env::var_os("PATH") {
        path.push(":");
        path.push(old);
    }
    // bash when it was shipped, otherwise the system shell.
    let shell = if bin.join("bash").exists() { bin.join("bash") } else { PathBuf::from("/system/bin/sh") };

    let mut env: Vec<(&'static str, OsString)> = vec![
        ("PATH", path),
        ("SHELL", shell.into()),
        ("PROMETHEUS_NODE", runtime.node.clone().into()),
        ("PROMETHEUS_NPM_CLI", npm_cli.into()),
        ("PROMETHEUS_NPX_JS", server.join("tools/npx.mjs").into()),
        ("PROMETHEUS_TOOLS_BIN", bin.into()),
        // npm: keep its state in app storage and use the system shell for lifecycle scripts (there is no /bin/sh).
        ("npm_config_cache", cache.join("npm").into()),
        ("npm_config_prefix", data_dir.join("npm-global").into()),
        ("npm_config_script_shell", "/system/bin/sh".into()),
        ("npm_config_update_notifier", "false".into()),
        ("npm_config_fund", "false".into()),
        ("npm_config_audit", "false".into()),
        // git: the build's compiled-in Termux prefix does not exist here.
        ("GIT_EXEC_PATH", git_core.into()),
        ("GIT_TEMPLATE_DIR", empty_templates.into()),
        ("GIT_CONFIG_NOSYSTEM", "1".into()),
        ("GIT_TERMINAL_PROMPT", "0".into()),
        // The shared-storage workspace is owned by another uid and has no file modes.
        ("GIT_CONFIG_COUNT", "2".into()),
        ("GIT_CONFIG_KEY_0", "safe.directory".into()),
        ("GIT_CONFIG_VALUE_0", "*".into()),
        ("GIT_CONFIG_KEY_1", "core.fileMode".into()),
        ("GIT_CONFIG_VALUE_1", "false".into()),
    ];
    if cacert.is_file() {
        env.push(("GIT_SSL_CAINFO", cacert.clone().into()));
        env.push(("SSL_CERT_FILE", cacert.into()));
    }
    env
}
