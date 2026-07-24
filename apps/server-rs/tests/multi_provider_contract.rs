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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn anthropic_provider_stream_and_tool_loop_contract() {
    let fixture = spawn_anthropic_fixture();
    run_provider_contract(
        "anthropic",
        &format!("http://127.0.0.1:{}", fixture.port),
        "anthropic-secret",
        "Fixture Anthropic reply with tool evidence.",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn gemini_provider_stream_and_tool_loop_contract() {
    let fixture = spawn_gemini_fixture();
    run_provider_contract(
        "gemini",
        &format!("http://127.0.0.1:{}", fixture.port),
        "gemini-secret",
        "Fixture Gemini reply with tool evidence.",
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openai_responses_provider_stream_contract() {
    let fixture = spawn_openai_responses_fixture();
    run_provider_contract(
        "openai",
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "openai-secret",
        "Fixture OpenAI Responses reply.",
    )
    .await;
}

async fn run_provider_contract(kind: &str, base_url: &str, api_key: &str, expected_reply: &str) {
    let workspace = tempdir().expect("workspace");
    std::fs::write(
        workspace.path().join("README.md"),
        "# Prometheus\nmulti-provider evidence\n",
    )
    .expect("readme");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([41_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(&app, kind, base_url, api_key).await;
    let agent_id = create_agent(&app, &provider_id).await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Use tools when needed and answer.").await;

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
    assert_eq!(status, StatusCode::CREATED, "kind={kind} unexpected: {body}");
    assert_eq!(
        body["run"]["replyEvent"]["payload"]["text"],
        expected_reply,
        "kind={kind}"
    );
}

struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_anthropic_fixture() -> FixtureHandle {
    spawn_fixture(|headers, body| {
        if !headers.to_ascii_lowercase().contains("x-api-key: anthropic-secret") {
            return None;
        }
        if !headers.lines().next().unwrap_or_default().starts_with("POST /v1/messages") {
            return Some(http_status(404, b""));
        }
        let parsed: Value = serde_json::from_str(body.trim()).unwrap_or(json!({}));
        let has_tool_result = parsed
            .pointer("/messages")
            .and_then(Value::as_array)
            .map(|messages| {
                messages.iter().any(|message| {
                    message
                        .pointer("/content/0/type")
                        .and_then(Value::as_str)
                        == Some("tool_result")
                })
            })
            .unwrap_or(false);
        let payload = if has_tool_result {
            anthropic_text_sse("msg-a-final", "Fixture Anthropic reply with tool evidence.")
        } else {
            anthropic_tool_sse(
                "msg-a-tool",
                "toolu_1",
                "read_file",
                r#"{"path":"README.md"}"#,
            )
        };
        Some(sse_response(&payload))
    })
}

fn spawn_gemini_fixture() -> FixtureHandle {
    spawn_fixture(|headers, body| {
        if !headers.to_ascii_lowercase().contains("x-goog-api-key: gemini-secret") {
            return None;
        }
        if !headers
            .lines()
            .next()
            .unwrap_or_default()
            .contains(":streamGenerateContent")
        {
            return Some(http_status(404, b""));
        }
        let parsed: Value = serde_json::from_str(body.trim()).unwrap_or(json!({}));
        let has_tool_result = parsed
            .pointer("/contents")
            .and_then(Value::as_array)
            .map(|contents| {
                contents.iter().any(|content| {
                    content
                        .pointer("/parts/0/functionResponse")
                        .is_some()
                })
            })
            .unwrap_or(false);
        let payload = if has_tool_result {
            gemini_text_sse("resp-g-final", "Fixture Gemini reply with tool evidence.")
        } else {
            gemini_tool_sse("resp-g-tool", "call-g-1", "read_file", r#"{"path":"README.md"}"#)
        };
        Some(sse_response(&payload))
    })
}

fn spawn_openai_responses_fixture() -> FixtureHandle {
    spawn_fixture(|headers, body| {
        if !headers
            .to_ascii_lowercase()
            .contains("authorization: bearer openai-secret")
        {
            return None;
        }
        if !headers
            .lines()
            .next()
            .unwrap_or_default()
            .starts_with("POST /v1/responses")
        {
            return Some(http_status(404, b""));
        }
        let _ = body;
        let payload = openai_responses_text_sse(
            "resp_openai_1",
            "Fixture OpenAI Responses reply.",
        );
        Some(sse_response(&payload))
    })
}

fn spawn_fixture<F>(handler: F) -> FixtureHandle
where
    F: Fn(&str, &str) -> Option<Vec<u8>> + Send + Sync + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
    let handler = Arc::new(handler);
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
            let headers = String::from_utf8_lossy(&request[..header_end])
                .replace('\r', "")
                .to_string();
            let body = String::from_utf8_lossy(&request[header_end..]).to_string();
            let response = handler(&headers, &body).unwrap_or_else(|| http_status(401, b""));
            let _ = stream.write_all(&response);
        }
    });
    thread::sleep(Duration::from_millis(20));
    FixtureHandle {
        port,
        _keep_alive: keep_alive,
    }
}

fn anthropic_tool_sse(id: &str, tool_id: &str, name: &str, arguments: &str) -> String {
    let start = json!({
        "type": "message_start",
        "message": {
            "id": id,
            "usage": { "input_tokens": 11 }
        }
    });
    let block_start = json!({
        "type": "content_block_start",
        "index": 0,
        "content_block": {
            "type": "tool_use",
            "id": tool_id,
            "name": name
        }
    });
    let mid = arguments.len() / 2;
    let delta1 = json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": { "type": "input_json_delta", "partial_json": &arguments[..mid] }
    });
    let delta2 = json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": { "type": "input_json_delta", "partial_json": &arguments[mid..] }
    });
    let message_delta = json!({
        "type": "message_delta",
        "usage": { "output_tokens": 7 }
    });
    format!(
        "event: message_start\ndata: {start}\n\nevent: content_block_start\ndata: {block_start}\n\nevent: content_block_delta\ndata: {delta1}\n\nevent: content_block_delta\ndata: {delta2}\n\nevent: message_delta\ndata: {message_delta}\n\n"
    )
}

fn anthropic_text_sse(id: &str, text: &str) -> String {
    let start = json!({
        "type": "message_start",
        "message": {
            "id": id,
            "usage": { "input_tokens": 9 }
        }
    });
    let mid = text.len().max(2) / 2;
    let d1 = json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": { "type": "text_delta", "text": &text[..mid] }
    });
    let d2 = json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": { "type": "text_delta", "text": &text[mid..] }
    });
    let message_delta = json!({
        "type": "message_delta",
        "usage": { "output_tokens": 5 }
    });
    format!(
        "event: message_start\ndata: {start}\n\nevent: content_block_delta\ndata: {d1}\n\nevent: content_block_delta\ndata: {d2}\n\nevent: message_delta\ndata: {message_delta}\n\n"
    )
}

fn gemini_tool_sse(response_id: &str, call_id: &str, name: &str, arguments: &str) -> String {
    let args: Value = serde_json::from_str(arguments).unwrap_or(json!({}));
    let payload = json!({
        "responseId": response_id,
        "candidates": [{
            "content": {
                "parts": [{
                    "functionCall": {
                        "id": call_id,
                        "name": name,
                        "args": args
                    }
                }]
            }
        }],
        "usageMetadata": {
            "promptTokenCount": 8,
            "candidatesTokenCount": 4,
            "totalTokenCount": 12
        }
    });
    format!("data: {payload}\n\n")
}

fn gemini_text_sse(response_id: &str, text: &str) -> String {
    let mid = text.len().max(2) / 2;
    let c1 = json!({
        "responseId": response_id,
        "candidates": [{
            "content": { "parts": [{ "text": &text[..mid] }] }
        }]
    });
    let c2 = json!({
        "responseId": response_id,
        "candidates": [{
            "content": { "parts": [{ "text": &text[mid..] }] }
        }],
        "usageMetadata": {
            "promptTokenCount": 8,
            "candidatesTokenCount": 6,
            "totalTokenCount": 14
        }
    });
    format!("data: {c1}\n\ndata: {c2}\n\n")
}

fn openai_responses_text_sse(id: &str, text: &str) -> String {
    let mid = text.len().max(2) / 2;
    let d1 = json!({
        "type": "response.output_text.delta",
        "delta": &text[..mid]
    });
    let d2 = json!({
        "type": "response.output_text.delta",
        "delta": &text[mid..]
    });
    let completed = json!({
        "type": "response.completed",
        "response": {
            "id": id,
            "output_text": text,
            "output": [],
            "usage": {
                "input_tokens": 5,
                "output_tokens": 7,
                "total_tokens": 12
            }
        }
    });
    format!("data: {d1}\n\ndata: {d2}\n\ndata: {completed}\n\ndata: [DONE]\n\n")
}

fn sse_response(payload: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    )
    .into_bytes()
}

fn http_status(status: u16, body: &[u8]) -> Vec<u8> {
    let reason = if status == 404 { "Not Found" } else { "Unauthorized" };
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(body.iter().copied())
    .collect()
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

async fn create_provider(app: &axum::Router, kind: &str, base_url: &str, api_key: &str) -> String {
    let mut body = json!({
        "name": format!("{kind}-fixture"),
        "kind": kind,
        "defaultModel": "fixture-model",
        "apiKey": api_key
    });
    if kind != "gemini" {
        body["baseUrl"] = json!(base_url);
    } else {
        // Gemini adapter accepts optional base_url override for local fixtures.
        body["baseUrl"] = json!(base_url);
    }
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/providers")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
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
                        "name": "MultiProvider Agent",
                        "description": "provider contract agent",
                        "systemPrompt": "Answer with verifiable evidence.",
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
                .body(Body::from(json!({ "title": "Multi provider" }).to_string()))
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
