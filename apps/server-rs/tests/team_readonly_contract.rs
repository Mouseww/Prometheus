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
async fn readonly_team_run_parallel_contract() {
    let fixture = spawn_team_fixture();
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([41_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    let research_id = create_agent(
        &app,
        &provider_id,
        "Research",
        "Act as the research specialist.",
    )
    .await;
    let review_id = create_agent(
        &app,
        &provider_id,
        "Review",
        "Act as the review specialist.",
    )
    .await;
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
                        "goal": "Verify parallel team runtime",
                        "agentIds": [research_id, review_id],
                        "maxConcurrency": 2,
                        "workspaceMode": "readonly",
                        "mergeStrategy": "manual"
                    })
                    .to_string(),
                ))
                .expect("launch request"),
        )
        .await
        .expect("launch response");
    let status = launch.status();
    let launch_body: Value = serde_json::from_slice(
        &to_bytes(launch.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::ACCEPTED, "unexpected: {launch_body}");
    let team_id = launch_body["team"]["id"].as_str().unwrap().to_owned();
    assert_eq!(launch_body["team"]["status"], "running");
    assert_eq!(launch_body["team"]["tasks"].as_array().unwrap().len(), 2);

    let team = wait_for_team(&app, &team_id, "completed").await;
    assert_eq!(team["status"], "completed");
    let tasks = team["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 2);
    for task in tasks {
        assert_eq!(task["status"], "completed");
        assert_eq!(task["changeStatus"], "not_applicable");
        assert!(task["output"].as_str().unwrap().contains("subagent completed"));
    }

    let events = list_events(&app, &session_id).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["type"].as_str().unwrap())
        .collect();
    assert!(types.iter().filter(|item| **item == "agent.spawned").count() >= 2);
    assert!(types.contains(&"agent.status"));
    assert!(types.contains(&"agent.run.started"));
    assert!(types.contains(&"message.agent"));
    assert!(types.contains(&"agent.run.completed"));

    let subagent_messages = events
        .iter()
        .filter(|event| {
            event["type"] == "message.agent" && event["payload"]["isSubagent"] == true
        })
        .count();
    assert_eq!(subagent_messages, 2);

    let listed = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/sessions/{session_id}/team-runs"))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(listed.status(), StatusCode::OK);
    let listed_body: Value = serde_json::from_slice(
        &to_bytes(listed.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(listed_body["teams"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn worktree_team_fails_when_workspace_is_not_a_git_repo() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([42_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));
    let provider_id = create_provider(&app, "http://127.0.0.1:9/v1", "fixture-secret").await;
    let agent_id = create_agent(&app, &provider_id, "Writer", "Write things.").await;
    let session_id = create_session(&app).await;
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/team-runs"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "goal": "Worktree requires git",
                        "agentIds": [agent_id],
                        "workspaceMode": "worktree",
                        "mergeStrategy": "manual",
                        "pathAssignments": [{
                            "agentId": agent_id,
                            "paths": ["src"]
                        }]
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let body: Value = serde_json::from_slice(
        &to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(status, StatusCode::ACCEPTED, "unexpected: {body}");
    let team_id = body["team"]["id"].as_str().unwrap().to_owned();
    let team = wait_for_team(&app, &team_id, "failed").await;
    assert_eq!(team["status"], "failed");
    assert_eq!(team["tasks"][0]["status"], "failed");
    let message = team["tasks"][0]["error"].as_str().unwrap_or_default();
    assert!(
        message.to_ascii_lowercase().contains("git")
            || message.to_ascii_lowercase().contains("repository"),
        "unexpected error: {message}"
    );
}


struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_team_fixture() -> FixtureHandle {
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
                    "send_team_message",
                    "read_team_messages",
                ],
                "readonly subagent tools mismatch"
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
                .unwrap_or_default();
            let user = messages
                .iter()
                .rev()
                .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            assert!(user.contains("Team goal: Verify parallel team runtime"));
            assert!(user.contains("read-only task"));

            let mut guard = turn.lock().expect("turn");
            *guard += 1;
            drop(guard);

            let final_content = if system.contains("research") {
                "Research subagent completed with independent evidence."
            } else {
                "Review subagent completed with independent evidence."
            };
            let payload = text_sse("fixture-team", final_content);
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

async fn create_agent(
    app: &axum::Router,
    provider_id: &str,
    name: &str,
    description: &str,
) -> String {
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
                .body(Body::from(json!({ "title": "Worktree team" }).to_string()))
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
