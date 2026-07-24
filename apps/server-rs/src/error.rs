use axum::{Json, http::StatusCode, response::IntoResponse};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("{0}")]
    Configuration(String),
    #[error("{0}")]
    InvalidRequest(String),
    #[error("{0}")]
    SessionNotFound(String),
    #[error("{0}")]
    EventConflict(String),
    #[error("{0}")]
    WorkspaceBoundary(String),
    #[error("Path not found")]
    PathNotFound,
    #[error("{0}")]
    ConfigurationNotFound(String),
    #[error("{0}")]
    ConfigurationReferenceNotFound(String),
    #[error("{0}")]
    PermissionRuleNotFound(String),
    #[error("{0}")]
    ProviderRequestFailed(String),
    #[error("{0}")]
    ApprovalNotFound(String),
    #[error("{0}")]
    TeamRunNotFound(String),
    #[error("{0}")]
    TeamTaskNotFound(String),
    #[error("{0}")]
    TeamRunDependencyNotFound(String),
    #[error("{0}")]
    RuntimeNotMigrated(String),
    #[error("{0}")]
    TeamRunConflict(String),
    #[error("Database operation failed")]
    Database(#[from] sqlx::Error),
}

impl AppError {
    pub fn configuration(message: impl Into<String>) -> Self {
        Self::Configuration(message.into())
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::InvalidRequest(message.into())
    }

    pub fn session_not_found(session_id: impl AsRef<str>) -> Self {
        Self::SessionNotFound(format!("Session not found: {}", session_id.as_ref()))
    }

    pub fn event_conflict(event_id: impl AsRef<str>) -> Self {
        Self::EventConflict(format!(
            "Event id was already used with different content: {}",
            event_id.as_ref()
        ))
    }

    pub fn workspace_boundary(path: impl Into<String>) -> Self {
        Self::WorkspaceBoundary(format!("Path escapes workspace root: {}", path.into()))
    }

    pub fn path_not_found() -> Self {
        Self::PathNotFound
    }

    pub fn configuration_not_found(message: impl Into<String>) -> Self {
        Self::ConfigurationNotFound(message.into())
    }

    pub fn configuration_reference_not_found(message: impl Into<String>) -> Self {
        Self::ConfigurationReferenceNotFound(message.into())
    }

    pub fn permission_rule_not_found() -> Self {
        Self::PermissionRuleNotFound("Permission rule not found".to_owned())
    }

    pub fn provider_request_failed(message: impl Into<String>) -> Self {
        Self::ProviderRequestFailed(message.into())
    }

    pub fn approval_not_found() -> Self {
        Self::ApprovalNotFound("Approval not found".to_owned())
    }

    pub fn team_run_not_found(message: impl Into<String>) -> Self {
        Self::TeamRunNotFound(message.into())
    }

    pub fn team_task_not_found(message: impl Into<String>) -> Self {
        Self::TeamTaskNotFound(message.into())
    }

    pub fn team_run_dependency_not_found(message: impl Into<String>) -> Self {
        Self::TeamRunDependencyNotFound(message.into())
    }

    pub fn runtime_not_migrated(message: impl Into<String>) -> Self {
        Self::RuntimeNotMigrated(message.into())
    }

    pub fn team_run_conflict(message: impl Into<String>) -> Self {
        Self::TeamRunConflict(message.into())
    }
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        let (status, error, message) = match self {
            Self::InvalidRequest(message) => (StatusCode::BAD_REQUEST, "invalid_request", message),
            Self::SessionNotFound(message) => (StatusCode::NOT_FOUND, "session_not_found", message),
            Self::EventConflict(message) => (StatusCode::CONFLICT, "event_conflict", message),
            Self::WorkspaceBoundary(message) => {
                (StatusCode::FORBIDDEN, "workspace_boundary", message)
            }
            Self::PathNotFound => (
                StatusCode::NOT_FOUND,
                "path_not_found",
                "Path not found".to_owned(),
            ),
            Self::ConfigurationNotFound(message) => {
                (StatusCode::NOT_FOUND, "configuration_not_found", message)
            }
            Self::ConfigurationReferenceNotFound(message) => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "configuration_reference_not_found",
                message,
            ),
            Self::PermissionRuleNotFound(message) => {
                (StatusCode::NOT_FOUND, "permission_rule_not_found", message)
            }
            Self::ProviderRequestFailed(message) => {
                (StatusCode::BAD_GATEWAY, "provider_request_failed", message)
            }
            Self::ApprovalNotFound(message) => {
                (StatusCode::NOT_FOUND, "approval_not_found", message)
            }
            Self::TeamRunNotFound(message) => {
                (StatusCode::NOT_FOUND, "team_run_not_found", message)
            }
            Self::TeamTaskNotFound(message) => {
                (StatusCode::NOT_FOUND, "team_task_not_found", message)
            }
            Self::TeamRunDependencyNotFound(message) => {
                (StatusCode::NOT_FOUND, "team_run_dependency_not_found", message)
            }
            Self::RuntimeNotMigrated(message) => {
                (StatusCode::NOT_IMPLEMENTED, "runtime_not_migrated", message)
            }
            Self::TeamRunConflict(message) => {
                (StatusCode::CONFLICT, "team_run_conflict", message)
            }
            Self::Configuration(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "configuration_error",
                message,
            ),
            Self::Database(error) => {
                eprintln!("Rust control plane database error: {error}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal_error",
                    "Internal server error".to_owned(),
                )
            }
        };
        (status, Json(ErrorResponse { error, message })).into_response()
    }
}

