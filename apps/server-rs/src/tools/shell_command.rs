use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use wait_timeout::ChildExt;

use crate::{
    error::AppError, terminal_policy::sensitive_env_keys,
    terminal_session_service::redact_command_secrets, workspace_service::WorkspaceService,
};

use super::{AgentTool, ToolApprovalPolicy, ToolResult};

const MAX_OUTPUT_BYTES: usize = 64 * 1024;

pub fn shell_command_tool(workspace: WorkspaceService) -> AgentTool {
    AgentTool {
        name: "shell_command".into(),
        description: "Run a one-shot shell command inside the workspace after user approval."
            .into(),
        approval: ToolApprovalPolicy::Always,
        input_schema: json!({
            "type": "object",
            "properties": {
                "command": { "type": "string", "description": "Shell command to execute" },
                "workdir": {
                    "type": "string",
                    "description": "Workspace-relative working directory; empty means workspace root"
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 100,
                    "maximum": 120000,
                    "description": "Maximum runtime in milliseconds; defaults to 10000"
                }
            },
            "required": ["command"],
            "additionalProperties": false
        }),
        summarize_arguments: Some(Box::new(|arguments| {
            let command = string_arg(arguments, "command").unwrap_or_default();
            let workdir = string_arg(arguments, "workdir").unwrap_or_default();
            let timeout_ms = arguments
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(10_000);
            json!({
                "command": redact_command_secrets(command),
                "workdir": workdir,
                "timeoutMs": timeout_ms,
            })
        })),
        permission_target: Some(Box::new(|arguments| {
            string_arg(arguments, "command")
                .unwrap_or_default()
                .to_owned()
        })),
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let command = required_string(arguments, "command")?;
            let command = command.trim();
            if command.is_empty() || command.chars().count() > 20_000 {
                return Err(AppError::invalid_request("command is invalid"));
            }
            let workdir = string_arg(arguments, "workdir").unwrap_or_default();
            if workdir.chars().count() > 2_048 {
                return Err(AppError::invalid_request("workdir is too long"));
            }
            let timeout_ms = arguments
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(10_000)
                .clamp(100, 120_000);
            let cwd = workspace.resolve_directory(workdir.trim())?;
            run_shell(command, &cwd, timeout_ms)
        }),
    }
}

#[derive(Clone, Debug)]
pub struct ShellExecResult {
    pub exit_code: Option<i32>,
    pub duration_ms: u128,
    pub output: String,
    pub total_bytes: usize,
    pub timed_out: bool,
    pub is_error: bool,
}

pub fn execute_shell(
    workspace: &WorkspaceService,
    command: &str,
    workdir: &str,
    timeout_ms: Option<u64>,
) -> Result<ShellExecResult, AppError> {
    let command = command.trim();
    if command.is_empty() || command.chars().count() > 20_000 {
        return Err(AppError::invalid_request("command is invalid"));
    }
    if workdir.chars().count() > 2_048 {
        return Err(AppError::invalid_request("workdir is too long"));
    }
    let timeout_ms = timeout_ms.unwrap_or(10_000).clamp(100, 120_000);
    let cwd = workspace.resolve_directory(workdir.trim())?;
    run_shell_raw(command, &cwd, timeout_ms)
}

fn run_shell(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
) -> Result<ToolResult, AppError> {
    let result = run_shell_raw(command, cwd, timeout_ms)?;
    let timeout_reason = if result.timed_out {
        Some(format!("Command timed out after {timeout_ms} ms"))
    } else {
        None
    };
    Ok(ToolResult {
        content: format_result(
            result.exit_code,
            result.duration_ms,
            &result.output,
            result.total_bytes,
            timeout_reason.as_deref(),
        ),
        is_error: result.is_error,
    })
}

fn run_shell_raw(
    command: &str,
    cwd: &std::path::Path,
    timeout_ms: u64,
) -> Result<ShellExecResult, AppError> {
    let started = Instant::now();
    let mut process = if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]);
        cmd
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut cmd = Command::new(shell);
        cmd.args(["-lc", command]);
        cmd
    };
    process.current_dir(cwd);
    process.stdin(Stdio::null());
    process.stdout(Stdio::piped());
    process.stderr(Stdio::piped());
    // 与 PTY 共用同一份剥离清单——能力等价则脱敏等价。
    for key in sensitive_env_keys() {
        process.env_remove(&key);
    }

    let mut child = process
        .spawn()
        .map_err(|error| AppError::invalid_request(format!("Unable to start shell: {error}")))?;

    let status = child
        .wait_timeout(Duration::from_millis(timeout_ms))
        .map_err(|error| AppError::invalid_request(format!("Unable to wait shell: {error}")))?;

    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return Ok(ShellExecResult {
            exit_code: None,
            duration_ms: started.elapsed().as_millis(),
            output: String::new(),
            total_bytes: 0,
            timed_out: true,
            is_error: true,
        });
    };

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_end(&mut stdout);
    }
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_end(&mut stderr);
    }
    let mut combined = stdout;
    combined.extend_from_slice(&stderr);
    let total = combined.len();
    let tail = if combined.len() > MAX_OUTPUT_BYTES {
        &combined[combined.len() - MAX_OUTPUT_BYTES..]
    } else {
        &combined[..]
    };
    let text = sanitize_output(&String::from_utf8_lossy(tail));
    let exit_code = status.code();
    Ok(ShellExecResult {
        exit_code,
        duration_ms: started.elapsed().as_millis(),
        output: text,
        total_bytes: total,
        timed_out: false,
        is_error: exit_code != Some(0),
    })
}

fn format_result(
    exit_code: Option<i32>,
    duration_ms: u128,
    output: &str,
    total_bytes: usize,
    reason: Option<&str>,
) -> String {
    let mut lines = Vec::new();
    lines.push(format!(
        "Exit code: {}",
        exit_code
            .map(|code| code.to_string())
            .unwrap_or_else(|| "null".into())
    ));
    lines.push(format!("Duration: {duration_ms} ms"));
    if let Some(reason) = reason {
        lines.push(format!("Reason: {reason}"));
    }
    if total_bytes > MAX_OUTPUT_BYTES {
        lines.push(format!(
            "Output truncated to last {MAX_OUTPUT_BYTES} bytes (total {total_bytes})"
        ));
    }
    lines.push("Output:".into());
    lines.push(if output.is_empty() {
        "[empty]".into()
    } else {
        output.to_owned()
    });
    lines.join("\n")
}

fn sanitize_output(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch == '\n' || ch == '\r' || ch == '\t' || !ch.is_control() {
                ch
            } else {
                ' '
            }
        })
        .collect()
}

fn required_string<'a>(arguments: &'a Value, field: &str) -> Result<&'a str, AppError> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::invalid_request(format!("{field} is required")))
}

fn string_arg<'a>(arguments: &'a Value, field: &str) -> Option<&'a str> {
    arguments.get(field).and_then(Value::as_str)
}

