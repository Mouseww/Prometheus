use std::{
    io::{Read, Write},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tokio::sync::mpsc;

use crate::{error::AppError, terminal_policy::sensitive_env_keys};

pub struct PtySession {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    closed: Arc<AtomicBool>,
}

pub struct PtyOutput {
    pub rx: mpsc::UnboundedReceiver<PtyEvent>,
}

#[derive(Debug, Clone)]
pub enum PtyEvent {
    Output(String),
    Exit(Option<u32>),
    Error(String),
}

impl PtySession {
    pub fn spawn(cwd: &std::path::Path, cols: u16, rows: u16) -> Result<(Self, PtyOutput), AppError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::invalid_request(format!("Unable to open PTY: {error}")))?;

        let mut cmd = if cfg!(windows) {
            let mut command = CommandBuilder::new("powershell.exe");
            command.arg("-NoLogo");
            command
        } else {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
            CommandBuilder::new(shell)
        };
        cmd.cwd(cwd);
        // 控制平面持有的密钥不得泄漏到用户可见的 shell 中：
        // 一个 `env` 或 `echo $PROMETHEUS_MASTER_KEY` 就能解开整个 SecretVault。
        for key in sensitive_env_keys() {
            cmd.env_remove(&key);
        }

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|error| AppError::invalid_request(format!("Unable to spawn shell: {error}")))?;

        // Drop slave after spawn so the child owns it.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| AppError::invalid_request(format!("Unable to read PTY: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| AppError::invalid_request(format!("Unable to write PTY: {error}")))?;

        let (tx, rx) = mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));
        let closed_reader = closed.clone();
        let tx_reader = tx.clone();
        thread::spawn(move || {
            let mut buffer = [0_u8; 4096];
            loop {
                if closed_reader.load(Ordering::SeqCst) {
                    break;
                }
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buffer[..n]).into_owned();
                        if tx_reader.send(PtyEvent::Output(chunk)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        let _ = tx_reader.send(PtyEvent::Error(format!("PTY read failed: {error}")));
                        break;
                    }
                }
            }
            closed_reader.store(true, Ordering::SeqCst);
        });

        let closed_wait = closed.clone();
        let tx_wait = tx;
        thread::spawn(move || {
            let code = match child.wait() {
                Ok(status) => status.exit_code(),
                Err(_) => 1,
            };
            closed_wait.store(true, Ordering::SeqCst);
            let _ = tx_wait.send(PtyEvent::Exit(Some(code)));
        });

        Ok((
            Self {
                master: Mutex::new(pair.master),
                writer: Mutex::new(writer),
                closed,
            },
            PtyOutput { rx },
        ))
    }

    pub fn write(&self, data: &str) -> Result<(), AppError> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(AppError::invalid_request("Terminal session has exited"));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| AppError::configuration("PTY writer lock poisoned"))?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| AppError::invalid_request(format!("Unable to write terminal input: {error}")))?;
        writer
            .flush()
            .map_err(|error| AppError::invalid_request(format!("Unable to flush terminal input: {error}")))?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        let master = self
            .master
            .lock()
            .map_err(|_| AppError::configuration("PTY master lock poisoned"))?;
        master
            .resize(PtySize {
                rows: rows.max(8),
                cols: cols.max(20),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| AppError::invalid_request(format!("Unable to resize terminal: {error}")))?;
        Ok(())
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // Best-effort: writing ETX / exit is handled by client; dropping writer happens with session drop.
        let _ = self.write("");
        thread::sleep(Duration::from_millis(20));
    }
}
