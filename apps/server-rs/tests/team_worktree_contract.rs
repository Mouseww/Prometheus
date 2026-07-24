use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::Command,
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
async fn manual_worktree_team_pending_apply_contract() {
    let fixture = spawn_write_fixture();
    let git = create_git_workspace();
    let config = Config::new(&git.workspace_root)
        .expect("config")
        .with_data_file(git.workspace_root.join("runtime.db"))
        .with_worktree_root(&git.storage_root)
        .with_master_key([77_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let provider_id = create_provider(
        &app,
        &format!("http://127.0.0.1:{}/v1", fixture.port),
        "fixture-secret",
    )
    .await;
    create_permission_rule(&app, "write_file", "allow", "*").await;
    let agent_id = create_agent(&app, &provider_id, "Builder", "Create isolated source files.").await;
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
                        "goal": "Create an isolated result under src",
                        "agentIds": [agent_id],
                        "maxConcurrency": 1,
                        "workspaceMode": "worktree",
                        "mergeStrategy": "manual",
                        "pathAssignments": [{ "agentId": agent_id, "paths": ["src"] }]
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

    let team = wait_for_team(&app, &team_id, "completed").await;
    assert_eq!(team["status"], "completed");
    let task = &team["tasks"][0];
    assert_eq!(task["status"], "completed");
    assert_eq!(task["changeStatus"], "pending");
    assert!(
        task["changedPaths"]
            .as_array()
            .unwrap()
            .iter()
            .any(|path| path.as_str() == Some("src/result.txt"))
    );
    assert!(!git.workspace_root.join("src").join("result.txt").exists());

    let task_id = task["id"].as_str().unwrap().to_owned();
    let apply = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/team-runs/{team_id}/tasks/{task_id}/apply"))
                .body(Body::empty())
                .expect("apply request"),
        )
        .await
        .expect("apply response");
    let apply_status = apply.status();
    let apply_body: Value = serde_json::from_slice(
        &to_bytes(apply.into_body(), 1024 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(apply_status, StatusCode::OK, "unexpected: {apply_body}");
    assert_eq!(apply_body["team"]["tasks"][0]["changeStatus"], "applied");
    assert_eq!(
        fs::read_to_string(git.workspace_root.join("src").join("result.txt")).expect("applied"),
        "isolated result\n"
    );

    let events = list_events(&app, &session_id).await;
    assert!(events.iter().any(|event| event["type"] == "team.workspace.created"));
    assert!(events.iter().any(|event| event["type"] == "team.changes.detected"));
    assert!(events.iter().any(|event| event["type"] == "team.changes.applied"));
    assert!(events.iter().any(|event| event["type"] == "team.workspace.cleaned"));
}

#[tokio::test]
async fn worktree_path_assignment_validation_contract() {
    let git = create_git_workspace();
    let config = Config::new(&git.workspace_root)
        .expect("config")
        .with_data_file(git.workspace_root.join("runtime.db"))
        .with_worktree_root(&git.storage_root)
        .with_master_key([78_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));
    let provider_id = create_provider(&app, "http://127.0.0.1:9/v1", "fixture-secret").await;
    let first = create_agent(&app, &provider_id, "A", "first").await;
    let second = create_agent(&app, &provider_id, "B", "second").await;
    let session_id = create_session(&app).await;

    let invalid = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/team-runs"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "goal": "overlap",
                        "agentIds": [first, second],
                        "workspaceMode": "worktree",
                        "mergeStrategy": "manual",
                        "pathAssignments": [
                            { "agentId": first, "paths": ["src"] },
                            { "agentId": second, "paths": ["src/nested"] }
                        ]
                    })
                    .to_string(),
                ))
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let body: Value = serde_json::from_slice(
        &to_bytes(invalid.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["error"], "invalid_request");
    assert!(
        body["message"]
            .as_str()
            .unwrap_or_default()
            .contains("overlap")
    );
}

struct GitWorkspace {
    workspace_root: PathBuf,
    storage_root: PathBuf,
}

fn create_git_workspace() -> GitWorkspace {
    let root = tempdir().expect("temp").keep();
    let workspace_root = root.join("workspace");
    let storage_root = root.join("worktrees");
    fs::create_dir_all(&workspace_root).expect("workspace");
    fs::create_dir_all(workspace_root.join("src")).expect("src");
    fs::write(workspace_root.join("README.md"), "base workspace\n").expect("readme");
    fs::write(workspace_root.join("src").join(".gitkeep"), "\n").expect("gitkeep");
    git(&workspace_root, &["init"]);
    git(&workspace_root, &["config", "core.autocrlf", "false"]);
    git(
        &workspace_root,
        &["config", "user.email", "prometheus-test@example.com"],
    );
    git(&workspace_root, &["config", "user.name", "Prometheus Test"]);
    git(&workspace_root, &["add", "."]);
    git(&workspace_root, &["commit", "-m", "initial"]);
    GitWorkspace {
        workspace_root,
        storage_root,
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    if !output.status.success() {
        panic!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

struct FixtureHandle {
    port: u16,
    _keep_alive: Arc<AtomicU16>,
}

fn spawn_write_fixture() -> FixtureHandle {
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
            assert_eq!(
                names,
                vec![
                    "list_directory",
                    "read_file",
                    "search_text",
                    "write_file",
                    "shell_command",
                    "send_team_message",
                    "read_team_messages",
                ],
                "worktree child must receive full tools"
            );

            let mut guard = turn.lock().expect("turn");
            *guard += 1;
            let current = *guard;
            drop(guard);

            let payload = if current == 1 {
                tool_call_sse(
                    "fixture-worktree-write",
                    "call-1",
                    "write_file",
                    r#"{"path":"src/result.txt","content":"isolated result\n"}"#,
                )
            } else {
                text_sse("fixture-worktree-final", "Worktree subagent completed.")
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
    format!(
        "data: {chunk1}\n\ndata: {chunk2}\n\ndata: {done}\n\ndata: [DONE]\n\n"
    )
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
