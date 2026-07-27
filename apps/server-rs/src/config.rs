use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

use crate::{error::AppError, terminal_policy::TerminalMode};

#[derive(Clone, Debug)]
pub struct Config {
    workspace_root: PathBuf,
    data_file: PathBuf,
    worktree_root: PathBuf,
    web_root: Option<PathBuf>,
    runtime_file: PathBuf,
    host: IpAddr,
    port: u16,
    master_key: [u8; 32],
    access_token: Option<String>,
    allowed_origins: Vec<String>,
    terminal_mode: TerminalMode,
}

impl Config {
    pub fn new(workspace_root: impl AsRef<Path>) -> Result<Self, AppError> {
        let workspace_root = workspace_root
            .as_ref()
            .canonicalize()
            .map_err(|error| AppError::configuration(format!("Invalid workspace root: {error}")))?;
        if !workspace_root.is_dir() {
            return Err(AppError::configuration(
                "Workspace root must be a directory",
            ));
        }
        let data_file = workspace_root.join(".prometheus").join("prometheus.db");
        Ok(Self {
            runtime_file: data_file
                .parent()
                .map(|parent| parent.join("runtime.json"))
                .unwrap_or_else(|| PathBuf::from("runtime.json")),
            data_file,
            worktree_root: default_worktree_root(&workspace_root),
            web_root: None,
            workspace_root,
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 4310,
            master_key: [7_u8; 32],
            access_token: None,
            allowed_origins: Vec::new(),
            terminal_mode: TerminalMode::default(),
        })
    }

    pub fn from_env() -> Result<Self, AppError> {
        let cwd = env::current_dir().map_err(|error| {
            AppError::configuration(format!("Unable to resolve current directory: {error}"))
        })?;

        // Resolve data file first so runtime.json can live next to the DB.
        let provisional_workspace = match env::var_os("PROMETHEUS_WORKSPACE_ROOT") {
            Some(value) => PathBuf::from(value),
            None => cwd.clone(),
        };
        let mut provisional = Self::new(&provisional_workspace)?;
        if let Some(value) = env::var_os("PROMETHEUS_DATA_FILE") {
            provisional.data_file = PathBuf::from(value);
            provisional.runtime_file = provisional
                .data_file
                .parent()
                .map(|parent| parent.join("runtime.json"))
                .unwrap_or_else(|| PathBuf::from("runtime.json"));
        }
        if let Some(value) = env::var_os("PROMETHEUS_RUNTIME_FILE") {
            provisional.runtime_file = PathBuf::from(value);
        }

        let runtime = crate::runtime_settings::RuntimeSettings::load(&provisional.runtime_file)?;

        let workspace_root = if env::var_os("PROMETHEUS_WORKSPACE_ROOT").is_some() {
            provisional_workspace
        } else if let Some(path) = runtime.workspace_root.as_ref() {
            PathBuf::from(path)
        } else {
            cwd
        };

        let mut config = Self::new(workspace_root)?;
        config.runtime_file = provisional.runtime_file;
        if let Some(value) = env::var_os("PROMETHEUS_DATA_FILE") {
            config.data_file = PathBuf::from(value);
        } else if env::var_os("PROMETHEUS_WORKSPACE_ROOT").is_none() {
            // Keep the original data file location when workspace comes from runtime settings.
            config.data_file = provisional.data_file;
        }
        if let Some(value) = env::var_os("PROMETHEUS_WORKTREE_ROOT") {
            config.worktree_root = PathBuf::from(value);
        }
        if let Some(value) = env::var_os("PROMETHEUS_WEB_ROOT") {
            config.web_root = Some(PathBuf::from(value));
        } else {
            // Prefer monorepo client dist when launched from repository root.
            let candidate = config
                .workspace_root
                .join("apps")
                .join("client")
                .join("dist");
            if candidate.is_dir() {
                config.web_root = Some(candidate);
            }
        }
        if let Ok(value) = env::var("PROMETHEUS_HOST") {
            config.host = value.parse().map_err(|error| {
                AppError::configuration(format!("Invalid PROMETHEUS_HOST: {error}"))
            })?;
        } else if let Some(host) = runtime.host.as_ref() {
            config.host = host.parse().map_err(|error| {
                AppError::configuration(format!("Invalid runtime host: {error}"))
            })?;
        }
        if let Ok(value) = env::var("PROMETHEUS_PORT") {
            config.port = value.parse().map_err(|error| {
                AppError::configuration(format!("Invalid PROMETHEUS_PORT: {error}"))
            })?;
        } else if let Some(port) = runtime.port {
            config.port = port;
        }
        if let Ok(value) = env::var("PROMETHEUS_MASTER_KEY") {
            let key = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD,
                value.trim(),
            )
            .map_err(|error| {
                AppError::configuration(format!("Invalid PROMETHEUS_MASTER_KEY: {error}"))
            })?;
            if key.len() != 32 {
                return Err(AppError::configuration(
                    "PROMETHEUS_MASTER_KEY must decode to exactly 32 bytes",
                ));
            }
            config.master_key.copy_from_slice(&key);
        } else {
            let key_path = config
                .workspace_root
                .join(".prometheus")
                .join("master.key");
            config.master_key = load_or_create_master_key(&key_path)?;
        }

        if let Ok(value) = env::var("PROMETHEUS_ACCESS_TOKEN") {
            config.access_token = normalize_access_token(&value)?;
        }
        if let Ok(value) = env::var("PROMETHEUS_ALLOWED_ORIGINS") {
            config.allowed_origins = parse_allowed_origins(&value);
        }
        if let Ok(value) = env::var("PROMETHEUS_TERMINAL_MODE") {
            config.terminal_mode = TerminalMode::parse(&value)?;
        }
        config.validate_security()?;
        Ok(config)
    }

    /// 启动期安全校验。任何一条不成立都必须让进程拒绝启动，而不是降级运行。
    ///
    /// 规则表：
    /// - loopback + 无 token  → 允许（本机单用户），调用方负责打印提示
    /// - 非 loopback + 无 token → 拒绝
    /// - terminal_mode=trusted + 非 loopback → 拒绝
    pub fn validate_security(&self) -> Result<(), AppError> {
        if !self.host.is_loopback() && self.access_token.is_none() {
            return Err(AppError::configuration(format!(
                "Refusing to bind {} without PROMETHEUS_ACCESS_TOKEN. \
                 A non-loopback control plane exposes the workspace and shell to the network.",
                self.host
            )));
        }
        self.terminal_mode.validate_for_bind(self.host)?;
        Ok(())
    }

    /// 本机单用户模式下的启动提示；无需提示时返回 `None`。
    pub fn security_warning(&self) -> Option<String> {
        if self.access_token.is_none() {
            return Some(format!(
                "No PROMETHEUS_ACCESS_TOKEN configured — API is open to any local process on {}.",
                self.host
            ));
        }
        None
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn data_file(&self) -> &Path {
        &self.data_file
    }

    pub fn runtime_file(&self) -> &Path {
        &self.runtime_file
    }

    pub fn host(&self) -> IpAddr {
        self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn set_workspace_root(&mut self, workspace_root: PathBuf) {
        self.worktree_root = default_worktree_root(&workspace_root);
        self.workspace_root = workspace_root;
    }

    pub fn worktree_root(&self) -> &Path {
        &self.worktree_root
    }

    pub fn web_root(&self) -> Option<&Path> {
        self.web_root.as_deref()
    }

    pub fn master_key(&self) -> &[u8; 32] {
        &self.master_key
    }

    pub fn access_token(&self) -> Option<&str> {
        self.access_token.as_deref()
    }

    /// CORS 允许的 Origin 列表。未显式配置时回退到本机默认（Vite dev server + 自身）。
    pub fn allowed_origins(&self) -> Vec<String> {
        if !self.allowed_origins.is_empty() {
            return self.allowed_origins.clone();
        }
        default_allowed_origins(self.host, self.port)
    }

    pub fn terminal_mode(&self) -> TerminalMode {
        self.terminal_mode
    }

    pub fn with_access_token(mut self, token: impl Into<String>) -> Self {
        self.access_token = Some(token.into());
        self
    }

    pub fn with_terminal_mode(mut self, mode: TerminalMode) -> Self {
        self.terminal_mode = mode;
        self
    }

    pub fn with_host(mut self, host: IpAddr) -> Self {
        self.host = host;
        self
    }

    pub fn with_data_file(mut self, data_file: impl Into<PathBuf>) -> Self {
        self.data_file = data_file.into();
        self
    }

    pub fn with_worktree_root(mut self, worktree_root: impl Into<PathBuf>) -> Self {
        self.worktree_root = worktree_root.into();
        self
    }

    pub fn with_web_root(mut self, web_root: impl Into<PathBuf>) -> Self {
        self.web_root = Some(web_root.into());
        self
    }

    pub fn with_master_key(mut self, key: [u8; 32]) -> Self {
        self.master_key = key;
        self
    }

    pub fn workspace_name(&self) -> String {
        self.workspace_root
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.workspace_root.display().to_string())
    }

    pub fn bind_address(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }
}

fn load_or_create_master_key(path: &Path) -> Result<[u8; 32], AppError> {
    use std::fs;
    if path.exists() {
        let encoded = fs::read_to_string(path).map_err(|error| {
            AppError::configuration(format!("Unable to read master key: {error}"))
        })?;
        let key = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            encoded.trim(),
        )
        .map_err(|error| AppError::configuration(format!("Invalid master key file: {error}")))?;
        if key.len() != 32 {
            return Err(AppError::configuration(format!(
                "Invalid master key file: {}",
                path.display()
            )));
        }
        let mut bytes = [0_u8; 32];
        bytes.copy_from_slice(&key);
        return Ok(bytes);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            AppError::configuration(format!("Unable to create master key directory: {error}"))
        })?;
    }
    let mut key = [0_u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut key);
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, key);
    fs::write(path, encoded).map_err(|error| {
        AppError::configuration(format!("Unable to write master key: {error}"))
    })?;
    Ok(key)
}


fn default_worktree_root(workspace_root: &Path) -> PathBuf {
    let parent = workspace_root.parent().unwrap_or(workspace_root);
    let name = workspace_root
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "workspace".to_owned());
    parent.join(".prometheus-worktrees").join(name)
}

/// 空白 token 视为未配置——否则 `PROMETHEUS_ACCESS_TOKEN=""` 会伪装成已启用鉴权。
fn normalize_access_token(value: &str) -> Result<Option<String>, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() < 16 {
        return Err(AppError::configuration(
            "PROMETHEUS_ACCESS_TOKEN must be at least 16 characters",
        ));
    }
    Ok(Some(trimmed.to_owned()))
}

fn parse_allowed_origins(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|item| item.trim().trim_end_matches('/'))
        .filter(|item| !item.is_empty())
        .map(|item| item.to_owned())
        .collect()
}

fn default_allowed_origins(host: IpAddr, port: u16) -> Vec<String> {
    let mut origins = vec![
        "http://127.0.0.1:5173".to_owned(),
        "http://localhost:5173".to_owned(),
        "tauri://localhost".to_owned(),
        "http://tauri.localhost".to_owned(),
    ];
    let self_host = match host {
        IpAddr::V4(addr) if addr.is_unspecified() => "127.0.0.1".to_owned(),
        IpAddr::V6(addr) if addr.is_unspecified() => "[::1]".to_owned(),
        IpAddr::V6(addr) => format!("[{addr}]"),
        IpAddr::V4(addr) => addr.to_string(),
    };
    origins.push(format!("http://{self_host}:{port}"));
    origins.dedup();
    origins
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv6Addr;

    fn temp_config() -> Config {
        let dir = std::env::temp_dir();
        Config::new(dir).expect("temp dir is a valid workspace root")
    }

    #[test]
    fn loopback_without_token_is_allowed_but_warns() {
        let config = temp_config();
        assert!(config.validate_security().is_ok());
        assert!(config.security_warning().is_some());
    }

    #[test]
    fn non_loopback_without_token_refuses_to_start() {
        let config = temp_config().with_host(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        let error = config.validate_security().expect_err("must refuse");
        assert!(error.to_string().contains("PROMETHEUS_ACCESS_TOKEN"));
    }

    #[test]
    fn non_loopback_with_token_is_allowed_and_silent() {
        let config = temp_config()
            .with_host(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .with_access_token("0123456789abcdef0123");
        assert!(config.validate_security().is_ok());
        assert!(config.security_warning().is_none());
    }

    #[test]
    fn trusted_terminal_on_non_loopback_refuses_to_start() {
        let config = temp_config()
            .with_host(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .with_access_token("0123456789abcdef0123")
            .with_terminal_mode(TerminalMode::Trusted);
        let error = config.validate_security().expect_err("must refuse");
        assert!(error.to_string().contains("loopback"));
    }

    #[test]
    fn blank_token_is_treated_as_unset_and_short_token_rejected() {
        assert_eq!(normalize_access_token("   ").unwrap(), None);
        assert!(normalize_access_token("short").is_err());
        assert_eq!(
            normalize_access_token(" 0123456789abcdef ").unwrap(),
            Some("0123456789abcdef".to_owned())
        );
    }

    #[test]
    fn allowed_origins_parse_and_default() {
        assert_eq!(
            parse_allowed_origins("http://a.test/, ,https://b.test"),
            vec!["http://a.test".to_owned(), "https://b.test".to_owned()]
        );
        let defaults = default_allowed_origins(IpAddr::V6(Ipv6Addr::LOCALHOST), 4310);
        assert!(defaults.contains(&"http://[::1]:4310".to_owned()));
        assert!(defaults.contains(&"http://127.0.0.1:5173".to_owned()));
    }
}
