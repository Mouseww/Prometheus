use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct CreateSessionInput {
    pub title: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_sequence: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    pub kind: String,
    pub id: String,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendEventInput {
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub actor: Actor,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub sequence: i64,
    pub event_id: String,
    pub session_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub actor: Actor,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub default_model: String,
    pub has_api_key: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProviderInput {
    pub name: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub default_model: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProviderInput {
    pub name: Option<String>,
    pub base_url: Option<Option<String>>,
    pub default_model: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfile {
    pub id: String,
    pub name: String,
    pub description: String,
    pub system_prompt: String,
    pub provider_id: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub system_prompt: String,
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAgentInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRule {
    pub id: String,
    pub tool_name: String,
    pub effect: String,
    pub pattern: String,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePermissionRuleInput {
    pub tool_name: String,
    pub effect: String,
    pub pattern: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAgentRunInput {
    pub agent_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub run_id: String,
    pub reply_event: SessionEvent,
    pub completed_event: SessionEvent,
}

#[derive(Clone, Debug)]
pub struct RuntimeProvider {
    pub id: String,
    pub kind: String,
    pub base_url: Option<String>,
    pub api_key: String,
}

#[derive(Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub is_error: bool,
    pub tool_calls: Vec<crate::tools::ToolCall>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: content.into(),
            tool_call_id: None,
            tool_name: None,
            is_error: false,
            tool_calls: Vec::new(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_call_id: None,
            tool_name: None,
            is_error: false,
            tool_calls: Vec::new(),
        }
    }

    pub fn assistant_with_tools(
        content: impl Into<String>,
        tool_calls: Vec<crate::tools::ToolCall>,
    ) -> Self {
        Self {
            role: "assistant".into(),
            content: content.into(),
            tool_call_id: None,
            tool_name: None,
            is_error: false,
            tool_calls,
        }
    }

    pub fn tool(
        tool_call_id: impl Into<String>,
        tool_name: impl Into<String>,
        content: impl Into<String>,
        is_error: bool,
    ) -> Self {
        Self {
            role: "tool".into(),
            content: content.into(),
            tool_call_id: Some(tool_call_id.into()),
            tool_name: Some(tool_name.into()),
            is_error,
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProviderUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ProviderResponse {
    pub text: String,
    pub tool_calls: Vec<crate::tools::ToolCall>,
    pub provider_response_id: Option<String>,
    pub usage: Option<ProviderUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTeamRunInput {
    pub goal: String,
    pub agent_ids: Vec<String>,
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: u32,
    #[serde(default = "default_workspace_mode")]
    pub workspace_mode: String,
    #[serde(default = "default_merge_strategy")]
    pub merge_strategy: String,
    #[serde(default)]
    pub path_assignments: Vec<TeamPathAssignment>,
}

fn default_max_concurrency() -> u32 {
    4
}

fn default_workspace_mode() -> String {
    "readonly".to_owned()
}

fn default_merge_strategy() -> String {
    "manual".to_owned()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamPathAssignment {
    pub agent_id: String,
    pub paths: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunTask {
    pub id: String,
    pub team_run_id: String,
    pub session_id: String,
    pub agent_id: String,
    pub agent_label: String,
    pub prompt: String,
    pub status: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub allowed_paths: Vec<String>,
    pub worktree_branch: Option<String>,
    pub base_commit: Option<String>,
    pub changed_paths: Vec<String>,
    pub change_status: String,
    pub conflict_paths: Vec<String>,
    pub patch_bytes: u64,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRun {
    pub id: String,
    pub session_id: String,
    pub goal: String,
    pub status: String,
    pub max_concurrency: u32,
    pub workspace_mode: String,
    pub merge_strategy: String,
    pub tasks: Vec<TeamRunTask>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessage {
    pub id: String,
    pub sequence: i64,
    pub team_run_id: String,
    pub session_id: String,
    pub sender_agent_id: String,
    pub sender_label: String,
    pub recipient_id: String,
    pub recipient_label: String,
    pub channel: String,
    pub subject: Option<String>,
    pub body: String,
    pub source_run_id: Option<String>,
    pub source_tool_call_id: Option<String>,
    pub created_at: String,
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::BTreeMap<String, String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerInput {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMcpServerInput {
    pub name: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<std::collections::BTreeMap<String, String>>,
    pub enabled: Option<bool>,
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStore {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub default_connected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCatalogEntry {
    pub id: String,
    pub store_id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub tags: Vec<String>,
    pub installed: bool,
    pub install: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallExtensionInput {
    pub entry_id: String,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallGithubSkillInput {
    pub repo: String,
    pub path: String,
    #[serde(default)]
    pub r#ref: Option<String>,
    #[serde(default)]
    pub skill_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExtensionInstallResult {
    #[serde(rename = "skill")]
    Skill { skill: SkillSummary },
    #[serde(rename = "mcp")]
    Mcp { server: McpServer },
}

fn default_true() -> bool {
    true
}
