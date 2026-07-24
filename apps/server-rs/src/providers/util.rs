use crate::error::AppError;
use serde_json::Value;

pub fn parse_tool_arguments(raw: &str) -> Value {
    if raw.trim().is_empty() {
        return serde_json::json!({});
    }
    serde_json::from_str(raw).unwrap_or_else(|_| {
        serde_json::json!({
            "raw": raw,
        })
    })
}

pub fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        value.to_owned()
    } else {
        value.chars().take(max).collect()
    }
}

pub fn http_error(status: reqwest::StatusCode, detail: &str) -> AppError {
    AppError::provider_request_failed(format!(
        "Provider returned HTTP {status}: {}",
        truncate(detail, 400)
    ))
}
