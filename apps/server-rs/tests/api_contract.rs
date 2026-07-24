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
async fn health_contract() {
    let workspace = tempdir().expect("temporary workspace");
    let config = Config::new(workspace.path())
        .expect("valid config")
        .with_data_file(":memory:");
    let app = build_router(AppState::open(config).await.expect("app state"));

    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("health response");

    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("health body");
    let body: Value = serde_json::from_slice(&body).expect("health json");
    assert_eq!(body["status"], "ok");
    assert_eq!(
        body["workspace"],
        workspace
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .as_ref()
    );
    assert!(
        body["timestamp"]
            .as_str()
            .is_some_and(|value| value.ends_with('Z'))
    );
}

#[tokio::test]
async fn create_session_contract() {
    let workspace = tempdir().expect("temporary workspace");
    let config = Config::new(workspace.path())
        .expect("valid config")
        .with_data_file(":memory:");
    let app = build_router(AppState::open(config).await.expect("app state"));

    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"Rust durable task"}"#))
                .expect("request"),
        )
        .await
        .expect("session response");

    assert_eq!(response.status(), StatusCode::CREATED);
    let body = to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("session body");
    let body: Value = serde_json::from_slice(&body).expect("session json");
    let session = &body["session"];
    assert_eq!(session["title"], "Rust durable task");
    assert_eq!(session["status"], "idle");
    assert_eq!(session["lastSequence"], 0);
    assert!(session["id"].as_str().is_some_and(|value| value.len() == 36));
}

#[tokio::test]
async fn durable_sessions_survive_reopen() {
    let workspace = tempdir().expect("temporary workspace");
    let data_file = workspace.path().join("prometheus.db");
    let config = Config::new(workspace.path())
        .expect("valid config")
        .with_data_file(&data_file);

    let app = build_router(
        AppState::open(config.clone())
            .await
            .expect("app state"),
    );
    let create = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"Persisted session"}"#))
                .expect("request"),
        )
        .await
        .expect("create response");
    assert_eq!(create.status(), StatusCode::CREATED);
    let created: Value = serde_json::from_slice(
        &to_bytes(create.into_body(), 64 * 1024)
            .await
            .expect("create body"),
    )
    .expect("create json");
    let session_id = created["session"]["id"].as_str().expect("session id").to_owned();

    let reopened = build_router(AppState::open(config).await.expect("reopened state"));
    let list = reopened
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(list.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(list.into_body(), 64 * 1024)
            .await
            .expect("list body"),
    )
    .expect("list json");
    let sessions = body["sessions"].as_array().expect("sessions array");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id);
    assert_eq!(sessions[0]["title"], "Persisted session");
    assert_eq!(sessions[0]["lastSequence"], 0);
}

#[tokio::test]
async fn append_event_contract() {
    let workspace = tempdir().expect("temporary workspace");
    let config = Config::new(workspace.path())
        .expect("valid config")
        .with_data_file(":memory:");
    let app = build_router(AppState::open(config).await.expect("app state"));

    let create = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/sessions")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"Event session"}"#))
                .expect("request"),
        )
        .await
        .expect("create response");
    let created: Value = serde_json::from_slice(
        &to_bytes(create.into_body(), 64 * 1024)
            .await
            .expect("create body"),
    )
    .expect("create json");
    let session_id = created["session"]["id"].as_str().expect("session id").to_owned();
    let event_id = Uuid::new_v4().to_string();
    let payload = json!({
        "eventId": event_id,
        "type": "message.user",
        "actor": { "kind": "user", "id": "user-1", "label": "Owner" },
        "payload": { "text": "hello from rust" }
    });

    let append = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/events"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("append request"),
        )
        .await
        .expect("append response");
    assert_eq!(append.status(), StatusCode::CREATED);
    let appended: Value = serde_json::from_slice(
        &to_bytes(append.into_body(), 64 * 1024)
            .await
            .expect("append body"),
    )
    .expect("append json");
    let first_sequence = appended["event"]["sequence"].as_i64().expect("sequence");
    assert!(first_sequence > 0);
    assert_eq!(appended["event"]["eventId"], event_id);
    assert_eq!(appended["event"]["sessionId"], session_id);
    assert_eq!(appended["event"]["type"], "message.user");
    assert_eq!(appended["event"]["payload"]["text"], "hello from rust");

    let retry = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/events"))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("retry request"),
        )
        .await
        .expect("retry response");
    assert_eq!(retry.status(), StatusCode::CREATED);
    let retried: Value = serde_json::from_slice(
        &to_bytes(retry.into_body(), 64 * 1024)
            .await
            .expect("retry body"),
    )
    .expect("retry json");
    assert_eq!(retried["event"]["sequence"], first_sequence);

    let conflict_payload = json!({
        "eventId": event_id,
        "type": "message.user",
        "actor": { "kind": "user", "id": "user-1", "label": "Owner" },
        "payload": { "text": "different content" }
    });
    let conflict = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/events"))
                .header("content-type", "application/json")
                .body(Body::from(conflict_payload.to_string()))
                .expect("conflict request"),
        )
        .await
        .expect("conflict response");
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    let conflict_body: Value = serde_json::from_slice(
        &to_bytes(conflict.into_body(), 64 * 1024)
            .await
            .expect("conflict body"),
    )
    .expect("conflict json");
    assert_eq!(conflict_body["error"], "event_conflict");

    let missing = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{}/events", Uuid::new_v4()))
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .expect("missing request"),
        )
        .await
        .expect("missing response");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let missing_body: Value = serde_json::from_slice(
        &to_bytes(missing.into_body(), 64 * 1024)
            .await
            .expect("missing body"),
    )
    .expect("missing json");
    assert_eq!(missing_body["error"], "session_not_found");

    let second_id = Uuid::new_v4().to_string();
    let second_payload = json!({
        "eventId": second_id,
        "type": "message.agent",
        "actor": { "kind": "agent", "id": "agent-1", "label": "Helper" },
        "payload": { "text": "reply" }
    });
    let second = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{session_id}/events"))
                .header("content-type", "application/json")
                .body(Body::from(second_payload.to_string()))
                .expect("second request"),
        )
        .await
        .expect("second response");
    assert_eq!(second.status(), StatusCode::CREATED);
    let second_body: Value = serde_json::from_slice(
        &to_bytes(second.into_body(), 64 * 1024)
            .await
            .expect("second body"),
    )
    .expect("second json");
    let second_sequence = second_body["event"]["sequence"].as_i64().expect("second sequence");
    assert!(second_sequence > first_sequence);

    let list = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/sessions/{session_id}/events?afterSequence={first_sequence}"
                ))
                .body(Body::empty())
                .expect("list request"),
        )
        .await
        .expect("list response");
    assert_eq!(list.status(), StatusCode::OK);
    let listed: Value = serde_json::from_slice(
        &to_bytes(list.into_body(), 64 * 1024)
            .await
            .expect("list body"),
    )
    .expect("list json");
    let events = listed["events"].as_array().expect("events");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["eventId"], second_id);
    assert_eq!(events[0]["sequence"], second_sequence);

    let sessions = app
        .oneshot(
            Request::builder()
                .uri("/api/sessions")
                .body(Body::empty())
                .expect("sessions request"),
        )
        .await
        .expect("sessions response");
    let sessions_body: Value = serde_json::from_slice(
        &to_bytes(sessions.into_body(), 64 * 1024)
            .await
            .expect("sessions body"),
    )
    .expect("sessions json");
    assert_eq!(sessions_body["sessions"][0]["lastSequence"], second_sequence);
}


#[tokio::test]
async fn workspace_and_bootstrap_contract() {
    let workspace = tempdir().expect("temporary workspace");
    let root = workspace.path();
    std::fs::create_dir_all(root.join("src")).expect("src");
    std::fs::write(root.join("README.md"), b"hello").expect("readme");
    std::fs::create_dir_all(root.join("node_modules")).expect("node_modules");
    std::fs::write(root.join("node_modules").join("skip.js"), b"x").expect("skip");
    std::fs::create_dir_all(root.join(".git")).expect("git");

    let config = Config::new(root)
        .expect("valid config")
        .with_data_file(":memory:");
    let app = build_router(AppState::open(config).await.expect("app state"));

    let workspace_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspace")
                .body(Body::empty())
                .expect("workspace request"),
        )
        .await
        .expect("workspace response");
    assert_eq!(workspace_response.status(), StatusCode::OK);
    let body: Value = serde_json::from_slice(
        &to_bytes(workspace_response.into_body(), 64 * 1024)
            .await
            .expect("workspace body"),
    )
    .expect("workspace json");
    assert_eq!(
        body["rootName"],
        root.file_name().unwrap().to_string_lossy().as_ref()
    );
    let nodes = body["nodes"].as_array().expect("nodes");
    let names: Vec<&str> = nodes
        .iter()
        .map(|node| node["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"src"));
    assert!(names.contains(&"README.md"));
    assert!(!names.contains(&"node_modules"));
    assert!(!names.contains(&".git"));
    assert_eq!(nodes[0]["kind"], "directory");
    assert_eq!(nodes[0]["path"], "src");

    let escape = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspace?path=..")
                .body(Body::empty())
                .expect("escape request"),
        )
        .await
        .expect("escape response");
    assert_eq!(escape.status(), StatusCode::FORBIDDEN);
    let escape_body: Value = serde_json::from_slice(
        &to_bytes(escape.into_body(), 64 * 1024)
            .await
            .expect("escape body"),
    )
    .expect("escape json");
    assert_eq!(escape_body["error"], "workspace_boundary");

    let missing = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/workspace?path=does-not-exist")
                .body(Body::empty())
                .expect("missing request"),
        )
        .await
        .expect("missing response");
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let missing_body: Value = serde_json::from_slice(
        &to_bytes(missing.into_body(), 64 * 1024)
            .await
            .expect("missing body"),
    )
    .expect("missing json");
    assert_eq!(missing_body["error"], "path_not_found");

    for path in ["/api/providers", "/api/agents", "/api/permission-rules"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("bootstrap request"),
            )
            .await
            .expect("bootstrap response");
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = serde_json::from_slice(
            &to_bytes(response.into_body(), 64 * 1024)
                .await
                .expect("bootstrap body"),
        )
        .expect("bootstrap json");
        match path {
            "/api/providers" => assert_eq!(body["providers"].as_array().unwrap().len(), 0),
            "/api/agents" => assert_eq!(body["agents"].as_array().unwrap().len(), 0),
            "/api/permission-rules" => assert_eq!(body["rules"].as_array().unwrap().len(), 0),
            _ => unreachable!(),
        }
    }
}


#[tokio::test]
async fn runtime_not_migrated_and_spa_contract() {
    let workspace = tempdir().expect("workspace");
    let web_root = workspace.path().join("dist");
    std::fs::create_dir_all(&web_root).expect("web root");
    std::fs::write(
        web_root.join("index.html"),
        b"<!doctype html><title>Prometheus</title><div id=\"root\">ok</div>",
    )
    .expect("index");
    std::fs::write(web_root.join("app.js"), b"console.log('prometheus')").expect("js");

    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(":memory:")
        .with_web_root(&web_root);
    let app = build_router(AppState::open(config).await.expect("state"));

    // Agent run + team runtime migrated; missing team messages returns 404.
    let missing_run = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{}/runs", uuid::Uuid::new_v4()))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"agentId":"00000000-0000-4000-8000-000000000001"}"#))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing_run.status(), StatusCode::NOT_FOUND);
    let missing_body: Value = serde_json::from_slice(
        &to_bytes(missing_run.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(missing_body["error"], "configuration_not_found");

    let missing_team = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/sessions/{}/team-runs", uuid::Uuid::new_v4()))
                .header("content-type", "application/json")
                .body(Body::from(r#"{"goal":"x","agentIds":["00000000-0000-4000-8000-000000000001"]}"#))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing_team.status(), StatusCode::NOT_FOUND);

    let missing_apply = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/api/team-runs/{}/tasks/{}/apply",
                    uuid::Uuid::new_v4(),
                    uuid::Uuid::new_v4()
                ))
                .header("content-type", "application/json")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing_apply.status(), StatusCode::NOT_FOUND);
    let apply_body: Value = serde_json::from_slice(
        &to_bytes(missing_apply.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(apply_body["error"], "team_run_not_found");

    let missing_messages = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/api/team-runs/{}/messages",
                    uuid::Uuid::new_v4()
                ))
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing_messages.status(), StatusCode::NOT_FOUND);
    let body: Value = serde_json::from_slice(
        &to_bytes(missing_messages.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(body["error"], "team_run_not_found");

    let spa = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(spa.status(), StatusCode::OK);
    let html = to_bytes(spa.into_body(), 64 * 1024).await.expect("html");
    assert!(String::from_utf8_lossy(&html).contains("Prometheus"));

    let asset = app
        .oneshot(
            Request::builder()
                .uri("/app.js")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(asset.status(), StatusCode::OK);
}


