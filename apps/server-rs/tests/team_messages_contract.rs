use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn team_message_bus_persists_and_lists_visible_messages() {
    let fixture = spawn_message_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([91_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let research_id = create_agent(&app, &provider_id, "Research", "research").await;
    let review_id = create_agent(&app, &provider_id, "Review", "review").await;
    let session_id = create_session(&app).await;

    let launch = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/team-runs"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "goal": "Coordinate over the durable message bus",
                        "agentIds": [research_id, review_id],
                        "maxConcurrency": 2,
                        "workspaceMode": "readonly",
                        "mergeStrategy": "manual"
                    })
                    .to_string(),
                ))
                .expect("launch"),
        )
        .await
        .expect("launch resp");
    let status = launch.status();
    let launch_body: Value = serde_json::from_slice(
        &to_bytes(launch.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::ACCEPTED, "unexpected: {launch_body}");
    let team_id = launch_body["team"]["id"].as_str().unwrap().to_owned();

    let team = wait_for_team(&app, &team_id, "completed").await;
    assert_eq!(team["status"], "completed");

    let messages = list_team_messages(&app, &team_id, 0).await;
    assert!(
        messages.len() >= 2,
        "expected shared + parent messages, got {messages:?}"
    );
    assert!(messages.iter().any(|message| {
        message["recipientId"] == "*"
            && message["channel"] == "decision"
            && message["body"]
                .as_str()
                .unwrap_or_default()
                .contains("durable event log")
    }));
    assert!(messages.iter().any(|message| {
        message["recipientId"] == "parent"
            && message["body"]
                .as_str()
                .unwrap_or_default()
                .contains("Review completed")
    }));

    let first_sequence = messages[0]["sequence"].as_i64().unwrap();
    let after = list_team_messages(&app, &team_id, first_sequence).await;
    assert_eq!(after.len(), messages.len() - 1);

    let events = list_events(&app, &session_id).await;
    let agent_messages = events
        .iter()
        .filter(|event| event["type"] == "agent.message")
        .count();
    assert!(agent_messages >= 2);

    let missing = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/api/team-runs/{}/messages?afterSequence=0",
                    uuid::Uuid::new_v4()
                ))
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_message_fixture() -> FixtureHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
    let turn = Arc::new(Mutex::new(0_u32));
    thread::spawn(move || {
        while keep_alive_thread.load(Ordering::SeqCst) != 0 {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let request = read_http_request(&mut stream);
            let Some(header_end) = find_header_end(&request) else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            if !headers
                .lines()
                .next()
                .unwrap_or_default()
                .starts_with("POST /v1/chat/completions")
            {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            if !headers
                .to_ascii_lowercase()
                .contains("authorization: bearer fixture-secret")
            {
                let _ = stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            let body = String::from_utf8_lossy(&request[header_end..]);
            let parsed: Value = serde_json::from_str(body.trim()).unwrap_or(json!({}));
            let tools = parsed
                .get("tools")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let names: Vec<String> = tools
                .iter()
                .filter_map(|tool| {
                    tool.pointer("/function/name")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect();
            assert!(
                names.contains(&"send_team_message".to_owned())
                    && names.contains(&"read_team_messages".to_owned()),
                "message tools missing: {names:?}"
            );

            let messages = parsed
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let system = messages
                .iter()
                .find(|message| message.get("role").and_then(Value::as_str) == Some("system"))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();

            let mut guard = turn.lock().expect("turn");
            *guard += 1;
            let current = *guard;
            drop(guard);

            let payload = if system.contains("research") {
                if current == 1 || current == 2 {
                    // both agents may race; use content of user message to branch more reliably below
                }
                // determine by system prompt each connection independently via per-request system
                if system.contains("research") {
                    // first turn send shared decision, second final text
                    let prior_tools = messages.iter().any(|message| {
                        message
                            .get("tool_calls")
                            .and_then(Value::as_array)
                            .map(|items| !items.is_empty())
                            .unwrap_or(false)
                            || message.get("role").and_then(Value::as_str) == Some("tool")
                    });
                    if !prior_tools {
                        tool_call_sse(
                            "msg-research",
                            "call-research-1",
                            "send_team_message",
                            r#"{"to":"*","channel":"decision","subject":"Evidence boundary","message":"Use the durable event log as the source of truth."}"#,
                        )
                    } else {
                        text_sse("msg-research-final", "Research subagent completed.")
                    }
                } else {
                    let prior_tools = messages.iter().any(|message| {
                        message.get("role").and_then(Value::as_str) == Some("tool")
                    });
                    if !prior_tools {
                        tool_call_sse(
                            "msg-review",
                            "call-review-1",
                            "send_team_message",
                            r#"{"to":"parent","channel":"direct","message":"Review completed."}"#,
                        )
                    } else {
                        text_sse("msg-review-final", "Review subagent completed.")
                    }
                }
            } else {
                let prior_tools = messages.iter().any(|message| {
                    message.get("role").and_then(Value::as_str) == Some("tool")
                });
                if !prior_tools {
                    tool_call_sse(
                        "msg-review",
                        "call-review-1",
                        "send_team_message",
                        r#"{"to":"parent","channel":"direct","message":"Review completed."}"#,
                    )
                } else {
                    text_sse("msg-review-final", "Review subagent completed.")
                }
            };

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                payload.as_bytes().len()
            );
            let _ = stream.write_all(response.as_bytes());
        }
    });
    thread::sleep(Duration::from_millis(20));
    FixtureHandle {
        port,
        _keep_alive: keep_alive,
    }
}

fn tool_call_sse(id: &str, call_id: &str, name: &str, arguments: &str) -> String {
    let mid = arguments.len() / 2;
    let chunk1 = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": &arguments[..mid]
                    }
                }]
            },
            "finish_reason": Value::Null
        }]
    });
    let chunk2 = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "function": {
                        "arguments": &arguments[mid..]
                    }
                }]
            },
            "finish_reason": Value::Null
        }]
    });
    let done = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": "tool_calls"
        }]
    });
    format!("data: {chunk1}\n\ndata: {chunk2}\n\ndata: {done}\n\ndata: [DONE]\n\n")
}

fn text_sse(id: &str, content: &str) -> String {
    let mid = content.len() / 2;
    let parts = [&content[..mid], &content[mid..]];
    let mut payload = String::new();
    for (index, part) in parts.iter().enumerate() {
        let finish = if index + 1 == parts.len() {
            "\"stop\""
        } else {
            "null"
        };
        payload.push_str(&format!(
            "data: {{\"id\":\"{id}\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":{finish}}}]}}\n\n",
            serde_json::to_string(part).unwrap()
        ));
    }
    payload.push_str("data: [DONE]\n\n");
    payload
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(header_end) = find_header_end(&buffer) {
                    let headers = String::from_utf8_lossy(&buffer[..header_end]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buffer.len() >= header_end + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }
    buffer
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
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
                        "name": "Fixture",
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

async fn create_agent(app: &axum::Router, provider_id: &str, name: &str, description: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": name,
                        "description": description,
                        "systemPrompt": format!("You are {name}."),
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
                .body(Body::from(json!({ "title": "Message bus" }).to_string()))
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

async fn wait_for_team(app: &axum::Router, team_id: &str, status: &str) -> Value {
    for _ in 0..200 {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/team-runs/{team_id}"))
                    .body(Body::empty())
                    .expect("get request"),
            )
            .await
            .expect("get response");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), 1024 * 1024)
                .await
                .expect("body"),
        )
        .expect("json");
        if body["team"]["status"].as_str() == Some(status) {
            return body["team"].clone();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("team did not reach status {status}");
}

async fn list_team_messages(app: &axum::Router, team_id: &str, after_sequence: i64) -> Vec<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/team-runs/{team_id}/messages?afterSequence={after_sequence}"
                ))
                .body(Body::empty())
                .expect("messages request"),
        )
        .await
        .expect("messages response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["messages"].as_array().cloned().unwrap_or_default()
}

async fn list_events(app: &axum::Router, session_id: &str) -> Vec<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{session_id}/events"))
                .body(Body::empty())
                .expect("events request"),
        )
        .await
        .expect("events response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["events"].as_array().cloned().unwrap_or_default()
}
