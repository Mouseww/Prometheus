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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn primary_agent_can_delegate_team_and_receive_results() {
    let fixture = spawn_delegate_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([92_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let coordinator_id = create_agent(&app, &provider_id, "Coordinator", "coordinates the team").await;
    let research_id = create_agent(&app, &provider_id, "Research", "research specialist").await;
    let review_id = create_agent(&app, &provider_id, "Review", "review specialist").await;
    let session_id = create_session(&app).await;
    append_user_message(&app, &session_id, "Delegate this goal to the specialist agents.").await;

    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/runs"))
                .header("content-type", "application/json")
                .body(Body::from(json!({ "agentId": coordinator_id }).to_string()))
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
        "Team delegation finished with Research result and Review result."
    );

    let events = list_events(&app, &session_id).await;
    let tool_completed = events
        .iter()
        .filter(|event| event["type"] == "tool.call.completed")
        .collect::<Vec<_>>();
    assert!(
        tool_completed.iter().any(|event| {
            event["payload"]["toolName"] == "delegate_team"
                && event["payload"]["isError"] == false
                && event["payload"]["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("Research result")
                && event["payload"]["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("Review result")
                && event["payload"]["output"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("Team completed")
        }),
        "delegate_team result missing: {tool_completed:?}"
    );

    // subagent tool inventory assertion is enforced inside the fixture
    assert!(
        fixture.seen_subagent_without_delegate.load(Ordering::SeqCst),
        "fixture never observed a subagent tool list without delegate_team"
    );
    assert!(
        fixture.seen_primary_with_delegate.load(Ordering::SeqCst),
        "fixture never observed primary tool list with delegate_team"
    );

    // self-delegation should not appear as available agent ids in schema; verify both workers used
    let teams = list_team_runs(&app, &session_id).await;
    assert_eq!(teams.len(), 1, "expected one nested team run: {teams:?}");
    let team = &teams[0];
    assert_eq!(team["status"], "completed");
    let task_agents: Vec<&str> = team["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["agentId"].as_str().unwrap())
        .collect();
    assert!(task_agents.contains(&research_id.as_str()));
    assert!(task_agents.contains(&review_id.as_str()));
    assert!(!task_agents.contains(&coordinator_id.as_str()));
}

struct FixtureHandle {
    port: u16,
    seen_primary_with_delegate: Arc<std::sync::atomic::AtomicBool>,
    seen_subagent_without_delegate: Arc<std::sync::atomic::AtomicBool>,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_delegate_fixture() -> FixtureHandle {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let keep_alive = Arc::new(AtomicU16::new(port));
    let keep_alive_thread = keep_alive.clone();
    let seen_primary = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen_subagent = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let seen_primary_thread = seen_primary.clone();
    let seen_subagent_thread = seen_subagent.clone();
    let worker_ids: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let worker_ids_thread = worker_ids.clone();

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
            let has_delegate = names.iter().any(|name| name == "delegate_team");
            let has_message = names.iter().any(|name| name == "send_team_message");

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
            let prior_tool = messages.iter().any(|message| {
                message.get("role").and_then(Value::as_str) == Some("tool")
                    || message
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .map(|items| !items.is_empty())
                        .unwrap_or(false)
            });

            let payload = if has_delegate {
                seen_primary_thread.store(true, Ordering::SeqCst);
                assert!(
                    !has_message,
                    "primary must not receive subagent message tools: {names:?}"
                );
                if !prior_tool {
                    let enum_ids = tools
                        .iter()
                        .find(|tool| tool.pointer("/function/name").and_then(Value::as_str) == Some("delegate_team"))
                        .and_then(|tool| tool.pointer("/function/parameters/properties/agentIds/items/enum"))
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    assert!(
                        enum_ids.len() >= 2,
                        "delegate_team schema missing eligible agents: {enum_ids:?}"
                    );
                    let research = enum_ids[0].as_str().unwrap().to_owned();
                    let review = enum_ids[1].as_str().unwrap().to_owned();
                    *worker_ids_thread.lock().expect("ids") = Some((research.clone(), review.clone()));
                    let args = json!({
                        "goal": "Produce independent research and review findings",
                        "agentIds": [research, review],
                        "maxConcurrency": 2,
                        "workspaceMode": "readonly",
                        "mergeStrategy": "manual"
                    })
                    .to_string();
                    tool_call_sse("msg-coord", "call-delegate-1", "delegate_team", &args)
                } else {
                    text_sse(
                        "msg-coord-final",
                        "Team delegation finished with Research result and Review result.",
                    )
                }
            } else {
                assert!(
                    !has_delegate,
                    "subagent unexpectedly received delegate_team: {names:?}"
                );
                if has_message {
                    seen_subagent_thread.store(true, Ordering::SeqCst);
                }
                if system.contains("research") {
                    text_sse("msg-research", "Research result: evidence collected.")
                } else if system.contains("review") {
                    text_sse("msg-review", "Review result: findings confirmed.")
                } else {
                    text_sse("msg-other", "Subagent completed.")
                }
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
        seen_primary_with_delegate: seen_primary,
        seen_subagent_without_delegate: seen_subagent,
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
    let mid = content.len().max(2) / 2;
    let mid = mid.min(content.len());
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
                .body(Body::from(json!({ "title": "Delegate team" }).to_string()))
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

async fn list_team_runs(app: &axum::Router, session_id: &str) -> Vec<Value> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{session_id}/team-runs"))
                .body(Body::empty())
                .expect("teams request"),
        )
        .await
        .expect("teams response");
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    body["teams"].as_array().cloned().unwrap_or_default()
}
