use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
    },
    thread,
    time::Duration,
};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use prometheus_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn agent_run_success_contract() {
    let fixture = spawn_openai_fixture(true);
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([11_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Verify the complete runtime path.").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": agent_id }).to_string()))
                .expect("run request"),
        )
        .await
        .expect("run response");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::CREATED, "unexpected run response: {body}");
    assert!(body["run"]["runId"].as_str().is_some());
    assert_eq!(body["run"]["replyEvent"]["type"], "message.agent");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        "Fixture provider reply: end-to-end runtime works."
    );
    assert_eq!(body["run"]["completedEvent"]["type"], "agent.run.completed");
    assert_eq!(
        body["run"]["completedEvent"]["payload"]["usage"]["totalTokens"],
        18
    );

    let events = list_events(&app, &session_id).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert_eq!(
        types,
        vec![
            "message.user",
            "agent.run.started",
            "message.agent",
            "agent.run.completed"
        ]
    );
}

#[tokio::test]
async fn agent_run_requires_user_message() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([12_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));
    let provider_id = create_provider(&app, "http://127.0.0.1:9/v1", "secret").await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    let session_id = create_session(&app).await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": agent_id }).to_string()))
                .expect("run request"),
        )
        .await
        .expect("run response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["error"], "configuration_not_found");
}

#[tokio::test]
async fn agent_run_provider_failure_is_durable() {
    let fixture = spawn_openai_fixture(false);
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([13_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));
    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "wrong-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "This should fail against fixture auth.").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": agent_id }).to_string()))
                .expect("run request"),
        )
        .await
        .expect("run response");
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["error"], "provider_request_failed");

    let events = list_events(&app, &session_id).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert!(types.contains(&"agent.run.started"));
    assert!(types.contains(&"agent.run.failed"));
    assert!(!types.contains(&"message.agent"));
}

#[tokio::test]
async fn residual_apply_and_messages_routes_are_live() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"));
    let app = build_router(AppState::open(config).await.expect("state"));
    let team_run_id = Uuid::new_v4();
    let task_id = Uuid::new_v4();

    for uri in [
        format!("/api/team-runs/{team_run_id}/tasks/{task_id}/apply"),
        format!("/api/team-runs/{team_run_id}/tasks/{task_id}/discard"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("response");
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("body"),
        )
        .expect("json");
        assert_eq!(body["error"], "team_run_not_found");
    }

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/api/team-runs/{team_run_id}/messages"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["error"], "team_run_not_found");
}

async fn create_provider(app: &axum::Router, base_url: &str, api_key: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/providers")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Local protocol fixture",
                        "kind": "openai_compatible",
                        "baseUrl": base_url,
                        "defaultModel": "fixture-model",
                        "apiKey": api_key
                    })
                    .to_string(),
                ))
                .expect("provider request"),
        )
        .await
        .expect("provider response");
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["provider"]["id"].as_str().unwrap().to_owned()
}

async fn create_agent(app: &axum::Router, provider_id: &str, system_prompt: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Runtime verifier",
                        "description": "Validates the real provider path",
                        "systemPrompt": system_prompt,
                        "providerId": provider_id,
                        "model": "fixture-model"
                    })
                    .to_string(),
                ))
                .expect("agent request"),
        )
        .await
        .expect("agent response");
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["agent"]["id"].as_str().unwrap().to_owned()
}

async fn create_session(app: &axum::Router) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "title": "Runtime integration" }).to_string()))
                .expect("session request"),
        )
        .await
        .expect("session response");
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["session"]["id"].as_str().unwrap().to_owned()
}

async fn append_user_message(app: &axum::Router, session_id: &str, text: &str) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/events"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "eventId": Uuid::new_v4().to_string(),
                        "type": "message.user",
                        "actor": { "kind": "user", "id": "user", "label": "You" },
                        "payload": { "text": text }
                    })
                    .to_string(),
                ))
                .expect("event request"),
        )
        .await
        .expect("event response");
    assert_eq!(response.status(), StatusCode::CREATED);
}

async fn list_events(app: &axum::Router, session_id: &str) -> Vec<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{session_id}/events"))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["events"].as_array().cloned().unwrap_or_default()
}

struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_openai_fixture(accept_secret: bool) -> FixtureHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
    thread::spawn(move || {
        while keep_alive_thread.load(Ordering::SeqCst) != 0 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                match stream.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        request.extend_from_slice(&buffer[..n]);
                        if let Some(header_end) = find_header_end(&request) {
                            let headers = String::from_utf8_lossy(&request[..header_end]);
                            let content_length = headers
                                .lines()
                                .find_map(|line| {
                                    line.to_ascii_lowercase()
                                        .strip_prefix("content-length:")
                                        .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                                })
                                .unwrap_or(0);
                            if request.len() >= header_end + content_length {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                }
            }

            let Some(header_end) = find_header_end(&request) else {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            if !headers.lines().next().unwrap_or_default().starts_with("POST /v1/chat/completions") {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            let headers_lower = headers.to_ascii_lowercase();
            let auth_ok = if accept_secret {
                headers_lower.contains("authorization: bearer fixture-secret")
            } else {
                false
            };
            if !auth_ok {
                let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
                continue;
            }

            let body = String::from_utf8_lossy(&request[header_end..]);
            let parsed: Value = match serde_json::from_str(body.trim()) {
                Ok(value) => value,
                Err(_) => {
                    let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                    continue;
                }
            };
            if parsed.get("model").and_then(Value::as_str) != Some("fixture-model")
                || parsed.get("stream") != Some(&Value::Bool(true))
            {
                let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
                continue;
            }

            let content = "Fixture provider reply: end-to-end runtime works.";
            let first = content.len() / 3;
            let second = (content.len() * 2) / 3;
            let parts = [
                &content[..first],
                &content[first..second],
                &content[second..],
            ];
            let mut payload = String::new();
            for (index, part) in parts.iter().enumerate() {
                let finish = if index + 1 == parts.len() {
                    "\"stop\""
                } else {
                    "null"
                };
                let content_json = serde_json::to_string(part).expect("content json");
                payload.push_str("data: ");
                payload.push_str(&format!(
                    "{{\"id\":\"fixture-run\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{content_json}}},\"finish_reason\":{finish}}}]}}"
                ));
                payload.push_str("\n\n");
            }
            payload.push_str(
                "data: {\"id\":\"fixture-run\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":8,\"total_tokens\":18}}\n\n",
            );
            payload.push_str("data: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                payload.as_bytes().len(),
                payload
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    thread::sleep(Duration::from_millis(30));
    FixtureHandle {
        port,
        _keep_alive: keep_alive,
    }
}

fn find_header_end(request: &[u8]) -> Option<usize> {
    request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}


