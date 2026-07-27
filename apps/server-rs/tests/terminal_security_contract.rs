//! 终端准入与鉴权的契约测试。
//!
//! 这些断言锁定的是安全边界本身，而不是实现细节：终端能力默认关闭、
//! 终端调用必须归属到会话、非公开路由在配置令牌后必须拒绝匿名访问。
//! 任何一条失败都意味着控制平面重新变成了无凭证远程 shell。

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use prometheus_server::{AppState, Config, build_router, terminal_policy::TerminalMode};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;

async fn body_json(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body bytes"),
    )
    .expect("json body")
}

fn exec_request(payload: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/api/terminal/exec")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .expect("request")
}

#[tokio::test]
async fn terminal_exec_is_forbidden_while_terminal_mode_is_disabled() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(":memory:");
    // 显式不调用 with_terminal_mode：默认值就应当是关闭。
    let app = build_router(AppState::open(config).await.expect("state"));

    let response = app
        .oneshot(exec_request(json!({
            "sessionId": "00000000-0000-4000-8000-000000000000",
            "command": "echo hi",
        })))
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(response).await["error"], "forbidden");
}

#[tokio::test]
async fn terminal_exec_requires_a_session_so_the_audit_chain_has_an_owner() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(":memory:")
        .with_terminal_mode(TerminalMode::Trusted);
    let app = build_router(AppState::open(config).await.expect("state"));

    let missing = app
        .clone()
        .oneshot(exec_request(json!({ "sessionId": "", "command": "echo hi" })))
        .await
        .expect("response");
    assert_eq!(missing.status(), StatusCode::BAD_REQUEST);

    // 语法合法但不存在的会话同样必须被拒绝——否则事件会落到一个凭空的会话上。
    let unknown = app
        .oneshot(exec_request(json!({
            "sessionId": "11111111-1111-4111-8111-111111111111",
            "command": "echo hi",
        })))
        .await
        .expect("response");
    assert!(
        unknown.status() == StatusCode::NOT_FOUND || unknown.status() == StatusCode::BAD_REQUEST,
        "unexpected status for unknown session: {}",
        unknown.status()
    );
}

#[tokio::test]
async fn trusted_terminal_execution_emits_a_complete_durable_audit_chain() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(":memory:")
        .with_terminal_mode(TerminalMode::Trusted);
    let app = build_router(AppState::open(config).await.expect("state"));

    let created = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "title": "terminal audit" }).to_string()))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(created.status(), StatusCode::CREATED);
    let session_id = body_json(created).await["session"]["id"]
        .as_str()
        .expect("session id")
        .to_owned();

    let executed = app
        .clone()
        .oneshot(exec_request(json!({
            "sessionId": session_id,
            "command": "echo prometheus",
        })))
        .await
        .expect("response");
    assert_eq!(executed.status(), StatusCode::OK);

    let events = app
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{session_id}/events?afterSequence=0"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    let kinds: Vec<String> = body_json(events).await["events"]
        .as_array()
        .expect("events array")
        .iter()
        .filter_map(|event| event["kind"].as_str().map(str::to_owned))
        .collect();

    // Trusted 模式跳过审批，但绝不跳过审计：起止两端都必须落盘。
    assert!(
        kinds.iter().any(|kind| kind == "tool.call.started"),
        "missing tool.call.started in {kinds:?}"
    );
    assert!(
        kinds.iter().any(|kind| kind == "tool.call.completed"),
        "missing tool.call.completed in {kinds:?}"
    );
}

#[tokio::test]
async fn configured_token_rejects_anonymous_api_access_but_keeps_health_public() {
    let workspace = tempdir().expect("workspace");
    let token = "0123456789abcdef0123";
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(":memory:")
        .with_access_token(token);
    let app = build_router(AppState::open(config).await.expect("state"));

    let anonymous = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(anonymous.status(), StatusCode::UNAUTHORIZED);

    let authorized = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(authorized.status(), StatusCode::OK);

    // health 必须保持公开，否则客户端无法区分「服务器离线」与「令牌错误」。
    let health = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(health.status(), StatusCode::OK);
    let body = body_json(health).await;
    assert_eq!(body["authRequired"], true);
    assert_eq!(body["terminalMode"], "disabled");
}
