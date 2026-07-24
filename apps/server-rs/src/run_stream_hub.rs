use std::{collections::HashMap, sync::Arc};

use serde::Serialize;
use tokio::sync::{RwLock, broadcast};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStreamSnapshot {
    pub session_id: String,
    pub run_id: String,
    pub agent_id: String,
    pub agent_label: String,
    pub turn: u32,
    pub revision: u64,
    pub text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunStreamEnvelope {
    #[serde(rename = "run.stream.snapshot")]
    Snapshot { stream: RunStreamSnapshot },
    #[serde(rename = "run.stream.delta")]
    Delta {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        turn: u32,
        revision: u64,
        delta: String,
    },
    #[serde(rename = "run.stream.cleared")]
    Cleared {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

#[derive(Clone, Default)]
pub struct RunStreamHub {
    streams: Arc<RwLock<HashMap<String, HashMap<String, RunStreamSnapshot>>>>,
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<RunStreamEnvelope>>>>,
}

impl RunStreamHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start_turn(
        &self,
        session_id: &str,
        run_id: &str,
        agent_id: &str,
        agent_label: &str,
        turn: u32,
    ) {
        let stream = RunStreamSnapshot {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            agent_id: agent_id.to_owned(),
            agent_label: agent_label.to_owned(),
            turn,
            revision: 0,
            text: String::new(),
        };
        {
            let mut streams = self.streams.write().await;
            let session = streams.entry(session_id.to_owned()).or_default();
            session.insert(run_id.to_owned(), stream.clone());
        }
        self.publish(
            session_id,
            RunStreamEnvelope::Snapshot { stream },
        )
        .await;
    }

    pub async fn append(&self, session_id: &str, run_id: &str, turn: u32, delta: &str) {
        if delta.is_empty() {
            return;
        }
        for chunk in delta
            .as_bytes()
            .chunks(65_536)
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
        {
            self.append_chunk(session_id, run_id, turn, &chunk).await;
        }
    }

    async fn append_chunk(&self, session_id: &str, run_id: &str, turn: u32, delta: &str) {
        let revision = {
            let mut streams = self.streams.write().await;
            let Some(session) = streams.get_mut(session_id) else {
                return;
            };
            let Some(current) = session.get_mut(run_id) else {
                return;
            };
            if current.turn != turn {
                return;
            }
            current.revision += 1;
            current.text.push_str(delta);
            current.revision
        };
        self.publish(
            session_id,
            RunStreamEnvelope::Delta {
                session_id: session_id.to_owned(),
                run_id: run_id.to_owned(),
                turn,
                revision,
                delta: delta.to_owned(),
            },
        )
        .await;
    }

    pub async fn clear(&self, session_id: &str, run_id: &str) {
        let removed = {
            let mut streams = self.streams.write().await;
            if let Some(session) = streams.get_mut(session_id) {
                let removed = session.remove(run_id).is_some();
                if session.is_empty() {
                    streams.remove(session_id);
                }
                removed
            } else {
                false
            }
        };
        if !removed {
            return;
        }
        self.publish(
            session_id,
            RunStreamEnvelope::Cleared {
                session_id: session_id.to_owned(),
                run_id: run_id.to_owned(),
            },
        )
        .await;
    }

    pub async fn list(&self, session_id: &str) -> Vec<RunStreamSnapshot> {
        let streams = self.streams.read().await;
        streams
            .get(session_id)
            .map(|session| session.values().cloned().collect())
            .unwrap_or_default()
    }

    pub async fn subscribe(&self, session_id: &str) -> broadcast::Receiver<RunStreamEnvelope> {
        let mut channels = self.channels.write().await;
        if let Some(sender) = channels.get(session_id) {
            return sender.subscribe();
        }
        let (sender, receiver) = broadcast::channel(256);
        channels.insert(session_id.to_owned(), sender);
        receiver
    }

    async fn publish(&self, session_id: &str, envelope: RunStreamEnvelope) {
        let channels = self.channels.read().await;
        if let Some(sender) = channels.get(session_id) {
            let _ = sender.send(envelope);
        }
    }
}
