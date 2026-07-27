//! 控制平面鉴权层。
//!
//! 设计原则：**默认拒绝优于默认放行**。
//! 一旦配置了 `PROMETHEUS_ACCESS_TOKEN`，所有 `/api/*` 与 `/ws*` 请求都必须携带凭证；
//! 未配置时仅在 loopback 绑定下放行（由 [`crate::config::Config::validate_security`] 在启动期保证）。
//!
//! WebSocket 升级握手无法自定义请求头（浏览器 `WebSocket` 构造器不支持），
//! 因此额外接受 `?token=` 查询参数——这是 WS 鉴权的通行做法。

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, Uri, header},
    middleware::Next,
    response::Response,
};

use crate::{error::AppError, state::AppState};

/// 从请求中提取调用方声明的 token。
///
/// 优先级：`Authorization: Bearer` > `X-Prometheus-Token` > `?token=`。
/// 查询参数排在最后，避免 token 意外进入日志时被当作首选凭证来源。
fn extract_token(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        let trimmed = value.trim();
        if let Some(token) = trimmed
            .strip_prefix("Bearer ")
            .or_else(|| trimmed.strip_prefix("bearer "))
        {
            let token = token.trim();
            if !token.is_empty() {
                return Some(token.to_owned());
            }
        }
    }
    if let Some(value) = headers
        .get("x-prometheus-token")
        .and_then(|value| value.to_str().ok())
    {
        let token = value.trim();
        if !token.is_empty() {
            return Some(token.to_owned());
        }
    }
    uri.query().and_then(|query| {
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            if key != "token" {
                return None;
            }
            let value = percent_decode(value);
            if value.is_empty() { None } else { Some(value) }
        })
    })
}

/// 最小的 percent-decoding：只需处理 `%XX` 与 `+`，token 字符集不含其它需转义字符。
fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        index += 3;
                    }
                    Err(_) => {
                        out.push(bytes[index]);
                        index += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                index += 1;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 常量时间比较，避免通过响应耗时逐字节爆破 token。
fn tokens_match(expected: &str, provided: &str) -> bool {
    let expected = expected.as_bytes();
    let provided = provided.as_bytes();
    if expected.len() != provided.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in expected.iter().zip(provided.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 需要鉴权的路径前缀。静态资源（前端 bundle）不在其中——它本身不含机密，
/// 且必须能在用户输入 token 之前加载出连接设置界面。
fn requires_auth(path: &str) -> bool {
    path.starts_with("/api/") || path == "/ws" || path.starts_with("/ws/")
}

/// 无需鉴权的白名单。`/api/health` 是客户端探活与协议协商入口，
/// 必须在未鉴权时也可达，否则前端无法区分"服务未启动"与"token 不对"。
fn is_public(path: &str) -> bool {
    path == "/api/health"
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let path = request.uri().path().to_owned();
    if !requires_auth(&path) || is_public(&path) {
        return Ok(next.run(request).await);
    }

    let expected = state.with_config(|config| config.access_token().map(str::to_owned))?;
    let Some(expected) = expected else {
        // 未配置 token：由启动期校验保证此时必为 loopback 绑定。
        return Ok(next.run(request).await);
    };

    let provided = extract_token(request.headers(), request.uri());
    match provided {
        Some(token) if tokens_match(&expected, &token) => Ok(next.run(request).await),
        Some(_) => Err(AppError::unauthorized("Invalid access token")),
        None => Err(AppError::unauthorized(
            "Missing access token. Send Authorization: Bearer <token> or ?token=<token>.",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderValue, Uri};

    fn headers_with(name: &'static str, value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn extracts_bearer_header() {
        let headers = headers_with("authorization", "Bearer abc123");
        let uri: Uri = "/api/sessions".parse().unwrap();
        assert_eq!(extract_token(&headers, &uri), Some("abc123".to_owned()));
    }

    #[test]
    fn extracts_custom_header() {
        let headers = headers_with("x-prometheus-token", "abc123");
        let uri: Uri = "/api/sessions".parse().unwrap();
        assert_eq!(extract_token(&headers, &uri), Some("abc123".to_owned()));
    }

    #[test]
    fn extracts_query_token_for_websocket_upgrade() {
        let headers = HeaderMap::new();
        let uri: Uri = "/ws?sessionId=x&token=abc%2B123".parse().unwrap();
        assert_eq!(extract_token(&headers, &uri), Some("abc+123".to_owned()));
    }

    #[test]
    fn header_takes_precedence_over_query() {
        let headers = headers_with("authorization", "Bearer from-header");
        let uri: Uri = "/ws?token=from-query".parse().unwrap();
        assert_eq!(
            extract_token(&headers, &uri),
            Some("from-header".to_owned())
        );
    }

    #[test]
    fn ignores_malformed_authorization_and_empty_tokens() {
        let uri: Uri = "/api/sessions".parse().unwrap();
        assert_eq!(extract_token(&headers_with("authorization", "Basic abc"), &uri), None);
        assert_eq!(extract_token(&headers_with("authorization", "Bearer   "), &uri), None);
        let empty_query: Uri = "/ws?token=".parse().unwrap();
        assert_eq!(extract_token(&HeaderMap::new(), &empty_query), None);
    }

    #[test]
    fn auth_scope_covers_api_and_ws_only() {
        assert!(requires_auth("/api/sessions"));
        assert!(requires_auth("/ws"));
        assert!(requires_auth("/ws/terminal"));
        assert!(!requires_auth("/"));
        assert!(!requires_auth("/assets/index.js"));
        assert!(!requires_auth("/apiary"));
    }

    #[test]
    fn health_stays_public_so_clients_can_distinguish_offline_from_unauthorized() {
        assert!(is_public("/api/health"));
        assert!(!is_public("/api/sessions"));
    }

    #[test]
    fn token_comparison_rejects_prefix_and_length_mismatch() {
        assert!(tokens_match("abc123", "abc123"));
        assert!(!tokens_match("abc123", "abc"));
        assert!(!tokens_match("abc", "abc123"));
        assert!(!tokens_match("abc123", "abc124"));
    }
}
