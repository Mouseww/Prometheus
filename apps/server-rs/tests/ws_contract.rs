use std::time::Duration;

use axum::http::StatusCode;
use futures_util::StreamExt;
use prometheus_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

#[tokio::test]
async fn websocket_sync_and_live_event_contract() {
    let workspace = tempdir().expect("temporary workspace");
    let config = Config::new(workspace.path())
        .expect("valid config")
        .with_data_file(workspace.path().join("ws.db"));
    let app = build_router(AppState::open(config).await.expect("app state"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(listener, app).await.expect("serve");
    });

    let client = reqwest::Client::new();
    let create = client
        .post(format!("http://{addr}/api/sessions"))
        .json(&json!({ "title": "ws session" }))
        .send()
        .await
        .expect("create session");
    assert_eq!(create.status(), StatusCode::CREATED);
    let created: Value = create.json().await.expect("create json");
    let session_id = created["session"]["id"].as_str().unwrap().to_owned();

    let seed_event_id = Uuid::new_v4().to_string();
    let seed = client
        .post(format!("http://{addr}/api/sessions/{session_id}/events"))
        .json(&json!({
            "eventId": seed_event_id,
            "type": "message.user",
            "actor": { "kind": "user", "id": "user-1", "label": "Owner" },
            "payload": { "text": "seed" }
        }))
        .send()
        .await
        .expect("seed event");
    assert_eq!(seed.status(), StatusCode::CREATED);

    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/ws?sessionId={session_id}&afterSequence=0"
    ))
    .await
    .expect("websocket connect");

    let first = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("sync timeout")
        .expect("sync frame")
        .expect("sync ok");
    let Message::Text(sync_text) = first else {
        panic!("expected text sync frame");
    };
    let sync: Value = serde_json::from_str(&sync_text).expect("sync json");
    assert_eq!(sync["kind"], "sync");
    assert_eq!(sync["events"].as_array().unwrap().len(), 1);
    assert_eq!(sync["events"][0]["eventId"], seed_event_id);

    let live_event_id = Uuid::new_v4().to_string();
    let append = client
        .post(format!("http://{addr}/api/sessions/{session_id}/events"))
        .json(&json!({
            "eventId": live_event_id,
            "type": "message.agent",
            "actor": { "kind": "agent", "id": "agent-1", "label": "Helper" },
            "payload": { "text": "live over ws" }
        }))
        .send()
        .await
        .expect("live event");
    assert_eq!(append.status(), StatusCode::CREATED);

    let second = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("live timeout")
        .expect("live frame")
        .expect("live ok");
    let Message::Text(live_text) = second else {
        panic!("expected text live frame");
    };
    let live: Value = serde_json::from_str(&live_text).expect("live json");
    assert_eq!(live["kind"], "event");
    assert_eq!(live["event"]["eventId"], live_event_id);
    assert_eq!(live["event"]["payload"]["text"], "live over ws");

    let (mut bad, _) = tokio_tungstenite::connect_async(format!(
        "ws://{addr}/ws?sessionId={}&afterSequence=0",
        Uuid::new_v4()
    ))
    .await
    .expect("missing session connect");
    let error_frame = tokio::time::timeout(Duration::from_secs(2), bad.next())
        .await
        .expect("error timeout")
        .expect("error frame")
        .expect("error ok");
    let Message::Text(error_text) = error_frame else {
        panic!("expected text error frame");
    };
    let error: Value = serde_json::from_str(&error_text).expect("error json");
    assert_eq!(error["kind"], "error");
    assert_eq!(error["message"], "Session not found");

    }

