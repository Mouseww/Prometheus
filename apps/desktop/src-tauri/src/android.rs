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
