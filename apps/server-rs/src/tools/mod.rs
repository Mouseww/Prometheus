use std::sync::Arc;

use serde_json::Value;

use crate::error::AppError;

pub mod delegate_team_tools;
pub mod shell_command;
pub mod skill_tools;
pub mod team_message_tools;
pub mod workspace_tools;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolApprovalPolicy {
    Never,
    Always,
}

#[derive(Clone, Debug)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
}

#[derive(Clone, Debug)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

type SummarizeFn = dyn Fn(&Value) -> Value + Send + Sync;
type PermissionTargetFn = dyn Fn(&Value) -> String + Send + Sync;
type ExecuteFn = dyn Fn(&ToolCall) -> Result<ToolResult, AppError> + Send + Sync;

pub struct AgentTool {
    pub name: String,
    pub description: String,
    pub approval: ToolApprovalPolicy,
    pub input_schema: Value,
    pub summarize_arguments: Option<Box<SummarizeFn>>,
    pub permission_target: Option<Box<PermissionTargetFn>>,
    pub execute: Box<ExecuteFn>,
}

impl AgentTool {
    pub fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
        }
    }

    pub fn summarize(&self, arguments: &Value) -> Value {
        if let Some(summarize) = &self.summarize_arguments {
            return summarize(arguments);
        }
        compact_tool_arguments(arguments)
    }
}

pub type SharedTools = Arc<Vec<AgentTool>>;

pub fn default_tools(workspace: crate::workspace_service::WorkspaceService) -> SharedTools {
    Arc::new(full_tools(workspace))
}

pub fn readonly_tools(workspace: crate::workspace_service::WorkspaceService) -> Vec<AgentTool> {
    workspace_tools::readonly_tools(workspace)
}

pub fn full_tools(workspace: crate::workspace_service::WorkspaceService) -> Vec<AgentTool> {
    let mut tools = workspace_tools::workspace_tools(workspace.clone());
    tools.push(shell_command::shell_command_tool(workspace));
    tools
}

pub fn compact_tool_arguments(arguments: &Value) -> Value {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "{}".into());
    if serialized.len() <= 4_000 {
        arguments.clone()
    } else {
        serde_json::json!({
            "summary": format!("Arguments omitted ({} bytes)", serialized.len())
        })
    }
}
