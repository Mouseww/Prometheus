use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tokio::sync::oneshot;
use uuid::Uuid;

use crate::error::AppError;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied,
}

impl ApprovalDecision {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Denied => "denied",
        }
    }

    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value {
            "approved" => Ok(Self::Approved),
            "denied" => Ok(Self::Denied),
            _ => Err(AppError::invalid_request(
                "decision must be approved or denied",
            )),
        }
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolution {
    pub approval_id: String,
    pub session_id: String,
    pub decision: String,
}

struct PendingApproval {
    session_id: String,
    sender: oneshot::Sender<ApprovalDecision>,
}

#[derive(Clone, Default)]
pub struct ApprovalCoordinator {
    pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
}

impl ApprovalCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn create(
        &self,
        session_id: &str,
    ) -> Result<(String, oneshot::Receiver<ApprovalDecision>), AppError> {
        let approval_id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| AppError::configuration("Approval lock poisoned"))?
            .insert(
                approval_id.clone(),
                PendingApproval {
                    session_id: session_id.to_owned(),
                    sender,
                },
            );
        Ok((approval_id, receiver))
    }

    pub fn deny_all_for_session(&self, session_id: &str) -> Vec<String> {
        let Ok(mut pending) = self.pending.lock() else {
            return Vec::new();
        };
        let keys: Vec<String> = pending
            .iter()
            .filter(|(_, value)| value.session_id == session_id)
            .map(|(key, _)| key.clone())
            .collect();
        let mut denied_ids = Vec::new();
        for key in keys {
            if let Some(item) = pending.remove(&key) {
                let _ = item.sender.send(ApprovalDecision::Denied);
                denied_ids.push(key);
            }
        }
        denied_ids
    }

    pub fn resolve(
        &self,
        session_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<ApprovalResolution, AppError> {
        let pending = self
            .pending
            .lock()
            .map_err(|_| AppError::configuration("Approval lock poisoned"))?
            .remove(approval_id)
            .ok_or_else(AppError::approval_not_found)?;
        if pending.session_id != session_id {
            return Err(AppError::approval_not_found());
        }
        let _ = pending.sender.send(decision.clone());
        Ok(ApprovalResolution {
            approval_id: approval_id.to_owned(),
            session_id: session_id.to_owned(),
            decision: decision.as_str().to_owned(),
        })
    }

    pub fn has_pending(&self, session_id: &str, approval_id: &str) -> bool {
        self.pending
            .lock()
            .ok()
            .and_then(|guard| {
                guard
                    .get(approval_id)
                    .map(|item| item.session_id == session_id)
            })
            .unwrap_or(false)
    }

    /// Live in-memory waiters only. Durable timeline cards may still exist after restart.
    pub fn list_pending(&self) -> Vec<(String, String)> {
        let Ok(pending) = self.pending.lock() else {
            return Vec::new();
        };
        let mut items = pending
            .iter()
            .map(|(approval_id, value)| (approval_id.clone(), value.session_id.clone()))
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.0.cmp(&right.0));
        items
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_pending_returns_sorted_pairs() {
        let coordinator = ApprovalCoordinator::new();
        let (first, _) = coordinator.create("session-b").expect("create");
        let (second, _) = coordinator.create("session-a").expect("create");
        let pending = coordinator.list_pending();
        assert_eq!(pending.len(), 2);
        assert!(pending.iter().any(|(id, session)| id == &first && session == "session-b"));
        assert!(pending.iter().any(|(id, session)| id == &second && session == "session-a"));
        assert!(pending[0].0 <= pending[1].0);
    }
}
