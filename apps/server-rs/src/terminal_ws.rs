use std::sync::Arc;
use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    state::AppState,
    terminal_pty::{PtyEvent, PtySession},
    terminal_session_service::{PTY_TOOL_NAME, TerminalGrant, TerminalSessionService},
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalQuery {
    /// 必填。PTY 会话的审计事件必须落在一个真实会话上。
    session_id: Option<String>,
    #[serde(default = "default_cols")]
    cols: u16,
    #[serde(default = "default_rows")]
    rows: u16,
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    32
}

pub async fn terminal_websocket_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<TerminalQuery>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_terminal_socket(socket, state, query))
}

async fn send_error(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: &str,
) {
    let _ = sender
        .send(Message::Text(
            json!({ "type": "error", "message": message }).to_string().into(),
        ))
        .await;
    let _ = sender.close().await;
}

async fn handle_terminal_socket(socket: WebSocket, state: AppState, query: TerminalQuery) {
    let (mut sender, mut receiver) = socket.split();

    let Some(session_id) = query.session_id.filter(|value| !value.trim().is_empty()) else {
        send_error(&mut sender, "sessionId is required for terminal sessions").await;
        return;
    };

    let cwd = match state.with_live(|live| live.root.clone()) {
        Ok(path) => path,
        Err(error) => {
            send_error(&mut sender, &error.to_string()).await;
            return;
        }
    };

    // 准入：TerminalMode 门禁 → 权限规则 → 跨终端审批。
    // 拒绝时不 spawn 任何进程，且拒绝本身已作为 durable 事件写入。
    let terminal = TerminalSessionService::new(state.clone());
    let grant = match terminal
        .authorize_pty(&session_id, &cwd.display().to_string())
        .await
    {
        Ok(grant) => grant,
        Err(error) => {
            send_error(&mut sender, &error.to_string()).await;
            return;
        }
    };

    let (session, mut output) = match PtySession::spawn(&cwd, query.cols, query.rows) {
        Ok(pair) => pair,
        Err(error) => {
            let message = error.to_string();
            terminal
                .finish(
                    &grant,
                    PTY_TOOL_NAME,
                    json!({ "status": "failed", "message": message }),
                )
                .await;
            send_error(&mut sender, &message).await;
            return;
        }
    };

    let session = Arc::new(session);
    let _ = sender
        .send(Message::Text(
            json!({
                "type": "ready",
                "shell": if cfg!(windows) { "powershell" } else { "bash" },
                "cwd": cwd.display().to_string(),
                "toolCallId": grant.tool_call_id,
            })
            .to_string()
            .into(),
        ))
        .await;

    let session_out = session.clone();
    let writer_task = tokio::spawn(async move {
        let mut exit_code: Option<i64> = None;
        while let Some(event) = output.rx.recv().await {
            let payload = match event {
                PtyEvent::Output(data) => json!({ "type": "output", "data": data }),
                PtyEvent::Exit(code) => {
                    exit_code = code.map(i64::from);
                    json!({ "type": "exit", "code": code })
                }
                PtyEvent::Error(message) => json!({ "type": "error", "message": message }),
            };
            if sender
                .send(Message::Text(payload.to_string().into()))
                .await
                .is_err()
            {
                break;
            }
            if matches!(payload.get("type").and_then(Value::as_str), Some("exit") | Some("error")) {
                break;
            }
        }
        session_out.close();
        let _ = sender.close().await;
        exit_code
    });

    let session_in = session.clone();
    while let Some(Ok(message)) = receiver.next().await {
        match message {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    match value.get("type").and_then(Value::as_str) {
                        Some("input") => {
                            if let Some(data) = value.get("data").and_then(Value::as_str) {
                                if let Err(error) = session_in.write(data) {
                                    // best effort; reader side may already be closed
                                    let _ = error;
                                    break;
                                }
                            }
                        }
                        Some("resize") => {
                            let cols = value.get("cols").and_then(Value::as_u64).unwrap_or(120) as u16;
                            let rows = value.get("rows").and_then(Value::as_u64).unwrap_or(32) as u16;
                            let _ = session_in.resize(cols, rows);
                        }
                        Some("close") => break,
                        _ => {}
                    }
                } else if let Err(error) = session_in.write(&text) {
                    let _ = error;
                    break;
                }
            }
            Message::Binary(bytes) => {
                if let Ok(text) = String::from_utf8(bytes.to_vec()) {
                    let _ = session_in.write(&text);
                }
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => {}
        }
    }

    session.close();
    let exit_code = writer_task.await.ok().flatten();
    finish_pty(&terminal, &grant, exit_code).await;
}

/// 闭合审计链。会话时长由前后两条事件的 `createdAt` 之差得出，无需额外计时。
async fn finish_pty(
    terminal: &TerminalSessionService,
    grant: &TerminalGrant,
    exit_code: Option<i64>,
) {
    terminal
        .finish(
            grant,
            PTY_TOOL_NAME,
            json!({ "status": "completed", "exitCode": exit_code }),
        )
        .await;
}
