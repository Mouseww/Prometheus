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
use futures_util::StreamExt;
use prometheus_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn deny_write_permission_skips_approval() {
    let fixture = spawn_write_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([31_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    create_permission_rule(&app, "write_file", "deny", "approved-note.txt").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Create an approved workspace note.").await;

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
        "Denied write was not executed."
    );
    assert!(!workspace.path().join("approved-note.txt").exists());

    let events = list_events(&app, &session_id).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert!(types.contains(&"permission.rule.matched"));
    assert!(!types.contains(&"approval.requested"));
    let matched = events
        .iter()
        .find(|event| event["type"] == "permission.rule.matched")
        .expect("matched event");
    assert_eq!(matched["payload"]["effect"], "deny");
    assert_eq!(matched["payload"]["toolName"], "write_file");
    let completed = events
        .iter()
        .find(|event| event["type"] == "tool.call.completed")
        .expect("tool completed");
    assert_eq!(completed["payload"]["isError"], true);
    assert_eq!(
        completed["payload"]["output"],
        "Tool execution denied by permission rule"
    );
}

#[tokio::test]
async fn allow_write_permission_skips_approval() {
    let fixture = spawn_write_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([32_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id, "Answer with verifiable evidence.").await;
    create_permission_rule(&app, "write_file", "allow", "approved-note.txt").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Create an approved workspace note.").await;

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
    assert!(types.contains(&"permission.rule.matched"));
    assert!(!types.contains(&"approval.requested"));
    let matched = events
        .iter()
        .find(|event| event["type"] == "permission.rule.matched")
        .expect("matched event");
    assert_eq!(matched["payload"]["effect"], "allow");
}

#[tokio::test]
async fn run_stream_snapshot_delta_and_clear_over_ws() {
    let fixture = spawn_stream_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([33_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    let client = reqwest::Client::new();
    let provider = client
        .post(format!("http://{addr}/api/providers"))
        .json(&json!({
            "name": "Stream fixture",
            "kind": "openai_compatible",
            "baseUrl": format!("http://127.0.0.1:{}/v1", fixture.port),
            "defaultModel": "fixture-model",
            "apiKey": "fixture-secret"
        }))
        .send()
        .await
        .expect("provider");
    assert_eq!(provider.status(), StatusCode::CREATED);
    let provider_body: Value = provider.json().await.expect("provider json");
    let provider_id = provider_body["provider"]["id"].as_str().unwrap().to_owned();

    let agent = client
        .post(format!("http://{addr}/api/agents"))
        .json(&json!({
            "name": "Streamer",
            "providerId": provider_id,
            "model": "fixture-model",
            "systemPrompt": "Answer with verifiable evidence."
        }))
        .send()
        .await
        .expect("agent");
    assert_eq!(agent.status(), StatusCode::CREATED);
    let agent_body: Value = agent.json().await.expect("agent json");
    let agent_id = agent_body["agent"]["id"].as_str().unwrap().to_owned();

    let session = client
        .post(format!("http://{addr}/api/sessions"))
        .json(&json!({ "title": "stream session" }))
        .send()
        .await
        .expect("session");
    assert_eq!(session.status(), StatusCode::CREATED);
    let session_body: Value = session.json().await.expect("session json");
    let session_id = session_body["session"]["id"].as_str().unwrap().to_owned();

    let seed = client
        .post(format!("http://{addr}/api/sessions/{session_id}/events"))
        .json(&json!({
            "eventId": Uuid::new_v4().to_string(),
            "type": "message.user",
            "actor": { "kind": "user", "id": "user", "label": "You" },
            "payload": { "text": "Stream a complete answer." }
        }))
        .send()
        .await
        .expect("seed");
    assert_eq!(seed.status(), StatusCode::CREATED);

    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/ws?sessionId={session_id}&afterSequence=0"
    ))
    .await
    .expect("websocket connect");

    let sync = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("sync timeout")
        .expect("sync frame")
        .expect("sync ok");
    let Message::Text(sync_text) = sync else {
        panic!("expected sync text");
    };
    let sync_json: Value = serde_json::from_str(&sync_text).expect("sync json");
    assert_eq!(sync_json["kind"], "sync");

    let run = client
        .post(format!("http://{addr}/api/sessions/{session_id}/runs"))
        .json(&json!({ "agentId": agent_id }))
        .send()
        .await
        .expect("run");
    assert_eq!(run.status(), StatusCode::CREATED);
    let run_body: Value = run.json().await.expect("run json");
    assert_eq!(
        run_body["run"]["replyEvent"]["payload"]["text"],
        "Streaming draft reply verified."
    );

    let mut saw_snapshot = false;
    let mut saw_delta = false;
    let mut saw_cleared = false;
    let mut assembled = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline
        && !(saw_snapshot && saw_delta && saw_cleared && !assembled.is_empty())
    {
        let frame = tokio::time::timeout(Duration::from_millis(500), socket.next())
            .await
            .ok()
            .and_then(|item| item)
            .and_then(Result::ok);
        let Some(Message::Text(text)) = frame else {
            continue;
        };
        let message: Value = serde_json::from_str(&text).expect("ws json");
        match message["kind"].as_str() {
            Some("run.stream.snapshot") => {
                saw_snapshot = true;
                assert_eq!(message["stream"]["sessionId"], session_id);
                assert_eq!(message["stream"]["agentLabel"], "Streamer");
            }
            Some("run.stream.delta") => {
                saw_delta = true;
                if let Some(delta) = message["delta"].as_str() {
                    assembled.push_str(delta);
                }
            }
            Some("run.stream.cleared") => {
                saw_cleared = true;
                assert_eq!(message["sessionId"], session_id);
            }
            _ => {}
        }
    }

    assert!(saw_snapshot, "missing run.stream.snapshot");
    assert!(saw_delta, "missing run.stream.delta");
    assert!(saw_cleared, "missing run.stream.cleared");
    assert_eq!(assembled, "Streaming draft reply verified.");
}

async fn create_permission_rule(app: &axum::Router, tool_name: &str, effect: &str, pattern: &str) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/permission-rules")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "toolName": tool_name,
                        "effect": effect,
                        "pattern": pattern
                    })
                    .to_string(),
                ))
                .expect("rule request"),
        )
        .await
        .expect("rule response");
    assert_eq!(response.status(), StatusCode::CREATED);
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
                        "name": "Tool Agent",
                        "providerId": provider_id,
                        "model": "fixture-model",
                        "systemPrompt": system_prompt
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
                .body(Body::from(
                    json!({ "title": "Permission stream" }).to_string(),
                ))
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

fn spawn_write_fixture() -> FixtureHandle {
    spawn_scripted_fixture("write")
}

fn spawn_stream_fixture() -> FixtureHandle {
    spawn_scripted_fixture("stream")
}

fn spawn_scripted_fixture(mode: &'static str) -> FixtureHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
    let turn = Arc::new(Mutex::new(0u32));
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
            assert_eq!(
                names,
                vec![
                    "list_directory",
                    "read_file",
                    "search_text",
                    "write_file",
                    "shell_command",
                ]
            );

            let messages = parsed
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut current = turn.lock().expect("turn");
            *current += 1;
            let step = *current;
            drop(current);

            let payload = match mode {
                "stream" => {
                    assert_eq!(step, 1);
                    sse_text_chunks(
                        "fixture-stream",
                        "Streaming draft reply verified.",
                    )
                }
                "write" => {
                    if step == 1 {
                        sse_tool_call(
                            "fixture-write",
                            "write_file",
                            &json!({
                                "path": "approved-note.txt",
                                "content": "Prometheus approval runtime verified.\n"
                            }),
                        )
                    } else {
                        let last = messages.last().cloned().unwrap_or(json!({}));
                        let content = last
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let final_text = if content.contains("denied by permission rule")
                            || content.contains("denied by user")
                        {
                            "Denied write was not executed."
                        } else {
                            "Approved write completed."
                        };
                        sse_text_chunks("fixture-write-final", final_text)
                    }
                }
                _ => panic!("unknown fixture mode"),
            };
            let _ = stream.write_all(payload.as_bytes());
        }
    });
    FixtureHandle {
        port,
        _keep_alive: keep_alive,
    }
}

fn sse_text_chunks(id: &str, content: &str) -> String {
    let first = content.chars().take(content.chars().count() / 2).collect::<String>();
    let second = content.chars().skip(content.chars().count() / 2).collect::<String>();
    let mut body = String::new();
    for (index, part) in [first.as_str(), second.as_str()].into_iter().enumerate() {
        if part.is_empty() {
            continue;
        }
        let chunk = json!({
            "id": id,
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "fixture-model",
            "choices": [{
                "index": 0,
                "delta": { "content": part },
                "finish_reason": if index == 1 { Value::String("stop".into()) } else { Value::Null }
            }]
        });
        body.push_str(&format!("data: {chunk}\n\n"));
    }
    body.push_str("data: [DONE]\n\n");
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

fn sse_tool_call(id: &str, name: &str, arguments: &Value) -> String {
    let args = arguments.to_string();
    let first = &args[..args.len() / 2];
    let second = &args[args.len() / 2..];
    let open = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": format!("{id}-call"),
                    "type": "function",
                    "function": { "name": name, "arguments": first }
                }]
            },
            "finish_reason": null
        }]
    });
    let close = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": 0,
        "model": "fixture-model",
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "function": { "arguments": second }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let body = format!("data: {open}\n\ndata: {close}\n\ndata: [DONE]\n\n");
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
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
