use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{error::AppError, workspace_service::WorkspaceService};

use super::{AgentTool, ToolApprovalPolicy, ToolResult};

pub fn workspace_tools(workspace: WorkspaceService) -> Vec<AgentTool> {
    let mut tools = readonly_tools(workspace.clone());
    tools.push(write_file_tool(workspace));
    tools
}

pub fn readonly_tools(workspace: WorkspaceService) -> Vec<AgentTool> {
    vec![
        list_directory_tool(workspace.clone()),
        read_file_tool(workspace.clone()),
        search_text_tool(workspace),
    ]
}

fn list_directory_tool(workspace: WorkspaceService) -> AgentTool {
    AgentTool {
        name: "list_directory".into(),
        description: "List files and directories at a workspace-relative path.".into(),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Workspace-relative directory path; empty means root"
                }
            },
            "additionalProperties": false
        }),
        summarize_arguments: None,
        permission_target: None,
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let path = string_arg(arguments, "path").unwrap_or_default();
            if path.chars().count() > 2_048 {
                return Err(AppError::invalid_request("path is too long"));
            }
            let nodes = workspace.list(path.trim())?;
            let content = if nodes.is_empty() {
                "[Directory is empty]".to_owned()
            } else {
                nodes
                    .iter()
                    .map(|node| format!("{}\t{}", node.kind, node.path))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok(ToolResult {
                content,
                is_error: false,
            })
        }),
    }
}

fn read_file_tool(workspace: WorkspaceService) -> AgentTool {
    AgentTool {
        name: "read_file".into(),
        description: "Read a UTF-8 text file inside the workspace.".into(),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path" }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
        summarize_arguments: None,
        permission_target: None,
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let path = required_string(arguments, "path")?;
            if path.trim().is_empty() || path.chars().count() > 2_048 {
                return Err(AppError::invalid_request("path is invalid"));
            }
            let result = workspace.read_text_file(path.trim(), None)?;
            let content = if result.truncated {
                format!("{}\n\n[Output truncated at 65536 bytes]", result.content)
            } else {
                result.content
            };
            Ok(ToolResult {
                content,
                is_error: false,
            })
        }),
    }
}

fn search_text_tool(workspace: WorkspaceService) -> AgentTool {
    AgentTool {
        name: "search_text".into(),
        description: "Search UTF-8 workspace files recursively for literal text.".into(),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Literal text to find" },
                "path": {
                    "type": "string",
                    "description": "Workspace-relative file or directory; empty means root"
                }
            },
            "required": ["query"],
            "additionalProperties": false
        }),
        summarize_arguments: None,
        permission_target: None,
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let query = required_string(arguments, "query")?;
            if query.is_empty() || query.chars().count() > 500 {
                return Err(AppError::invalid_request("query is invalid"));
            }
            let path = string_arg(arguments, "path").unwrap_or_default();
            if path.chars().count() > 2_048 {
                return Err(AppError::invalid_request("path is too long"));
            }
            let matches = workspace.search_text(query, path.trim(), None)?;
            let content = if matches.is_empty() {
                "[No matches]".to_owned()
            } else {
                matches
                    .iter()
                    .map(|item| format!("{}:{}: {}", item.path, item.line, item.text))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            Ok(ToolResult {
                content,
                is_error: false,
            })
        }),
    }
}

fn write_file_tool(workspace: WorkspaceService) -> AgentTool {
    AgentTool {
        name: "write_file".into(),
        description: "Write UTF-8 text to a workspace-relative file after user approval.".into(),
        approval: ToolApprovalPolicy::Always,
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Workspace-relative file path" },
                "content": { "type": "string", "description": "Complete UTF-8 file content" }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
        summarize_arguments: Some(Box::new(|arguments| {
            let path = string_arg(arguments, "path").unwrap_or("[invalid path]");
            let content = string_arg(arguments, "content").unwrap_or_default();
            let chars: Vec<char> = content.chars().collect();
            let preview_len = chars.len().saturating_sub(1).min(200);
            let preview: String = chars.iter().take(preview_len).collect();
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            let digest = format!("{:x}", hasher.finalize());
            json!({
                "path": path,
                "contentBytes": content.len(),
                "contentPreview": preview,
                "contentPreviewTruncated": preview_len < chars.len(),
                "contentSha256": digest,
            })
        })),
        permission_target: Some(Box::new(|arguments| {
            string_arg(arguments, "path").unwrap_or_default().to_owned()
        })),
        execute: Box::new(move |call| {
            let arguments = &call.arguments;
            let path = required_string(arguments, "path")?;
            let content = required_string(arguments, "content")?;
            if path.trim().is_empty() || path.chars().count() > 2_048 {
                return Err(AppError::invalid_request("path is invalid"));
            }
            if content.len() > 1024 * 1024 {
                return Err(AppError::invalid_request("content is too large"));
            }
            let written = workspace.write_text_file(path.trim(), content, None)?;
            Ok(ToolResult {
                content: format!("Wrote {} bytes to {}", written.bytes, written.path),
                is_error: false,
            })
        }),
    }
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


