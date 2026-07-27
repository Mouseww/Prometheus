//! 终端（PTY 与一次性 exec）能力的准入策略。
//!
//! 设计前提：交互式 PTY 的能力是 `shell_command` 工具的**超集**——它能启动长驻进程、
//! 读写任意可达路径、发起网络请求，且不受工具层的 `timeout_ms` / 输出截断约束。
//! 因此策略只能更严，不能更松：默认关闭，开启需显式配置，且始终产生 durable 事件。

use std::net::IpAddr;

use crate::error::AppError;

/// 终端通道的准入模式，由 `PROMETHEUS_TERMINAL_MODE` 控制。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TerminalMode {
    /// 默认。完全拒绝 PTY 与 `/api/terminal/exec`。适用于生产与任何远程部署。
    #[default]
    Disabled,
    /// 每次开启终端会话需要一次跨终端审批，会话内的输入不再逐条审批。
    ApprovalPerSession,
    /// 免审批直连。仅在绑定 loopback 时允许，非 loopback 绑定会在启动时被拒绝。
    Trusted,
}

impl TerminalMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::ApprovalPerSession => "approval_per_session",
            Self::Trusted => "trusted",
        }
    }

    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "disabled" | "off" | "" => Ok(Self::Disabled),
            "approval" | "approval_per_session" | "approval-per-session" => {
                Ok(Self::ApprovalPerSession)
            }
            "trusted" => Ok(Self::Trusted),
            other => Err(AppError::configuration(format!(
                "Invalid PROMETHEUS_TERMINAL_MODE: {other} (expected disabled|approval_per_session|trusted)"
            ))),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !matches!(self, Self::Disabled)
    }

    pub fn requires_approval(&self) -> bool {
        matches!(self, Self::ApprovalPerSession)
    }

    /// 启动期校验：`Trusted` 只在 loopback 绑定下成立。
    pub fn validate_for_bind(&self, host: IpAddr) -> Result<(), AppError> {
        if matches!(self, Self::Trusted) && !host.is_loopback() {
            return Err(AppError::configuration(
                "PROMETHEUS_TERMINAL_MODE=trusted requires a loopback bind address; \
                 use approval_per_session for shared deployments",
            ));
        }
        Ok(())
    }

    /// 请求期校验：终端被禁用时统一返回 403，而不是静默降级。
    pub fn ensure_enabled(&self) -> Result<(), AppError> {
        if self.is_enabled() {
            return Ok(());
        }
        Err(AppError::forbidden(
            "Terminal access is disabled. Set PROMETHEUS_TERMINAL_MODE=approval_per_session or trusted to enable it.",
        ))
    }
}

/// 从子进程环境中剥离的敏感变量前缀与精确名。
///
/// PTY 与 `shell_command` 共用同一份清单——能力等价则脱敏等价（DRY）。
const SENSITIVE_ENV_EXACT: &[&str] = &[
    "PROMETHEUS_MASTER_KEY",
    "PROMETHEUS_ACCESS_TOKEN",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
];

/// 需要判断当前环境中是否存在的敏感变量名（含按后缀匹配的通配）。
const SENSITIVE_ENV_SUFFIX: &[&str] = &["_API_KEY", "_SECRET", "_TOKEN", "_PASSWORD"];

/// 返回当前进程环境中应当从子进程剥离的变量名。
pub fn sensitive_env_keys() -> Vec<String> {
    let mut keys: Vec<String> = SENSITIVE_ENV_EXACT
        .iter()
        .map(|key| (*key).to_owned())
        .collect();
    for (key, _) in std::env::vars_os() {
        let key = key.to_string_lossy().into_owned();
        if is_sensitive_env_key(&key) && !keys.iter().any(|existing| existing == &key) {
            keys.push(key);
        }
    }
    keys
}

pub fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if SENSITIVE_ENV_EXACT.contains(&upper.as_str()) {
        return true;
    }
    SENSITIVE_ENV_SUFFIX
        .iter()
        .any(|suffix| upper.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn default_mode_is_disabled() {
        assert_eq!(TerminalMode::default(), TerminalMode::Disabled);
        assert!(TerminalMode::default().ensure_enabled().is_err());
    }

    #[test]
    fn parses_known_aliases() {
        assert_eq!(TerminalMode::parse("").unwrap(), TerminalMode::Disabled);
        assert_eq!(TerminalMode::parse("off").unwrap(), TerminalMode::Disabled);
        assert_eq!(
            TerminalMode::parse("approval").unwrap(),
            TerminalMode::ApprovalPerSession
        );
        assert_eq!(
            TerminalMode::parse("APPROVAL_PER_SESSION").unwrap(),
            TerminalMode::ApprovalPerSession
        );
        assert_eq!(TerminalMode::parse("Trusted").unwrap(), TerminalMode::Trusted);
        assert!(TerminalMode::parse("yolo").is_err());
    }

    #[test]
    fn trusted_requires_loopback_bind() {
        let trusted = TerminalMode::Trusted;
        assert!(trusted.validate_for_bind(IpAddr::V4(Ipv4Addr::LOCALHOST)).is_ok());
        assert!(trusted.validate_for_bind(IpAddr::V6(Ipv6Addr::LOCALHOST)).is_ok());
        assert!(
            trusted
                .validate_for_bind(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
                .is_err()
        );

        // 审批模式在任何绑定地址下都成立。
        assert!(
            TerminalMode::ApprovalPerSession
                .validate_for_bind(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
                .is_ok()
        );
    }

    #[test]
    fn sensitive_keys_cover_exact_and_suffix_forms() {
        assert!(is_sensitive_env_key("PROMETHEUS_MASTER_KEY"));
        assert!(is_sensitive_env_key("prometheus_access_token"));
        assert!(is_sensitive_env_key("CUSTOM_PROVIDER_API_KEY"));
        assert!(is_sensitive_env_key("DB_PASSWORD"));
        assert!(!is_sensitive_env_key("PATH"));
        assert!(!is_sensitive_env_key("PROMETHEUS_WORKSPACE_ROOT"));
    }
}
