//! On-demand language runtimes (Python, Go, Rust, Git, ...) installed after the app is, instead of shipped inside it.
//!
//! One pipeline for every platform: pick the manifest entry for this OS/arch, download it (mirrors, resume), verify
//! SHA-256, unpack or run its installer, check the result, and swap it into place. Progress and log lines reach the UI as
//! `runtime://progress` events, so a long install never looks like a hang. Desktop runs the result directly; Android
//! cannot execute downloaded files, so there the runtimes live inside a PRoot Ubuntu rootfs (see `android.rs`).

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST: &str = include_str!("../runtimes.json");
const CANCELLED: &str = "已取消";
const ROOTFS_ID: &str = "rootfs";
/// Pseudo runtime id used for progress events of the Visual Studio Build Tools install.
const MSVC_ID: &str = "msvc";

// ------------------------------------------------------------------ manifest

#[derive(Deserialize)]
struct Manifest {
    runtimes: Vec<Def>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Def {
    id: String,
    name: String,
    description: String,
    version: String,
    #[serde(default)]
    hidden: bool,
    /// Runtimes that must be installed first (only honoured where the runtime runs inside the guest rootfs).
    #[serde(default)]
    requires: Vec<String>,
    /// Shown instead of an install button when this platform has no target.
    #[serde(default)]
    hint: Option<String>,
    /// Executable names used to tell whether the system already provides this tool.
    #[serde(default)]
    probe: Vec<String>,
    /// Extra environment for desktop launches; `{dir}` is the install directory.
    #[serde(default)]
    env: HashMap<String, String>,
    targets: HashMap<String, Target>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
enum Format {
    #[serde(rename = "tar.gz")]
    TarGz,
    #[serde(rename = "zip")]
    Zip,
    /// A single installer program; it is run rather than unpacked.
    #[serde(rename = "exe")]
    Exe,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Target {
    /// Tried in order; a failing mirror falls through to the next.
    urls: Vec<String>,
    /// Pinned digest, or a URL of a checksum file to read it from.
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    sha256_url: Option<String>,
    #[serde(default)]
    size_mb: u64,
    format: Format,
    /// Leading path components dropped while unpacking (the archive's top-level directory).
    #[serde(default)]
    strip: usize,
    /// Directories (relative to the install dir, "" = the dir itself) that go on PATH.
    #[serde(default)]
    bin: Vec<String>,
    /// Installer arguments (format `exe`).
    #[serde(default)]
    run: Vec<String>,
    /// Debian packages installed in the guest afterwards (Android).
    #[serde(default)]
    guest_apt: Vec<String>,
    /// A file that must exist after install, relative to the install dir.
    check: String,
    /// The runtime compiles native code and needs a C linker from the system (MSVC, Xcode tools, cc).
    #[serde(default)]
    needs_linker: bool,
    /// Windows without Visual Studio build tools: install this instead and point Rust at it.
    #[serde(default)]
    gnu_fallback: Option<GnuFallback>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GnuFallback {
    /// Runtime that provides the linker (installed first).
    requires: String,
    /// rustup `--default-host` triple.
    host: String,
    /// Linker executable, relative to the `requires` runtime's install dir.
    linker: String,
    /// Cargo config file to write, relative to this runtime's install dir.
    config: String,
}

fn manifest() -> Result<Vec<Def>, String> {
    serde_json::from_str::<Manifest>(MANIFEST).map(|m| m.runtimes).map_err(|e| format!("runtimes.json 无效：{e}"))
}

fn find_def(id: &str) -> Result<Def, String> {
    manifest()?.into_iter().find(|d| d.id == id).ok_or_else(|| format!("未知的运行环境：{id}"))
}

fn is_android() -> bool {
    cfg!(target_os = "android")
}

fn target_key() -> String {
    let os = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "linux"
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// The target for this platform, and whether it lives in the guest rootfs. On Android the ordinary
/// `linux-aarch64` builds are used inside the Ubuntu rootfs; only the rootfs itself has an `android-*` entry.
fn pick(def: &Def) -> Option<(&Target, bool)> {
    let key = target_key();
    if let Some(t) = def.targets.get(&key) {
        return Some((t, false));
    }
    if is_android() && def.id != ROOTFS_ID {
        return def.targets.get("linux-aarch64").map(|t| (t, true));
    }
    None
}

// --------------------------------------------------------------------- paths

pub fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = if is_android() { app.path().app_data_dir() } else { app.path().app_local_data_dir() };
    Ok(base.map_err(|e| e.to_string())?.join("runtimes"))
}

/// Where the rootfs is unpacked (Android).
pub fn rootfs_dir(root: &Path) -> PathBuf {
    root.join(ROOTFS_ID).join("root")
}

/// Where a runtime's files live. Guest runtimes sit under the rootfs' /opt so PRoot sees them as /opt/<id>.
fn payload_dir(root: &Path, id: &str, guest: bool) -> PathBuf {
    if id == ROOTFS_ID {
        rootfs_dir(root)
    } else if guest {
        rootfs_dir(root).join("opt").join(id)
    } else {
        root.join(id).join("current")
    }
}

fn marker_path(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("installed.json")
}

#[derive(Serialize, Deserialize)]
struct Marker {
    version: String,
    /// Free-form remark shown in the UI (e.g. which ABI a Rust install uses).
    #[serde(default)]
    note: Option<String>,
}

fn installed_note(root: &Path, id: &str) -> Option<String> {
    let marker: Marker = serde_json::from_str(&fs::read_to_string(marker_path(root, id)).ok()?).ok()?;
    marker.note
}

/// The installed version, only if the files are really there (a half-deleted tree does not count).
fn installed_version(root: &Path, def: &Def) -> Option<String> {
    let (target, guest) = pick(def)?;
    let marker: Marker = serde_json::from_str(&fs::read_to_string(marker_path(root, &def.id)).ok()?).ok()?;
    payload_dir(root, &def.id, guest).join(&target.check).exists().then_some(marker.version)
}

// -------------------------------------------------------------------- events

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    id: String,
    /// prepare | download | verify | extract | setup | apt | finish
    stage: &'static str,
    message: String,
    done: u64,
    total: u64,
    /// Bytes per second (downloads).
    speed: u64,
    /// Set on the last event of an install.
    finished: bool,
    ok: bool,
    error: Option<String>,
    /// A log line (no progress change).
    line: Option<String>,
}

#[derive(Clone)]
struct Emitter2 {
    app: AppHandle,
    id: String,
    last: Arc<Mutex<Instant>>,
}

impl Emitter2 {
    fn new(app: &AppHandle, id: &str) -> Self {
        Self { app: app.clone(), id: id.into(), last: Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1))) }
    }

    fn base(&self, stage: &'static str) -> Progress {
        Progress { id: self.id.clone(), stage, message: String::new(), done: 0, total: 0, speed: 0, finished: false, ok: false, error: None, line: None }
    }

    fn send(&self, p: Progress) {
        let _ = self.app.emit("runtime://progress", p);
    }

    /// Progress update, throttled so a fast unpack does not flood the webview.
    fn progress(&self, stage: &'static str, message: &str, done: u64, total: u64, speed: u64) {
        {
            let mut last = self.last.lock().unwrap();
            if last.elapsed() < Duration::from_millis(120) {
                return;
            }
            *last = Instant::now();
        }
        self.stage(stage, message, done, total, speed);
    }

    /// Unthrottled: stage changes must always arrive.
    fn stage(&self, stage: &'static str, message: &str, done: u64, total: u64, speed: u64) {
        self.send(Progress { message: message.into(), done, total, speed, ..self.base(stage) });
    }

    fn log(&self, line: impl Into<String>) {
        let line = line.into();
        eprintln!("[runtime:{}] {line}", self.id);
        self.send(Progress { line: Some(line), ..self.base("log") });
    }

    fn finish(&self, result: &Result<(), String>) {
        self.send(Progress { finished: true, ok: result.is_ok(), error: result.as_ref().err().cloned(), ..self.base("finish") });
    }
}

// -------------------------------------------------------------------- helpers

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// First 64-hex-digit token in a checksum file ("<hash>", "<hash>  name" and "<hash> *name" all work).
fn parse_sha(text: &str) -> Option<String> {
    text.split_whitespace()
        .map(|w| w.trim_start_matches('*'))
        .find(|w| w.len() == 64 && w.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|w| w.to_ascii_lowercase())
}

/// Drops `strip` leading components. `Ok(None)` = nothing left (the stripped directory itself).
fn strip_path(p: &Path, strip: usize) -> Result<Option<PathBuf>, String> {
    let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
    for c in p.components() {
        match c {
            Component::Normal(s) => parts.push(s),
            Component::CurDir | Component::RootDir | Component::Prefix(_) => {}
            Component::ParentDir => return Err(format!("压缩包含有越界路径：{}", p.display())),
        }
    }
    if parts.len() <= strip {
        return Ok(None);
    }
    Ok(Some(parts[strip..].iter().collect()))
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32, dir: bool) {
    use std::os::unix::fs::PermissionsExt;
    // Owner must always be able to write and traverse, or later steps (and uninstall) fail.
    let mode = if dir { mode | 0o755 } else { mode | 0o200 };
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn set_mode(_: &Path, _: u32, _: bool) {}

/// Removes a directory tree, including read-only files (Windows refuses otherwise).
fn remove_tree(p: &Path) -> std::io::Result<()> {
    if !p.exists() {
        return Ok(());
    }
    match fs::remove_dir_all(p) {
        Ok(()) => Ok(()),
        Err(_) => {
            fn unlock(p: &Path) {
                if let Ok(rd) = fs::read_dir(p) {
                    for e in rd.flatten() {
                        let path = e.path();
                        if let Ok(m) = fs::symlink_metadata(&path) {
                            let mut perm = m.permissions();
                            #[allow(clippy::permissions_set_readonly_false)]
                            perm.set_readonly(false);
                            let _ = fs::set_permissions(&path, perm);
                            if m.is_dir() {
                                unlock(&path);
                            }
                        }
                    }
                }
            }
            unlock(p);
            fs::remove_dir_all(p)
        }
    }
}

struct Counting<R> {
    inner: R,
    read: Arc<AtomicU64>,
}

impl<R: Read> Read for Counting<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

// ---------------------------------------------------------------- extraction

fn extract_tar_gz(file: &Path, out: &Path, strip: usize, em: &Emitter2, cancel: &AtomicBool) -> Result<(), String> {
    let f = File::open(file).map_err(|e| format!("无法读取安装包：{e}"))?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let read = Arc::new(AtomicU64::new(0));
    let gz = flate2::read::GzDecoder::new(Counting { inner: BufReader::new(f), read: read.clone() });
    let mut archive = tar::Archive::new(gz);
    for entry in archive.entries().map_err(|e| format!("安装包已损坏：{e}"))? {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let mut entry = entry.map_err(|e| format!("安装包已损坏：{e}"))?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        let Some(rel) = strip_path(&path, strip)? else { continue };
        let dest = out.join(&rel);
        let mode = entry.header().mode().unwrap_or(0o644);
        use tar::EntryType as T;
        match entry.header().entry_type() {
            T::Directory => {
                fs::create_dir_all(&dest).map_err(|e| format!("{}：{e}", rel.display()))?;
                set_mode(&dest, mode, true);
            }
            T::Regular | T::Continuous | T::GNUSparse => {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                // Never write through a link that is already there.
                if fs::symlink_metadata(&dest).is_ok_and(|m| m.file_type().is_symlink()) {
                    let _ = fs::remove_file(&dest);
                }
                let mut f = File::create(&dest).map_err(|e| format!("{}：{e}", rel.display()))?;
                std::io::copy(&mut entry, &mut f).map_err(|e| format!("{}：{e}", rel.display()))?;
                drop(f);
                set_mode(&dest, mode, false);
            }
            T::Symlink => {
                let link = entry.link_name().map_err(|e| e.to_string())?.ok_or("符号链接缺少目标")?.into_owned();
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                let _ = fs::remove_file(&dest);
                #[cfg(unix)]
                std::os::unix::fs::symlink(&link, &dest).map_err(|e| format!("{}：{e}", rel.display()))?;
                #[cfg(not(unix))]
                let _ = link;
            }
            // Hard links are refused on Android's app storage, and unneeded elsewhere: copy the file instead.
            T::Link => {
                let target = entry.link_name().map_err(|e| e.to_string())?.ok_or("硬链接缺少目标")?.into_owned();
                if let Some(src) = strip_path(&target, strip)? {
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    let _ = fs::remove_file(&dest);
                    fs::copy(out.join(src), &dest).map_err(|e| format!("{}：{e}", rel.display()))?;
                    set_mode(&dest, mode, false);
                }
            }
            _ => {}
        }
        em.progress("extract", &rel.to_string_lossy(), read.load(Ordering::Relaxed), total, 0);
    }
    Ok(())
}

fn extract_zip(file: &Path, out: &Path, strip: usize, em: &Emitter2, cancel: &AtomicBool) -> Result<(), String> {
    let f = File::open(file).map_err(|e| format!("无法读取安装包：{e}"))?;
    let mut zip = zip::ZipArchive::new(BufReader::new(f)).map_err(|e| format!("安装包已损坏：{e}"))?;
    let total = zip.len() as u64;
    for i in 0..zip.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let mut entry = zip.by_index(i).map_err(|e| format!("安装包已损坏：{e}"))?;
        let Some(name) = entry.enclosed_name() else { return Err(format!("压缩包含有越界路径：{}", entry.name())) };
        let Some(rel) = strip_path(&name, strip)? else { continue };
        let dest = out.join(&rel);
        if entry.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| format!("{}：{e}", rel.display()))?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut f = File::create(&dest).map_err(|e| format!("{}：{e}", rel.display()))?;
            std::io::copy(&mut entry, &mut f).map_err(|e| format!("{}：{e}", rel.display()))?;
            drop(f);
            if let Some(mode) = entry.unix_mode() {
                set_mode(&dest, mode, false);
            }
        }
        em.progress("extract", &rel.to_string_lossy(), i as u64 + 1, total, 0);
    }
    Ok(())
}

// ------------------------------------------------------------------ download

fn client() -> Result<reqwest::Client, String> {
    // reqwest is built without a bundled TLS backend; install the ring provider once (a second install is a harmless Err).
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = reqwest::Client::builder().user_agent(concat!("Prometheus/", env!("CARGO_PKG_VERSION"))).connect_timeout(Duration::from_secs(15));
    // rustls-platform-verifier needs a JNI setup that Tauri does not do on Android (it aborts the process), so
    // trust the system's own CA directory directly instead.
    #[cfg(target_os = "android")]
    let builder = {
        let certs = android_ca_certs();
        if certs.is_empty() {
            return Err("读取不到系统的 CA 证书，无法建立 HTTPS 连接".into());
        }
        builder.tls_certs_only(certs)
    };
    builder.build().map_err(|e| e.to_string())
}

/// Certificates from Android's trust store (the conscrypt APEX on new releases, /system on older ones). The files are PEM
/// (with a text dump after the block). reqwest only parses certificates when it builds the client, where a single bad one
/// fails everything with a bare "builder error", so each one is checked here and bad ones are dropped.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn android_ca_certs() -> Vec<reqwest::Certificate> {
    certs_from_dirs(&["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"])
}

fn certs_from_dirs(dirs: &[&str]) -> Vec<reqwest::Certificate> {
    use rustls_pki_types::{pem::PemObject, CertificateDer};
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        let mut store = rustls::RootCertStore::empty();
        let mut certs = Vec::new();
        for entry in entries.flatten() {
            let Ok(bytes) = fs::read(entry.path()) else { continue };
            let ders: Vec<CertificateDer<'static>> = if bytes.starts_with(b"-----") || bytes.windows(10).any(|w| w == b"-----BEGIN") {
                CertificateDer::pem_slice_iter(&bytes).flatten().collect()
            } else {
                vec![CertificateDer::from(bytes)]
            };
            for der in ders {
                if store.add(der.clone()).is_ok() {
                    if let Ok(c) = reqwest::Certificate::from_der(der.as_ref()) {
                        certs.push(c);
                    }
                }
            }
        }
        if !certs.is_empty() {
            return certs;
        }
    }
    Vec::new()
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let res = client.get(url).timeout(Duration::from_secs(30)).send().await.map_err(|e| format!("{url}：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}：HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

async fn expected_sha(client: &reqwest::Client, target: &Target) -> Result<String, String> {
    if let Some(sha) = &target.sha256 {
        return Ok(sha.to_ascii_lowercase());
    }
    let url = target.sha256_url.as_deref().ok_or("清单缺少校验值")?;
    let text = fetch_text(client, url).await?;
    parse_sha(&text).ok_or_else(|| format!("无法解析校验文件：{url}"))
}

/// Streams one URL into `part`, resuming when a partial file exists.
async fn download_one(
    client: &reqwest::Client,
    url: &str,
    part: &Path,
    em: &Emitter2,
    cancel: &AtomicBool,
) -> Result<(), String> {
    use futures_util::StreamExt;
    let have = fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let mut req = client.get(url);
    if have > 0 {
        req = req.header("Range", format!("bytes={have}-"));
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    // 416: the partial file already covers the whole thing; verification decides whether it is good.
    if status.as_u16() == 416 {
        return Ok(());
    }
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let resumed = status.as_u16() == 206;
    let start = if resumed { have } else { 0 };
    let total = res.content_length().map(|n| n + start).unwrap_or(0);
    let mut file = if resumed {
        fs::OpenOptions::new().append(true).open(part).map_err(|e| e.to_string())?
    } else {
        File::create(part).map_err(|e| e.to_string())?
    };
    let began = Instant::now();
    let mut got = 0u64;
    let mut stream = res.bytes_stream();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        // A silent connection must not hang the install forever.
        let next = tokio::time::timeout(Duration::from_secs(30), stream.next()).await.map_err(|_| "下载停滞（30 秒无数据）".to_string())?;
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| format!("写入失败（磁盘已满？）：{e}"))?;
        got += chunk.len() as u64;
        let secs = began.elapsed().as_secs_f64().max(0.001);
        em.progress("download", url, start + got, total, (got as f64 / secs) as u64);
    }
    if total > 0 && start + got < total {
        return Err("连接中断".into());
    }
    Ok(())
}

async fn download(client: &reqwest::Client, target: &Target, part: &Path, em: &Emitter2, cancel: &AtomicBool) -> Result<(), String> {
    let mut last = String::new();
    for url in &target.urls {
        em.stage("download", url, 0, 0, 0);
        em.log(format!("下载 {url}"));
        match download_one(client, url, part, em, cancel).await {
            Ok(()) => return Ok(()),
            Err(e) if e == CANCELLED => return Err(e),
            Err(e) => {
                em.log(format!("该源失败：{e}"));
                last = e;
            }
        }
    }
    Err(format!("所有下载源均失败：{last}"))
}

fn sha_of_file(path: &Path, em: &Emitter2, cancel: &AtomicBool) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let total = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    let mut done = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        done += n as u64;
        em.progress("verify", "", done, total, 0);
    }
    Ok(hex(&hasher.finalize()))
}

// ------------------------------------------------------------ running programs

/// Runs a prepared command, forwarding its output lines as log events; kills it on cancel.
fn run_logged(mut cmd: std::process::Command, em: &Emitter2, cancel: &AtomicBool, what: &str) -> Result<(), String> {
    use std::sync::mpsc;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法运行{what}：{e}"))?;
    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || pump(out, tx)));
    }
    if let Some(err) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || pump(err, tx)));
    }
    drop(tx);
    let mut tail: Vec<String> = Vec::new();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                em.log(line.clone());
                tail.push(line);
                if tail.len() > 8 {
                    tail.remove(0);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break child.wait().map_err(|e| e.to_string())?,
        }
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(CANCELLED.into());
        }
    };
    for r in readers {
        let _ = r.join();
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("{what}失败（{status}）：{}", tail.join(" | ")))
    }
}

/// Reads lines, treating `\r` as a line end too (installers redraw progress bars with it).
fn pump<R: Read>(mut r: R, tx: std::sync::mpsc::Sender<String>) {
    let mut buf = [0u8; 4096];
    let mut line = Vec::new();
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if b == b'\n' || b == b'\r' {
                if !line.is_empty() {
                    let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
                    line.clear();
                }
            } else {
                line.push(b);
            }
        }
    }
    if !line.is_empty() {
        let _ = tx.send(String::from_utf8_lossy(&line).trim().to_string());
    }
}

fn expand(value: &str, dir: &str) -> String {
    value.replace("{dir}", dir)
}

// ------------------------------------------------------------ native linkers

/// Keeps probe processes from flashing a console window on Windows.
fn quiet(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// Visual Studio (or Build Tools) with the C++ tools, which is what rustc's MSVC target links with.
#[cfg(windows)]
fn has_msvc() -> bool {
    let Some(pf) = std::env::var_os("ProgramFiles(x86)").or_else(|| std::env::var_os("ProgramFiles")) else { return false };
    let vswhere = PathBuf::from(pf).join("Microsoft Visual Studio/Installer/vswhere.exe");
    if !vswhere.is_file() {
        return false;
    }
    let component = if cfg!(target_arch = "aarch64") { "Microsoft.VisualStudio.Component.VC.Tools.ARM64" } else { "Microsoft.VisualStudio.Component.VC.Tools.x86.x64" };
    let mut cmd = std::process::Command::new(vswhere);
    cmd.args(["-latest", "-products", "*", "-requires", component, "-property", "installationPath"]);
    quiet(&mut cmd).output().map(|o| o.status.success() && !String::from_utf8_lossy(&o.stdout).trim().is_empty()).unwrap_or(false)
}

#[cfg(not(windows))]
fn has_msvc() -> bool {
    false
}

/// macOS: Xcode or the Command Line Tools are selected.
fn has_clt() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let mut cmd = std::process::Command::new("xcode-select");
    cmd.arg("-p");
    quiet(&mut cmd).output().map(|o| o.status.success() && Path::new(String::from_utf8_lossy(&o.stdout).trim()).exists()).unwrap_or(false)
}

fn has_cc() -> bool {
    find_on_path(&["cc".into(), "gcc".into(), "clang".into()]).is_some()
}

fn has_winget() -> bool {
    cfg!(windows) && find_on_path(&["winget".into()]).is_some()
}

/// What to tell the user about the linker before (or after) installing `def`; None when nothing is wrong.
fn linker_notice(root: &Path, def: &Def, target: &Target, guest: bool) -> Option<Notice> {
    if !target.needs_linker || guest {
        return None;
    }
    let warn = |text: &str| Some(Notice { level: "warn", text: text.into() });
    let info = |text: &str| Some(Notice { level: "info", text: text.into() });
    if cfg!(windows) {
        if let Some(note) = installed_note(root, &def.id) {
            return info(&note);
        }
        if has_msvc() {
            return None;
        }
        return if let Some(g) = &target.gnu_fallback {
            let mb = find_def(&g.requires).ok().and_then(|d| pick(&d).map(|(t, _)| t.size_mb)).unwrap_or(0);
            info(&format!(
                "未检测到 Visual Studio 生成工具。安装时会改用 GNU 工具链（额外下载 llvm-mingw，约 {mb} MB），产物是 GNU ABI；依赖 MSVC 专用库的 crate 可能编译失败。需要 MSVC 时请先安装“VS 生成工具”，再重新安装 Rust。"
            ))
        } else {
            warn("未检测到 Visual Studio 生成工具（C++ 工作负载），cargo 链接时会失败。")
        };
    }
    if cfg!(target_os = "macos") {
        return if has_clt() { None } else { warn("未检测到 Xcode 命令行工具。安装时会弹出系统的安装窗口，请在窗口里点“安装”，应用会等待它完成。") };
    }
    if has_cc() { None } else { warn("未找到 C 编译器（cc / gcc / clang），cargo 链接时会失败。请先用包管理器安装，例如 sudo apt install build-essential。") }
}

/// macOS: trigger the system installer for the Command Line Tools and wait until it finishes. It cannot run silently
/// or report progress, so the UI only gets a "waiting" message.
async fn ensure_clt(em: &Emitter2, cancel: &AtomicBool) -> Result<(), String> {
    if has_clt() {
        return Ok(());
    }
    em.log("未检测到 Xcode 命令行工具，正在调用 xcode-select --install ...");
    let mut cmd = std::process::Command::new("xcode-select");
    cmd.arg("--install");
    // Exits non-zero when an install is already pending; that is fine, we just wait for it.
    let _ = quiet(&mut cmd).output();
    em.stage("setup", "等待系统安装命令行工具（请在弹出的窗口里点“安装”）", 0, 0, 0);
    let started = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        if has_clt() {
            em.log("命令行工具已就绪");
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(45 * 60) {
            return Err("等待命令行工具安装超时。请手动运行 xcode-select --install，装好后重试".into());
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// How Rust should be installed on a Windows machine without MSVC: the host triple and where to write the linker config.
struct GnuPlan {
    host: String,
    linker: PathBuf,
    config: String,
}

fn toml_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Runs before the main install: makes sure the system can link what will be compiled.
async fn prepare_linker(app: &AppHandle, def: &Def, root: &Path, em: &Emitter2, cancel: &Arc<AtomicBool>) -> Result<Option<GnuPlan>, String> {
    let Some((target, guest)) = pick(def) else { return Ok(None) };
    if !target.needs_linker || guest {
        return Ok(None);
    }
    if cfg!(windows) {
        if has_msvc() {
            em.log("检测到 Visual Studio 生成工具，使用 MSVC 工具链");
            return Ok(None);
        }
        let Some(g) = &target.gnu_fallback else {
            em.log("警告：未检测到 Visual Studio 生成工具，cargo 链接时会失败");
            return Ok(None);
        };
        em.log("未检测到 Visual Studio 生成工具，改用 GNU 工具链（llvm-mingw）");
        let dep = find_def(&g.requires)?;
        if installed_version(root, &dep).is_none() {
            install_one(app, &dep, None, None, em, cancel).await?;
        }
        return Ok(Some(GnuPlan { host: g.host.clone(), linker: payload_dir(root, &dep.id, false).join(&g.linker), config: g.config.clone() }));
    }
    if cfg!(target_os = "macos") {
        ensure_clt(em, cancel).await?;
    } else if !has_cc() {
        em.log("警告：未找到 C 编译器（cc / gcc / clang），cargo 链接时会失败。请先用包管理器安装，例如 sudo apt install build-essential");
    }
    Ok(None)
}

/// Points cargo at the MinGW linker for the GNU target.
fn write_gnu_config(dest: &Path, plan: &GnuPlan) -> Result<(), String> {
    let path = dest.join(&plan.config);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = format!("[target.{}]
linker = \"{}\"
", plan.host, toml_path(&plan.linker));
    fs::write(&path, body).map_err(|e| format!("无法写入 {}：{e}", path.display()))
}

// --------------------------------------------------------------- the pipeline

async fn install_one(
    app: &AppHandle,
    def: &Def,
    local: Option<PathBuf>,
    gnu: Option<GnuPlan>,
    em: &Emitter2,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let (target, guest) = pick(def).ok_or_else(|| def.hint.clone().unwrap_or_else(|| format!("{} 暂不支持当前平台（{}）", def.name, target_key())))?;
    let mut target = target.clone();
    if let Some(p) = &gnu {
        target.run.extend(["--default-host".to_string(), p.host.clone()]);
    }
    let root = root_dir(app)?;
    let dest = payload_dir(&root, &def.id, guest);
    let work = root.join(&def.id);
    fs::create_dir_all(&work).map_err(|e| format!("无法创建目录 {}：{e}", work.display()))?;
    let cache = root.join(".cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;

    em.stage("prepare", &def.name, 0, 0, 0);
    let client = client()?;
    let expected = expected_sha(&client, &target).await?;
    let file_name = format!("{}-{}-{}", def.id, def.version, target_key());
    let archive = cache.join(&file_name);

    // 1. Get the file: an offline package, a cached verified download, or a fresh (resumable) download.
    let source = match &local {
        Some(p) => p.clone(),
        None => archive.clone(),
    };
    let mut have_good = false;
    if source.is_file() {
        let (s, e, c) = (source.clone(), em.clone(), cancel.clone());
        let sha = tauri::async_runtime::spawn_blocking(move || sha_of_file(&s, &e, &c)).await.map_err(|e| e.to_string())??;
        have_good = sha == expected;
        if !have_good && local.is_some() {
            return Err("离线包的 SHA-256 与清单不符，文件不是这个版本的安装包".into());
        }
    }
    if !have_good {
        let part = cache.join(format!("{file_name}.part"));
        download(&client, &target, &part, em, cancel).await?;
        let (p, e, c) = (part.clone(), em.clone(), cancel.clone());
        let sha = tauri::async_runtime::spawn_blocking(move || sha_of_file(&p, &e, &c)).await.map_err(|e| e.to_string())??;
        if sha != expected {
            let _ = fs::remove_file(&part);
            return Err(format!("校验失败：下载内容的 SHA-256 为 {sha}，应为 {expected}。已丢弃，请重试"));
        }
        fs::rename(&part, &archive).map_err(|e| e.to_string())?;
    }
    let source = if local.is_some() { source } else { archive.clone() };

    // 2. Unpack into a staging directory, or run the installer.
    let staging = work.join("staging");
    let result = match target.format {
        Format::TarGz | Format::Zip => {
            let (src, out, strip, fmt, e, c) = (source.clone(), staging.clone(), target.strip, target.format, em.clone(), cancel.clone());
            tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
                remove_tree(&out).map_err(|e| e.to_string())?;
                fs::create_dir_all(&out).map_err(|e| e.to_string())?;
                e.stage("extract", "", 0, 0, 0);
                if fmt == Format::Zip { extract_zip(&src, &out, strip, &e, &c) } else { extract_tar_gz(&src, &out, strip, &e, &c) }
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Format::Exe => Ok(()),
    };
    if let Err(e) = result {
        let _ = remove_tree(&staging);
        return Err(e);
    }

    match target.format {
        Format::TarGz | Format::Zip => {
            // Atomic-ish swap: the old tree goes away only once the new one is complete.
            if !staging.join(&target.check).exists() {
                let _ = remove_tree(&staging);
                return Err(format!("解压完成但缺少 {}，安装包可能不完整", target.check));
            }
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            remove_tree(&dest).map_err(|e| format!("无法替换旧版本（文件被占用？）：{e}"))?;
            fs::rename(&staging, &dest).map_err(|e| format!("无法完成安装：{e}"))?;
            if def.id == ROOTFS_ID {
                prepare_rootfs(&dest)?;
            }
        }
        Format::Exe => {
            em.stage("setup", &def.name, 0, 0, 0);
            remove_tree(&dest).map_err(|e| format!("无法替换旧版本（文件被占用？）：{e}"))?;
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            let r = run_installer(app, def, &target, guest, &source, &root, &dest, em, cancel).and_then(|()| match &gnu {
                Some(p) => write_gnu_config(&dest, p),
                None => Ok(()),
            });
            if let Err(e) = r {
                let _ = remove_tree(&dest);
                return Err(e);
            }
        }
    }

    if guest && !target.guest_apt.is_empty() {
        em.stage("apt", &target.guest_apt.join(" "), 0, 0, 0);
        if let Err(e) = guest_apt(app, &root, &target.guest_apt, em, cancel) {
            let _ = remove_tree(&dest);
            return Err(e);
        }
    }

    if !dest.join(&target.check).exists() {
        let _ = remove_tree(&dest);
        return Err(format!("安装后缺少 {}，已回滚", target.check));
    }
    let marker = serde_json::to_string(&Marker {
        version: def.version.clone(),
        note: gnu.as_ref().map(|p| format!("当前是 GNU 工具链（{}，链接器 llvm-mingw）。依赖 MSVC 专用库的 crate 可能编译失败；装好“VS 生成工具”后重新安装 Rust 即可切换到 MSVC。", p.host)),
    }).map_err(|e| e.to_string())?;
    fs::write(marker_path(&root, &def.id), marker).map_err(|e| e.to_string())?;
    // The archive has served its purpose; an offline package belongs to the user and stays.
    if local.is_none() {
        let _ = fs::remove_file(&archive);
    }
    Ok(())
}

/// Files the unpacked Ubuntu base needs before anything runs inside it under PRoot.
fn prepare_rootfs(rootfs: &Path) -> Result<(), String> {
    let w = |rel: &str, body: &str| -> Result<(), String> {
        let p = rootfs.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let _ = fs::remove_file(&p);
        fs::write(&p, body).map_err(|e| format!("{rel}：{e}"))
    };
    for d in ["root", "tmp", "opt", "proc", "sys", "dev", "etc/ssl/certs"] {
        fs::create_dir_all(rootfs.join(d)).map_err(|e| e.to_string())?;
    }
    set_mode(&rootfs.join("tmp"), 0o1777, true);
    w("etc/resolv.conf", "nameserver 223.5.5.5\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n")?;
    // apt drops to the `_apt` user for downloads, which PRoot's fake root cannot do.
    w("etc/apt/apt.conf.d/99prometheus", "APT::Sandbox::User \"root\";\nAPT::Install-Recommends \"false\";\n")?;
    // Bind-mount target for the app's CA bundle (see android::guest_command).
    w("etc/ssl/certs/ca-certificates.crt", "")?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run_installer(
    app: &AppHandle,
    def: &Def,
    target: &Target,
    guest: bool,
    installer: &Path,
    root: &Path,
    dest: &Path,
    em: &Emitter2,
    cancel: &AtomicBool,
) -> Result<(), String> {
    let _ = app;
    if guest {
        #[cfg(target_os = "android")]
        {
            let rootfs = rootfs_dir(root);
            let in_guest = format!("/tmp/{}-installer", def.id);
            let host_copy = rootfs.join(in_guest.trim_start_matches('/'));
            fs::copy(installer, &host_copy).map_err(|e| format!("无法复制安装器：{e}"))?;
            set_mode(&host_copy, 0o755, false);
            let guest_dir = format!("/opt/{}", def.id);
            let env: Vec<(String, String)> = def.env.iter().map(|(k, v)| (k.clone(), expand(v, &guest_dir))).collect();
            let mut args = vec![in_guest];
            args.extend(target.run.iter().cloned());
            let cmd = crate::android::guest_command(app, root, &args, &env)?;
            let r = run_logged(cmd, em, cancel, &def.name);
            let _ = fs::remove_file(host_copy);
            return r;
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (root, em, cancel);
            return Err("此平台不支持在 guest 里安装".into());
        }
    }
    let copy = dest.join(if cfg!(windows) { "installer.exe" } else { "installer" });
    fs::copy(installer, &copy).map_err(|e| format!("无法复制安装器：{e}"))?;
    set_mode(&copy, 0o755, false);
    let mut cmd = std::process::Command::new(&copy);
    cmd.args(&target.run).current_dir(dest);
    let dir = dest.to_string_lossy().into_owned();
    for (k, v) in &def.env {
        cmd.env(k, expand(v, &dir));
    }
    let r = run_logged(cmd, em, cancel, &def.name);
    // The installer binary is not part of the runtime.
    let _ = fs::remove_file(&copy);
    r
}

#[cfg(target_os = "android")]
fn guest_apt(app: &AppHandle, root: &Path, packages: &[String], em: &Emitter2, cancel: &AtomicBool) -> Result<(), String> {
    let env = vec![("DEBIAN_FRONTEND".to_string(), "noninteractive".to_string())];
    let update: Vec<String> = ["apt-get", "update"].map(String::from).to_vec();
    run_logged(crate::android::guest_command(app, root, &update, &env)?, em, cancel, "apt-get update")?;
    let mut install: Vec<String> = ["apt-get", "install", "-y", "--no-install-recommends"].map(String::from).to_vec();
    install.extend(packages.iter().cloned());
    run_logged(crate::android::guest_command(app, root, &install, &env)?, em, cancel, "apt-get install")
}

#[cfg(not(target_os = "android"))]
fn guest_apt(_: &AppHandle, _: &Path, _: &[String], _: &Emitter2, _: &AtomicBool) -> Result<(), String> {
    Err("此平台不支持在 guest 里安装".into())
}

async fn install(app: AppHandle, id: String, local: Option<PathBuf>, cancel: Arc<AtomicBool>) -> Result<(), String> {
    let em = Emitter2::new(&app, &id);
    let def = find_def(&id)?;
    let root = root_dir(&app)?;
    let (_, guest) = pick(&def).ok_or_else(|| def.hint.clone().unwrap_or_else(|| format!("{} 暂不支持当前平台（{}）", def.name, target_key())))?;
    if guest {
        for dep in &def.requires {
            let dep_def = find_def(dep)?;
            if installed_version(&root, &dep_def).is_none() {
                em.log(format!("先安装依赖：{}", dep_def.name));
                install_one(&app, &dep_def, None, None, &em, &cancel).await?;
            }
        }
    }
    let gnu = prepare_linker(&app, &def, &root, &em, &cancel).await?;
    install_one(&app, &def, local, gnu, &em, &cancel).await
}

// ------------------------------------------------------------------ commands

#[derive(Default)]
pub struct Installs(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    id: String,
    name: String,
    description: String,
    version: String,
    size_mb: u64,
    installed: Option<String>,
    supported: bool,
    hint: Option<String>,
    installing: bool,
    /// Path of a same-purpose tool already on PATH.
    system: Option<String>,
    /// Linker situation (missing MSVC / Xcode tools / cc), shown under the runtime.
    notice: Option<Notice>,
    /// Windows: the "install Visual Studio Build Tools" button makes sense for this runtime.
    msvc_installable: bool,
}

#[derive(Serialize)]
pub struct Notice {
    /// info | warn
    level: &'static str,
    text: String,
}

fn find_on_path(names: &[String]) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidates = if cfg!(windows) { vec![format!("{name}.exe")] } else { vec![name.clone()] };
            for c in candidates {
                let p = dir.join(&c);
                // Windows ships "App execution alias" stubs for python that only open the Store; they are not a Python.
                if p.is_file() && !p.to_string_lossy().contains("WindowsApps") {
                    return Some(p.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn runtime_list(app: AppHandle, state: tauri::State<'_, Installs>) -> Result<Vec<Info>, String> {
    let root = root_dir(&app)?;
    let running = state.0.lock().unwrap();
    Ok(manifest()?
        .into_iter()
        .filter(|d| !d.hidden)
        .map(|d| {
            let picked = pick(&d);
            Info {
                installed: installed_version(&root, &d),
                supported: picked.is_some(),
                size_mb: picked.map(|(t, _)| t.size_mb).unwrap_or(0),
                hint: if picked.is_none() { d.hint.clone() } else { None },
                installing: running.contains_key(&d.id),
                // On Android the tool shims always resolve to us, so only desktop probes the system.
                system: if is_android() { None } else { find_on_path(&d.probe) },
                notice: picked.and_then(|(t, g)| linker_notice(&root, &d, t, g)),
                msvc_installable: picked.is_some_and(|(t, g)| t.needs_linker && !g) && has_winget() && !has_msvc(),
                id: d.id,
                name: d.name,
                description: d.description,
                version: d.version,
            }
        })
        .collect())
}

/// Starts an install in the background and returns at once; progress arrives as `runtime://progress` events.
#[tauri::command]
pub fn runtime_install(app: AppHandle, state: tauri::State<'_, Installs>, id: String, local_file: Option<String>) -> Result<(), String> {
    find_def(&id)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.0.lock().unwrap();
        // One install at a time: they share the rootfs and the download cache.
        if !running.is_empty() {
            return Err("已有安装任务在进行，请等待完成或先取消".into());
        }
        running.insert(id.clone(), cancel.clone());
    }
    let local = local_file.filter(|s| !s.trim().is_empty()).map(|s| PathBuf::from(s.trim()));
    if let Some(p) = &local {
        if !p.is_file() {
            state.0.lock().unwrap().remove(&id);
            return Err(format!("找不到离线包：{}", p.display()));
        }
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = install(handle.clone(), id.clone(), local, cancel).await;
        let em = Emitter2::new(&handle, &id);
        if let Err(e) = &result {
            em.log(format!("安装失败：{e}"));
        }
        handle.state::<Installs>().0.lock().unwrap().remove(&id);
        em.finish(&result);
    });
    Ok(())
}

/// Windows: install Visual Studio Build Tools (C++ workload) through winget. Large, and winget asks for administrator
/// rights itself, so this is an opt-in button rather than part of the Rust install.
#[tauri::command]
pub fn runtime_install_msvc(app: AppHandle, state: tauri::State<'_, Installs>) -> Result<(), String> {
    if !has_winget() {
        return Err("找不到 winget。请从 Microsoft 官网手动安装 Visual Studio 生成工具（勾选“使用 C++ 的桌面开发”）".into());
    }
    let id = MSVC_ID.to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.0.lock().unwrap();
        if !running.is_empty() {
            return Err("已有安装任务在进行，请等待完成或先取消".into());
        }
        running.insert(id.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn(async move {
        let em = Emitter2::new(&app, &id);
        let (e2, c2) = (em.clone(), cancel.clone());
        let result = tauri::async_runtime::spawn_blocking(move || {
            e2.stage("setup", "正在安装 Visual Studio 生成工具（体积很大，会弹出管理员授权窗口）", 0, 0, 0);
            let mut cmd = std::process::Command::new("winget");
            cmd.args([
                "install",
                "--id",
                "Microsoft.VisualStudio.2022.BuildTools",
                "-e",
                "--accept-package-agreements",
                "--accept-source-agreements",
                "--override",
                "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended",
            ]);
            quiet(&mut cmd);
            run_logged(cmd, &e2, &c2, "winget")?;
            if has_msvc() { Ok(()) } else { Err("winget 已结束，但没有检测到 C++ 生成工具。可能需要重启后再检查".to_string()) }
        })
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
        if let Err(e) = &result {
            em.log(format!("安装失败：{e}"));
        }
        app.state::<Installs>().0.lock().unwrap().remove(&id);
        em.finish(&result);
    });
    Ok(())
}

#[tauri::command]
pub fn runtime_cancel(state: tauri::State<'_, Installs>, id: String) {
    if let Some(flag) = state.0.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn runtime_uninstall(app: AppHandle, state: tauri::State<'_, Installs>, id: String) -> Result<(), String> {
    if !state.0.lock().unwrap().is_empty() {
        return Err("有安装任务在进行，请稍后再卸载".into());
    }
    let def = find_def(&id)?;
    let root = root_dir(&app)?;
    let (_, guest) = pick(&def).ok_or("当前平台不支持")?;
    let dest = payload_dir(&root, &def.id, guest);
    tauri::async_runtime::spawn_blocking(move || {
        remove_tree(&dest).map_err(|e| format!("无法删除（文件被占用？请先关闭正在使用它的程序）：{e}"))?;
        let _ = fs::remove_file(marker_path(&root, &def.id));
        // The shared rootfs is dead weight once the last guest runtime is gone.
        if guest {
            let any = manifest()?.iter().any(|d| d.id != ROOTFS_ID && installed_version(&root, d).is_some());
            if !any {
                let _ = remove_tree(&rootfs_dir(&root));
                let _ = fs::remove_file(marker_path(&root, ROOTFS_ID));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Directories to put on PATH and variables to set for installed desktop runtimes (Android resolves them through PRoot shims).
#[cfg(not(target_os = "android"))]
pub fn desktop_env(app: &AppHandle) -> (Vec<PathBuf>, Vec<(String, OsString)>) {
    let (mut bins, mut env) = (Vec::new(), Vec::new());
    let (Ok(root), Ok(defs)) = (root_dir(app), manifest()) else { return (bins, env) };
    for def in defs {
        let Some((target, false)) = pick(&def) else { continue };
        if installed_version(&root, &def).is_none() {
            continue;
        }
        let dest = payload_dir(&root, &def.id, false);
        for b in &target.bin {
            bins.push(if b.is_empty() { dest.clone() } else { dest.join(b) });
        }
        let dir = dest.to_string_lossy().into_owned();
        for (k, v) in &def.env {
            env.push((k.clone(), OsString::from(expand(v, &dir))));
        }
    }
    (bins, env)
}

/// What the running local server must add to its environment so installed runtimes work without a restart.
#[derive(Serialize, Default)]
pub struct EnvDelta {
    bins: Vec<String>,
    env: HashMap<String, String>,
}

/// Called by the UI after an install or uninstall. Desktop: the PATH entries and variables to hand to the server.
/// Android: the PRoot shims are re-linked here, and PATH already contains their directory.
#[tauri::command]
pub fn runtime_env(app: AppHandle) -> EnvDelta {
    #[cfg(target_os = "android")]
    {
        if let Ok(data) = app.path().app_data_dir() {
            crate::android::refresh_guest_shims(&data, &installed_guest_ids(&app));
        }
        return EnvDelta::default();
    }
    #[cfg(not(target_os = "android"))]
    {
        let (bins, env) = desktop_env(&app);
        EnvDelta {
            bins: bins.iter().map(|b| b.to_string_lossy().into_owned()).collect(),
            env: env.into_iter().map(|(k, v)| (k, v.to_string_lossy().into_owned())).collect(),
        }
    }
}

/// Names of installed guest runtimes, for the Android shim linker.
#[cfg(target_os = "android")]
pub fn installed_guest_ids(app: &AppHandle) -> Vec<String> {
    let (Ok(root), Ok(defs)) = (root_dir(app), manifest()) else { return Vec::new() };
    defs.into_iter().filter(|d| d.id != ROOTFS_ID && installed_version(&root, d).is_some()).map(|d| d.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_and_every_target_is_complete() {
        let defs = manifest().expect("manifest");
        assert!(defs.iter().any(|d| d.id == "python"));
        for d in &defs {
            for (key, t) in &d.targets {
                assert!(!t.urls.is_empty(), "{}:{key} has no urls", d.id);
                assert!(t.sha256.is_some() != t.sha256_url.is_some(), "{}:{key} needs exactly one of sha256 / sha256Url", d.id);
                if let Some(s) = &t.sha256 {
                    assert!(s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()), "{}:{key} bad sha256", d.id);
                }
                assert!(!t.check.is_empty());
                if t.format == Format::Exe {
                    assert!(!t.run.is_empty(), "{}:{key} installer has no args", d.id);
                }
            }
            for r in &d.requires {
                assert!(defs.iter().any(|x| &x.id == r), "{} requires unknown {r}", d.id);
            }
        }
    }

    #[test]
    fn gnu_fallback_is_wired_to_a_real_runtime() {
        let rust = find_def("rust").unwrap();
        let g = rust.targets["windows-x86_64"].gnu_fallback.clone().expect("fallback");
        let dep = find_def(&g.requires).unwrap();
        assert!(dep.hidden);
        let t = &dep.targets["windows-x86_64"];
        assert_eq!(t.check, g.linker, "linker path must be the dependency's check file");
        assert!(rust.targets.values().all(|t| t.needs_linker));
    }

    #[test]
    fn gnu_config_points_cargo_at_the_linker() {
        let dir = std::env::temp_dir().join(format!("prom-gnu-{}", std::process::id()));
        let plan = GnuPlan { host: "x86_64-pc-windows-gnu".into(), linker: PathBuf::from(r"C:\a b\bin\clang.exe"), config: "cargo/config.toml".into() };
        write_gnu_config(&dir, &plan).unwrap();
        let body = fs::read_to_string(dir.join("cargo/config.toml")).unwrap();
        assert!(body.contains("[target.x86_64-pc-windows-gnu]") && body.contains("linker = \"C:/a b/bin/clang.exe\""), "{body}");
        let _ = fs::remove_dir_all(&dir);
    }

    const ROOT_PEM: &str = "-----BEGIN CERTIFICATE-----\nMIIH0zCCBbugAwIBAgIIXsO3pkN/pOAwDQYJKoZIhvcNAQEFBQAwQjESMBAGA1UE\nAwwJQUNDVlJBSVoxMRAwDgYDVQQLDAdQS0lBQ0NWMQ0wCwYDVQQKDARBQ0NWMQsw\nCQYDVQQGEwJFUzAeFw0xMTA1MDUwOTM3MzdaFw0zMDEyMzEwOTM3MzdaMEIxEjAQ\nBgNVBAMMCUFDQ1ZSQUlaMTEQMA4GA1UECwwHUEtJQUNDVjENMAsGA1UECgwEQUND\nVjELMAkGA1UEBhMCRVMwggIiMA0GCSqGSIb3DQEBAQUAA4ICDwAwggIKAoICAQCb\nqau/YUqXry+XZpp0X9DZlv3P4uRm7x8fRzPCRKPfmt4ftVTdFXxpNRFvu8gMjmoY\nHtiP2Ra8EEg2XPBjs5BaXCQ316PWywlxufEBcoSwfdtNgM3802/J+Nq2DoLSRYWo\nG2ioPej0RGy9ocLLA76MPhMAhN9KSMDjIgro6TenGEyxCQ0jVn8ETdkXhBilyNpA\nlHPrzg5XPAOBOp0KoVdDaaxXbXmQeOW1tDvYvEyNKKGno6e6Ak4l0Squ7a4DIrhr\nIA8wKFSVf+DuzgpmndFALW4ir50awQUZ0m/A8p/4e7MCQvtQqR0tkw8jq8bBD5L/\n0KIV9VMJcRz/RROE5iZe+OCIHAr8Fraocwa48GOEAqDGWuzndN9wrqODJerWx5eH\nk6fGioozl2A3ED6XPm4pFdahD9GILBKfb6qkxkLrQaLjlUPTAYVtjrs78yM2x/47\n4KElB0iryYl0/wiPgL/AlmXz7uxLaL2diMMxs0Dx6M/2OLuc5NF/1OVYm3z61PMO\nm3WR5LpSLhl+0fXNWhn8ugb2+1KoS5kE3fj5tItQo05iifCHJPqDQsGH+tUtKSpa\ncXpkatcnYGMN285J9Y0fkIkyF/hzQ7jSWpOGYdbhdQrqeWZ2iE9x6wQl1gpaepPl\nuUsXQA+xtrn13k/c4LOsOxFwYIRKQ26ZIMApcQrAZQIDAQABo4ICyzCCAscwfQYI\nKwYBBQUHAQEEcTBvMEwGCCsGAQUFBzAChkBodHRwOi8vd3d3LmFjY3YuZXMvZmls\nZWFkbWluL0FyY2hpdm9zL2NlcnRpZmljYWRvcy9yYWl6YWNjdjEuY3J0MB8GCCsG\nAQUFBzABhhNodHRwOi8vb2NzcC5hY2N2LmVzMB0GA1UdDgQWBBTSh7Tj3zcnk1X2\nVuqB5TbMjB4/vTAPBgNVHRMBAf8EBTADAQH/MB8GA1UdIwQYMBaAFNKHtOPfNyeT\nVfZW6oHlNsyMHj+9MIIBcwYDVR0gBIIBajCCAWYwggFiBgRVHSAAMIIBWDCCASIG\nCCsGAQUFBwICMIIBFB6CARAAQQB1AHQAbwByAGkAZABhAGQAIABkAGUAIABDAGUA\ncgB0AGkAZgBpAGMAYQBjAGkA8wBuACAAUgBhAO0AegAgAGQAZQAgAGwAYQAgAEEA\nQwBDAFYAIAAoAEEAZwBlAG4AYwBpAGEAIABkAGUAIABUAGUAYwBuAG8AbABvAGcA\n7QBhACAAeQAgAEMAZQByAHQAaQBmAGkAYwBhAGMAaQDzAG4AIABFAGwAZQBjAHQA\ncgDzAG4AaQBjAGEALAAgAEMASQBGACAAUQA0ADYAMAAxADEANQA2AEUAKQAuACAA\nQwBQAFMAIABlAG4AIABoAHQAdABwADoALwAvAHcAdwB3AC4AYQBjAGMAdgAuAGUA\nczAwBggrBgEFBQcCARYkaHR0cDovL3d3dy5hY2N2LmVzL2xlZ2lzbGFjaW9uX2Mu\naHRtMFUGA1UdHwROMEwwSqBIoEaGRGh0dHA6Ly93d3cuYWNjdi5lcy9maWxlYWRt\naW4vQXJjaGl2b3MvY2VydGlmaWNhZG9zL3JhaXphY2N2MV9kZXIuY3JsMA4GA1Ud\nDwEB/wQEAwIBBjAXBgNVHREEEDAOgQxhY2N2QGFjY3YuZXMwDQYJKoZIhvcNAQEF\nBQADggIBAJcxAp/n/UNnSEQU5CmH7UwoZtCPNdpNYbdKl02125DgBS4OxnnQ8pdp\nD70ER9m+27Up2pvZrqmZ1dM8MJP1jaGo/AaNRPTKFpV8M9xii6g3+CfYCS0b78gU\nJyCpZET/LtZ1qmxNYEAZSUNUY9rizLpm5U9EelvZaoErQNV/+QEnWCzI7UiRfD+m\nAM/EKXMRNt6GGT6d7hmKG9Ww7Y49nCrADdg9ZuM8Db3VlFzi4qc1GwQA9j9ajepD\nvV+JHanBsMyZ4k0ACtrJJ1vnE5Bc5PUzolVt3OAJTS+xJlsndQAJxGJ3KQhfnlms\ntn6tn1QwIgPBHnFk/vk4CpYY3QIUrCPLBhwepH2NDd4nQeit2hW3sCPdK6jT2iWH\n7ehVRE2I9DZ+hJp4rPcOVkkO1jMl1oRQQmwgEh0q1b688nCBpHBgvgW1m54ERL5h\nI6zppSSMEYCUWqKiuUnSwdzRp+0xESyeGabu4VXhwOrPDYTkF7eifKXeVSUG7szA\nh1xA2syVP1XgNce4hL60Xc16gwFy7ofmXx2utYXGJt/mwZrpHgJHnyqobalbz+xF\nd3+YJ5oyXSrjhO7FmGYvliAd3djDJ9ew+f7Zfc3Qn48LFFhRny+Lwzgt3uiP1o2H\npPVWQxaZLPSkVrQ0uGE3ycJYgBugl6H8WY3pEfbRD0tVNEYqi4Y7\n-----END CERTIFICATE-----\n";

    #[test]
    fn ca_dir_skips_garbage_and_reads_pem() {
        let dir = std::env::temp_dir().join(format!("prom-ca-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // a real root, as PEM followed by a text dump like Android's files
        let pem = format!("{ROOT_PEM}Certificate:\n    Data: dump\n");
        fs::write(dir.join("good.0"), pem).unwrap();
        fs::write(dir.join("bad.0"), b"-----BEGIN CERTIFICATE-----
AAAA
-----END CERTIFICATE-----
").unwrap();
        fs::write(dir.join("junk.0"), b"not a cert").unwrap();
        let certs = certs_from_dirs(&[dir.to_str().unwrap()]);
        assert_eq!(certs.len(), 1);
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder().tls_certs_only(certs).build().expect("client builds with the filtered roots");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn this_platform_resolves_python() {
        let py = find_def("python").unwrap();
        assert!(pick(&py).is_some(), "no python target for {}", target_key());
    }

    #[test]
    fn parses_checksum_files() {
        let h = "a".repeat(64);
        assert_eq!(parse_sha(&h), Some(h.clone()));
        assert_eq!(parse_sha(&format!("{h} *rustup-init")), Some(h.clone()));
        assert_eq!(parse_sha(&format!("{}  file.zip\n", h.to_uppercase())), Some(h));
        assert_eq!(parse_sha("not a hash"), None);
    }

    #[test]
    fn strip_path_drops_prefix_and_rejects_escapes() {
        assert_eq!(strip_path(Path::new("python/bin/python3"), 1).unwrap(), Some(PathBuf::from("bin/python3")));
        assert_eq!(strip_path(Path::new("./python/"), 1).unwrap(), None);
        assert_eq!(strip_path(Path::new("./etc/passwd"), 0).unwrap(), Some(PathBuf::from("etc/passwd")));
        assert!(strip_path(Path::new("a/../../x"), 0).is_err());
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prometheus-rt-{}-{name}", std::process::id()));
        let _ = remove_tree(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn zip_extraction_strips_and_blocks_traversal() {
        let dir = scratch("zip");
        let zip_path = dir.join("a.zip");
        {
            let mut w = zip::ZipWriter::new(File::create(&zip_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            w.start_file("top/bin/tool", opts).unwrap();
            w.write_all(b"hi").unwrap();
            w.finish().unwrap();
        }
        // The extraction code needs an emitter only for progress; build the pieces by hand.
        let out = dir.join("out");
        fs::create_dir_all(&out).unwrap();
        let mut z = zip::ZipArchive::new(File::open(&zip_path).unwrap()).unwrap();
        let mut e = z.by_index(0).unwrap();
        let rel = strip_path(&e.enclosed_name().unwrap(), 1).unwrap().unwrap();
        assert_eq!(rel, PathBuf::from("bin/tool"));
        let mut s = String::new();
        e.read_to_string(&mut s).unwrap();
        assert_eq!(s, "hi");
        let _ = remove_tree(&dir);
    }

    #[test]
    fn remove_tree_handles_missing_and_readonly() {
        let dir = scratch("rm");
        let f = dir.join("sub").join("ro.txt");
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, "x").unwrap();
        let mut perm = fs::metadata(&f).unwrap().permissions();
        perm.set_readonly(true);
        fs::set_permissions(&f, perm).unwrap();
        remove_tree(&dir).unwrap();
        assert!(!dir.exists());
        remove_tree(&dir).unwrap();
    }
}
