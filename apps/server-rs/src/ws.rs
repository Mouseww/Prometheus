use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;
use uuid::Uuid;

use crate::{models::SessionEvent, run_stream_hub::RunStreamEnvelope, state::AppState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketQuery {
    session_id: Option<String>,
    #[serde(default)]
    after_sequence: i64,
}

pub async fn websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<SocketQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state, query))
}

async fn handle_socket(socket: WebSocket, state: AppState, query: SocketQuery) {
    let (mut sender, mut receiver) = socket.split();

    let Some(session_id) = query.session_id.filter(|value| !value.is_empty()) else {
        let _ = send_json(
            &mut sender,
            &json!({ "kind": "error", "message": "Invalid session subscription" }),
        )
        .await;
        let _ = sender.close().await;
        return;
    };

    if Uuid::parse_str(&session_id).is_err() {
        let _ = send_json(
            &mut sender,
            &json!({ "kind": "error", "message": "Invalid session subscription" }),
        )
        .await;
        let _ = sender.close().await;
        return;
    }

    match state.sessions.get(&session_id).await {
        Ok(Some(_)) => {}
        _ => {
            let _ = send_json(
                &mut sender,
                &json!({ "kind": "error", "message": "Session not found" }),
            )
            .await;
            let _ = sender.close().await;
            return;
        }
    }

    let after_sequence = query.after_sequence.max(0);
    let initial = match state.sessions.list_events(&session_id, after_sequence).await {
        Ok(events) => events,
        Err(_) => {
            let _ = send_json(
                &mut sender,
                &json!({ "kind": "error", "message": "Session not found" }),
            )
            .await;
            let _ = sender.close().await;
            return;
        }
    };

    let mut last_sequence = initial
        .iter()
        .map(|event| event.sequence)
        .max()
        .unwrap_or(after_sequence);

    if send_json(&mut sender, &json!({ "kind": "sync", "events": initial }))
        .await
        .is_err()
    {
        return;
    }

    // Subscribe before snapshot so deltas that race after list() are still received.
    let mut events = state.event_hub.subscribe(&session_id).await;
    let mut streams = state.run_streams.subscribe(&session_id).await;
    for stream in state.run_streams.list(&session_id).await {
        if send_stream(
            &mut sender,
            &RunStreamEnvelope::Snapshot { stream },
        )
        .await
        .is_err()
        {
            return;
        }
    }

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if sender.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = events.recv() => {
                match event {
                    Ok(event) => {
                        if event.sequence <= last_sequence {
                            continue;
                        }
                        last_sequence = event.sequence;
                        if send_event(&mut sender, &event).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        match state.sessions.list_events(&session_id, last_sequence).await {
                            Ok(missed) => {
                                for event in missed {
                                    if event.sequence <= last_sequence {
                                        continue;
                                    }
                                    last_sequence = event.sequence;
                                    if send_event(&mut sender, &event).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            stream = streams.recv() => {
                match stream {
                    Ok(envelope) => {
                        if send_stream(&mut sender, &envelope).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => {
                        for snapshot in state.run_streams.list(&session_id).await {
                            if send_stream(
                                &mut sender,
                                &RunStreamEnvelope::Snapshot { stream: snapshot },
                            )
                            .await
                            .is_err()
                            {
                                return;
                            }
                        }
                    }
                    Err(RecvError::Closed) => break,
                }
            }
        }
    }
}

async fn send_event(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    event: &SessionEvent,
) -> Result<(), ()> {
    send_json(sender, &json!({ "kind": "event", "event": event })).await
}

async fn send_stream(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    envelope: &RunStreamEnvelope,
) -> Result<(), ()> {
    let value = serde_json::to_value(envelope).map_err(|_| ())?;
    send_json(sender, &value).await
}

async fn send_json(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    value: &serde_json::Value,
) -> Result<(), ()> {
    sender
        .send(Message::Text(value.to_string().into()))
        .await
        .map_err(|_| ())
}
