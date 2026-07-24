use std::{
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::timeout,
};

use crate::{
    error::AppError,
    models::McpServer,
    tools::{AgentTool, ToolApprovalPolicy, ToolDefinition, ToolResult},
};

pub struct McpSession {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: AtomicU64,
    tools: Vec<RemoteTool>,
}

#[derive(Clone, Debug)]
struct RemoteTool {
    name: String,
    description: String,
    input_schema: Value,
}

impl McpSession {
    pub async fn connect(server: &McpServer) -> Result<Self, AppError> {
        let mut command = Command::new(&server.command);
        command
            .args(&server.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in &server.env {
            command.env(key, value);
        }
        let mut child = command.spawn().map_err(|error| {
            AppError::provider_request_failed(format!(
                "Failed to start MCP server '{}': {error}",
                server.name
            ))
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::provider_request_failed("MCP server stdin unavailable")
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            AppError::provider_request_failed("MCP server stdout unavailable")
        })?;
        let mut session = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: AtomicU64::new(1),
            tools: Vec::new(),
        };
        let init = session
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "prometheus",
                        "version": "0.1.0"
                    }
                }),
            )
            .await?;
        if init.get("error").is_some() {
            return Err(AppError::provider_request_failed(format!(
                "MCP initialize failed for '{}': {}",
                server.name,
                init
            )));
        }
        session
            .notify(
                "notifications/initialized",
                json!({}),
            )
            .await?;
        let listed = session.request("tools/list", json!({})).await?;
        if let Some(error) = listed.get("error") {
            return Err(AppError::provider_request_failed(format!(
                "MCP tools/list failed for '{}': {error}",
                server.name
            )));
        }
        let tools = listed
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        session.tools = tools
            .into_iter()
            .filter_map(|tool| {
                let name = tool.get("name")?.as_str()?.to_owned();
                if name.is_empty() {
                    return None;
                }
                Some(RemoteTool {
                    name,
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    input_schema: tool
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({"type":"object","properties":{}})),
                })
            })
            .collect();
        Ok(session)
    }
}

pub struct McpRuntimeHandle {
    server_name: String,
    session: std::sync::Arc<tokio::sync::Mutex<McpSession>>,
    remote_tools: Vec<RemoteTool>,
}

impl McpRuntimeHandle {
    pub async fn connect(server: &McpServer) -> Result<Self, AppError> {
        let session = McpSession::connect(server).await?;
        let remote_tools = session.tools.clone();
        Ok(Self {
            server_name: server.name.clone(),
            session: std::sync::Arc::new(tokio::sync::Mutex::new(session)),
            remote_tools,
        })
    }

    pub fn into_agent_tools(self) -> Vec<AgentTool> {
        let mut tools = Vec::with_capacity(self.remote_tools.len());
        for remote in &self.remote_tools {
            let qualified = format!("mcp__{}__{}", sanitize(&self.server_name), sanitize(&remote.name));
            let session = self.session.clone();
            let server_name = self.server_name.clone();
            let remote_name = remote.name.clone();
            let description = if remote.description.is_empty() {
                format!("MCP tool {}.{} from configured server", server_name, remote.name)
            } else {
                format!("[MCP:{}] {}", server_name, remote.description)
            };
            let input_schema = remote.input_schema.clone();
            let permission_server = server_name.clone();
            let permission_remote = remote_name.clone();
            let execute_remote = remote_name.clone();
            tools.push(AgentTool {
                name: qualified,
                description,
                approval: ToolApprovalPolicy::Always,
                input_schema,
                summarize_arguments: None,
                permission_target: Some(Box::new(move |arguments| {
                    format!("{permission_server}.{permission_remote}:{}", compact_args(arguments))
                })),
                execute: Box::new(move |call| {
                    let runtime = tokio::runtime::Handle::try_current().map_err(|_| {
                        AppError::invalid_request("MCP tools require a Tokio runtime")
                    })?;
                    let session = session.clone();
                    let remote_name = execute_remote.clone();
                    let arguments = call.arguments.clone();
                    let result = tokio::task::block_in_place(|| {
                        runtime.block_on(async move {
                            let mut guard = session.lock().await;
                            guard.call_tool(&remote_name, arguments).await
                        })
                    })?;
                    Ok(result)
                }),
            });
        }
        tools
    }
}

impl McpSession {
    async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<ToolResult, AppError> {
        let response = self
            .request(
                "tools/call",
                json!({
                    "name": name,
                    "arguments": arguments,
                }),
            )
            .await?;
        if let Some(error) = response.get("error") {
            return Ok(ToolResult {
                content: format!("MCP tool error: {error}"),
                is_error: true,
            });
        }
        let result = response.get("result").cloned().unwrap_or(json!({}));
        let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
        let content = if let Some(items) = result.get("content").and_then(Value::as_array) {
            items
                .iter()
                .filter_map(|item| {
                    if item.get("type").and_then(Value::as_str) == Some("text") {
                        item.get("text").and_then(Value::as_str).map(str::to_owned)
                    } else {
                        Some(item.to_string())
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            result.to_string()
        };
        Ok(ToolResult {
            content: if content.is_empty() { "[empty MCP result]".into() } else { content },
            is_error,
        })
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let message = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_message(&message).await?;
        loop {
            let payload = self.read_message().await?;
            if payload.get("id").and_then(Value::as_u64) == Some(id)
                || payload.get("id").and_then(Value::as_i64) == Some(id as i64)
            {
                return Ok(payload);
            }
            // ignore unrelated notifications/responses
        }
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), AppError> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.write_message(&message).await
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), AppError> {
        let body = serde_json::to_vec(message).map_err(|error| {
            AppError::provider_request_failed(format!("Invalid MCP payload: {error}"))
        })?;
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        self.stdin
            .write_all(header.as_bytes())
            .await
            .map_err(|error| AppError::provider_request_failed(format!("MCP write failed: {error}")))?;
        self.stdin
            .write_all(&body)
            .await
            .map_err(|error| AppError::provider_request_failed(format!("MCP write failed: {error}")))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| AppError::provider_request_failed(format!("MCP flush failed: {error}")))?;
        Ok(())
    }

    async fn read_message(&mut self) -> Result<Value, AppError> {
        let mut content_length: Option<usize> = None;
        loop {
            let mut line = String::new();
            let read = timeout(Duration::from_secs(15), self.stdout.read_line(&mut line))
                .await
                .map_err(|_| AppError::provider_request_failed("MCP read timed out"))?
                .map_err(|error| {
                    AppError::provider_request_failed(format!("MCP read failed: {error}"))
                })?;
            if read == 0 {
                return Err(AppError::provider_request_failed(
                    "MCP server closed stdout",
                ));
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(value) = trimmed
                .split_once(':')
                .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim())
            {
                content_length = value.parse().ok();
            }
        }
        let length = content_length.ok_or_else(|| {
            AppError::provider_request_failed("MCP response missing Content-Length")
        })?;
        let mut body = vec![0_u8; length];
        timeout(Duration::from_secs(15), self.stdout.read_exact(&mut body))
            .await
            .map_err(|_| AppError::provider_request_failed("MCP body read timed out"))?
            .map_err(|error| {
                AppError::provider_request_failed(format!("MCP body read failed: {error}"))
            })?;
        serde_json::from_slice(&body).map_err(|error| {
            AppError::provider_request_failed(format!("Invalid MCP JSON: {error}"))
        })
    }
}

impl Drop for McpSession {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub struct McpLoadResult {
    pub tools: Vec<AgentTool>,
    pub diagnostics: Vec<String>,
}

pub async fn load_mcp_tools(servers: &[McpServer]) -> McpLoadResult {
    let mut tools = Vec::new();
    let mut diagnostics = Vec::new();
    for server in servers {
        match McpRuntimeHandle::connect(server).await {
            Ok(handle) => tools.extend(handle.into_agent_tools()),
            Err(error) => {
                diagnostics.push(format!(
                    "MCP server '{}' failed to start: {}",
                    server.name,
                    error
                ));
            }
        }
    }
    McpLoadResult { tools, diagnostics }
}

pub fn definitions_from_tools(tools: &[AgentTool]) -> Vec<ToolDefinition> {
    tools.iter().map(AgentTool::definition).collect()
}

fn sanitize(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn compact_args(arguments: &Value) -> String {
    let raw = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".into());
    if raw.len() <= 120 {
        raw
    } else {
        format!("{}…", &raw[..120])
    }
}
