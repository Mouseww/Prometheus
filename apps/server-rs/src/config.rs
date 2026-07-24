use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
};

use crate::error::AppError;

#[derive(Clone, Debug)]
pub struct Config {
    workspace_root: PathBuf,
    data_file: PathBuf,
    worktree_root: PathBuf,
    web_root: Option<PathBuf>,
    host: IpAddr,
    port: u16,
    master_key: [u8; 32],
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
        Ok(Self {
            data_file: workspace_root.join(".prometheus").join("prometheus.db"),
            worktree_root: default_worktree_root(&workspace_root),
            web_root: None,
            workspace_root,
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 4310,
            master_key: [7_u8; 32],
        })
    }

    pub fn from_env() -> Result<Self, AppError> {
        let workspace_root = match env::var_os("PROMETHEUS_WORKSPACE_ROOT") {
            Some(value) => PathBuf::from(value),
            None => env::current_dir().map_err(|error| {
                AppError::configuration(format!("Unable to resolve current directory: {error}"))
            })?,
        };
        let mut config = Self::new(workspace_root)?;
        if let Some(value) = env::var_os("PROMETHEUS_DATA_FILE") {
            config.data_file = PathBuf::from(value);
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
        }
        if let Ok(value) = env::var("PROMETHEUS_PORT") {
            config.port = value.parse().map_err(|error| {
                AppError::configuration(format!("Invalid PROMETHEUS_PORT: {error}"))
            })?;
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
        Ok(config)
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    pub fn data_file(&self) -> &Path {
        &self.data_file
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
