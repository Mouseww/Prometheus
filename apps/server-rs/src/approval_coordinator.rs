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
}

