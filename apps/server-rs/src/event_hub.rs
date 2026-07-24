use std::{collections::HashMap, sync::Arc};

use tokio::sync::{RwLock, broadcast};

use crate::models::SessionEvent;

#[derive(Clone, Default)]
pub struct EventHub {
    channels: Arc<RwLock<HashMap<String, broadcast::Sender<SessionEvent>>>>,
}

impl EventHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn subscribe(&self, session_id: &str) -> broadcast::Receiver<SessionEvent> {
        let mut channels = self.channels.write().await;
        if let Some(sender) = channels.get(session_id) {
            return sender.subscribe();
        }
        let (sender, receiver) = broadcast::channel(256);
        channels.insert(session_id.to_owned(), sender);
        receiver
    }

    pub async fn publish(&self, event: SessionEvent) {
        let channels = self.channels.read().await;
        if let Some(sender) = channels.get(&event.session_id) {
            let _ = sender.send(event);
        }
    }
}
