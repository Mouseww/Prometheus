use std::{
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skills_are_listed_and_injected_into_agent_tools() {
    let workspace = tempdir().expect("workspace");
    let skill_dir = workspace.path().join(".prometheus").join("skills").join("demo-skill");
    std::fs::create_dir_all(&skill_dir).expect("skill dir");
    std::fs::write(
        skill_dir.join("SKILL.md"),
        "---\nname: Demo Skill\ndescription: Demonstrates durable skill loading\n---\n\n# Demo\nUse this skill for contract tests.\n",
    )
    .expect("skill file");

    let fixture = spawn_openai_fixture();
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([51_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let skills = list_skills(&app).await;
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0]["id"], "demo-skill");
    assert_eq!(skills[0]["name"], "Demo Skill");

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id).await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Load the demo skill and answer.").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": agent_id }).to_string()))
                .expect("run"),
        )
        .await
        .expect("run resp");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        "Skill content verified for demo-skill."
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_server_tools_are_available_to_agent_loop() {
    let workspace = tempdir().expect("workspace");
    let fixture = spawn_openai_fixture();
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([52_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/mcp_echo_fixture.py")
        .canonicalize()
        .expect("fixture script");
    let created = create_mcp_server(
        &app,
        "echo",
        "python",
        vec![script.display().to_string()],
    )
    .await;
    assert_eq!(created["name"], "echo");
    assert_eq!(created["enabled"], true);

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let agent_id = create_agent(&app, &provider_id).await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Use MCP echo tool.").await;

    // Allow MCP tool without interactive approval using allow rule
    create_permission_rule(&app, "mcp__echo__echo", "allow", "*").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": agent_id }).to_string()))
                .expect("run"),
        )
        .await
        .expect("run resp");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        "MCP echo returned echo:hello-from-mcp."
    );
}

struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_openai_fixture() -> FixtureHandle {
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
            let messages = parsed
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let prior_tool = messages
                .iter()
                .any(|message| message.get("role").and_then(Value::as_str) == Some("tool"));

            let payload = if names.iter().any(|name| name == "read_skill") {
                if !prior_tool {
                    tool_call_sse(
                        "skill-1",
                        "call-skill-1",
                        "read_skill",
                        r#"{"skillId":"demo-skill"}"#,
                    )
                } else {
                    text_sse("skill-final", "Skill content verified for demo-skill.")
                }
            } else if names.iter().any(|name| name == "mcp__echo__echo") {
                if !prior_tool {
                    tool_call_sse(
                        "mcp-1",
                        "call-mcp-1",
                        "mcp__echo__echo",
                        r#"{"message":"hello-from-mcp"}"#,
                    )
                } else {
                    text_sse("mcp-final", "MCP echo returned echo:hello-from-mcp.")
                }
            } else {
                text_sse("plain", "No extension tools exposed.")
            };
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                payload.len(),
                payload
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
                    "function": { "name": name, "arguments": &arguments[..mid] }
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
                    "function": { "arguments": &arguments[mid..] }
                }]
            },
            "finish_reason": Value::Null
        }]
    });
    let done = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "tool_calls" }]
    });
    format!("data: {chunk1}\n\ndata: {chunk2}\n\ndata: {done}\n\ndata: [DONE]\n\n")
}

fn text_sse(id: &str, content: &str) -> String {
    let mid = content.len().max(2) / 2;
    let parts = [&content[..mid], &content[mid..]];
    let mut payload = String::new();
    for (index, part) in parts.iter().enumerate() {
        let finish = if index + 1 == parts.len() { "\"stop\"" } else { "null" };
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
                if let Some(end) = find_header_end(&buffer) {
                    if let Some(length) = content_length(&buffer[..end]) {
                        if buffer.len() >= end + length {
                            break;
                        }
                    } else {
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

fn content_length(headers: &[u8]) -> Option<usize> {
    let text = String::from_utf8_lossy(headers);
    for line in text.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            return value.trim().parse().ok();
        }
    }
    None
}

async fn list_skills(app: &axum::Router) -> Vec<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/skills")
                .body(Body::empty())
                .expect("skills"),
        )
        .await
        .expect("skills resp");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["skills"].as_array().cloned().unwrap_or_default()
}

async fn create_mcp_server(
    app: &axum::Router,
    name: &str,
    command: &str,
    args: Vec<String>,
) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/mcp-servers")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": name,
                        "command": command,
                        "args": args,
                        "enabled": true
                    })
                    .to_string(),
                ))
                .expect("mcp"),
        )
        .await
        .expect("mcp resp");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::CREATED, "{body}");
    body["server"].clone()
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
                .expect("rule"),
        )
        .await
        .expect("rule resp");
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
                        "name": "Fixture",
                        "kind": "openai_compatible",
                        "baseUrl": base_url,
                        "defaultModel": "fixture-model",
                        "apiKey": api_key
                    })
                    .to_string(),
                ))
                .expect("provider"),
        )
        .await
        .expect("provider resp");
    assert_eq!(response.status(), StatusCode::CREATED);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["provider"]["id"].as_str().unwrap().to_owned()
}

async fn create_agent(app: &axum::Router, provider_id: &str) -> String {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Extension Agent",
                        "description": "skills and mcp",
                        "systemPrompt": "Use available skills and MCP tools when relevant.",
                        "providerId": provider_id,
                        "model": "fixture-model"
                    })
                    .to_string(),
                ))
                .expect("agent"),
        )
        .await
        .expect("agent resp");
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
                .body(Body::from(json!({ "title": "Skills MCP" }).to_string()))
                .expect("session"),
        )
        .await
        .expect("session resp");
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
                .expect("event"),
        )
        .await
        .expect("event resp");
    assert_eq!(response.status(), StatusCode::CREATED);
}
