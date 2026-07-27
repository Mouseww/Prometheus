use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use crate::error::AppError;

#[derive(Clone, Default)]
pub struct ActiveRunHub {
    inner: Arc<Mutex<HashMap<String, HashMap<String, Arc<AtomicBool>>>>>,
}

#[derive(Clone)]
pub struct ActiveRunHandle {
    session_id: String,
    run_id: String,
    cancelled: Arc<AtomicBool>,
    hub: ActiveRunHub,
}

impl ActiveRunHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn begin(&self, session_id: &str, run_id: &str) -> Result<ActiveRunHandle, AppError> {
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::configuration("Active run lock poisoned"))?;
        let session = guard.entry(session_id.to_owned()).or_default();
        session.insert(run_id.to_owned(), cancelled.clone());
        Ok(ActiveRunHandle {
            session_id: session_id.to_owned(),
            run_id: run_id.to_owned(),
            cancelled,
            hub: self.clone(),
        })
    }

    pub fn cancel(&self, session_id: &str, run_id: Option<&str>) -> Result<Vec<String>, AppError> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| AppError::configuration("Active run lock poisoned"))?;
        let Some(session) = guard.get_mut(session_id) else {
            return Ok(Vec::new());
        };
        let mut cancelled_ids = Vec::new();
        if let Some(run_id) = run_id {
            if let Some(flag) = session.get(run_id) {
                flag.store(true, Ordering::SeqCst);
                cancelled_ids.push(run_id.to_owned());
            }
        } else {
            for (id, flag) in session.iter() {
                flag.store(true, Ordering::SeqCst);
                cancelled_ids.push(id.clone());
            }
        }
        Ok(cancelled_ids)
    }

    pub fn list(&self, session_id: &str) -> Result<Vec<String>, AppError> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| AppError::configuration("Active run lock poisoned"))?;
        Ok(guard
            .get(session_id)
            .map(|session| session.keys().cloned().collect())
            .unwrap_or_default())
    }

    fn end(&self, session_id: &str, run_id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(session) = guard.get_mut(session_id) {
                session.remove(run_id);
                if session.is_empty() {
                    guard.remove(session_id);
                }
            }
        }
    }
}

impl ActiveRunHandle {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }
}

impl Drop for ActiveRunHandle {
    fn drop(&mut self) {
        self.hub.end(&self.session_id, &self.run_id);
    }
}
