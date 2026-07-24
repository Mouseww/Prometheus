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
use uuid::Uuid;

#[tokio::test]
async fn readonly_tool_loop_contract() {
    let fixture = spawn_tool_fixture();
    let workspace = tempdir().expect("workspace");
    std::fs::write(
        workspace.path().join("README.md"),
        "# Prometheus\nverified workspace content\n",
    )
    .expect("readme");

    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([21_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Inspect the repository with tools.").await;

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
    assert_eq!(status, StatusCode::CREATED, "unexpected: {body}");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        "Workspace evidence: README identifies the project as Prometheus."
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
            "tool.call.started",
            "tool.call.completed",
            "message.agent",
            "agent.run.completed"
        ]
    );
    assert_eq!(events[2]["payload"]["toolName"], "read_file");
    assert_eq!(events[3]["payload"]["isError"], false);
    assert!(
        events[3]["payload"]["output"]
            .as_str()
            .unwrap()
            .contains("# Prometheus")
    );
}

#[tokio::test]
async fn write_file_requires_and_honors_approval() {
    let fixture = spawn_write_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([22_u8; 32]);
    let state = AppState::open(config).await.expect("state");
    let app = build_router(state.clone());

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Create an approved workspace note.").await;

    let run_app = app.clone();
    let run_session = session_id.clone();
    let run_agent = agent_id.clone();
    let run_task = tokio::spawn(async move {
        run_app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/sessions/{run_session}/runs"))
                    .header("content-type", "application/json")
                    .body(Body::from(json!({ "agentId": run_agent }).to_string()))
                    .expect("run request"),
            )
            .await
            .expect("run response")
    });

    let approval_id = wait_for_approval_id(&app, &session_id).await;
    let resolve = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/sessions/{session_id}/approvals/{approval_id}/resolution"
                ))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "decision": "approved" }).to_string()))
                .expect("resolve request"),
        )
        .await
        .expect("resolve response");
    assert_eq!(resolve.status(), StatusCode::OK);

    let response = run_task.await.expect("join");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::CREATED, "unexpected: {body}");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        "Approved write completed."
    );
    let written = std::fs::read_to_string(workspace.path().join("approved-note.txt"))
        .expect("written file");
    assert!(written.contains("Prometheus approval runtime verified."));

    let events = list_events(&app, &session_id).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert!(types.contains(&"approval.requested"));
    assert!(types.contains(&"approval.resolved"));
    assert!(types.contains(&"tool.call.completed"));
}

async fn wait_for_approval_id(app: &axum::Router, session_id: &str) -> String {
    for _ in 0..100 {
        let events = list_events(app, session_id).await;
        if let Some(event) = events
            .iter()
            .rev()
            .find(|event| event["type"] == "approval.requested")
        {
            return event["payload"]["approvalId"]
                .as_str()
                .expect("approval id")
                .to_owned();
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("approval was not requested");
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
                        "description": "tools",
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
                .body(Body::from(json!({ "title": "Tool runtime" }).to_string()))
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

fn spawn_tool_fixture() -> FixtureHandle {
    spawn_scripted_fixture(Arc::new(Mutex::new(0)), "readonly")
}

fn spawn_write_fixture() -> FixtureHandle {
    spawn_scripted_fixture(Arc::new(Mutex::new(0)), "write")
}

fn spawn_scripted_fixture(turn: Arc<Mutex<u32>>, mode: &'static str) -> FixtureHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
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
            if !headers.lines().next().unwrap_or_default().starts_with("POST /v1/chat/completions")
            {
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
                continue;
            }
            if !headers.to_ascii_lowercase().contains("authorization: bearer fixture-secret") {
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
            assert_eq!(
                names,
                vec![
                    "list_directory",
                    "read_file",
                    "search_text",
                    "write_file",
                    "shell_command"
                ]
            );

            let mut turn_guard = turn.lock().expect("turn");
            *turn_guard += 1;
            let current = *turn_guard;
            drop(turn_guard);

            let payload = if mode == "readonly" {
                if current == 1 {
                    tool_call_sse(
                        "fixture-tool-request",
                        "fixture-read-1",
                        "read_file",
                        r#"{"path":"README.md"}"#,
                    )
                } else {
                    text_sse(
                        "fixture-tool-final",
                        "Workspace evidence: README identifies the project as Prometheus.",
                    )
                }
            } else if current == 1 {
                tool_call_sse(
                    "fixture-write-approved-request",
                    "fixture-write-approved",
                    "write_file",
                    r#"{"path":"approved-note.txt","content":"Prometheus approval runtime verified.\n"}"#,
                )
            } else {
                text_sse("fixture-write-final", "Approved write completed.")
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
            "finish_reason": "tool_calls"
        }]
    });
    let chunk3 = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 4,
            "total_tokens": 14
        }
    });
    format!(
        "data: {chunk1}\n\ndata: {chunk2}\n\ndata: {chunk3}\n\ndata: [DONE]\n\n",
        chunk1 = chunk1,
        chunk2 = chunk2,
        chunk3 = chunk3
    )
}
fn text_sse(id: &str, content: &str) -> String {
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
        payload.push_str(&format!(
            "data: {{\"id\":\"{id}\",\"object\":\"chat.completion.chunk\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{}}},\"finish_reason\":{finish}}}]}}\n\n",
            serde_json::to_string(part).unwrap()
        ));
    }
    payload.push_str(&format!(
        "data: {{\"id\":\"{id}\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":8,\"total_tokens\":18}}}}\n\n"
    ));
    payload.push_str("data: [DONE]\n\n");
    payload
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
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
    request
}

fn find_header_end(request: &[u8]) -> Option<usize> {
    request
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}


