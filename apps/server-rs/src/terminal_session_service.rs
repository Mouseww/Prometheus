//! 终端会话的准入编排：把 `/ws/terminal` 与 `/api/terminal/exec` 纳入
//! 与 `shell_command` 工具完全一致的权限与审计体系。
//!
//! **能力等价则策略等价**——这是本模块存在的唯一理由。
//! 在此之前，PTY 通道拥有 `shell_command` 的全部能力（且不受超时与输出截断约束），
//! 却不经过 [`crate::tool_permission_policy`]、不经过 [`crate::approval_coordinator`]、
//! 不产生任何 durable 事件，直接推翻了"Shell 每次执行均经过跨终端审批"的产品承诺。
//!
//! 两条通道的策略差异只源于形态，不源于宽松度：
//! - 一次性 exec 能看到完整命令 → 按命令逐条走 `evaluate_permission`，语义与工具调用逐字相同
//! - 交互式 PTY 看不到后续输入 → 只能在**开启会话**这一刻裁决，因此它天然比 exec 更重

use std::time::Duration;

use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    approval_coordinator::ApprovalDecision,
    error::AppError,
    models::{Actor, AppendEventInput, SessionEvent},
    state::AppState,
    terminal_policy::TerminalMode,
    tool_permission_policy::{PermissionDecision, evaluate_permission},
};

/// 等待跨终端裁决的上限。超时按拒绝处理——悬空的审批比误拒更危险。
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(300);

/// 终端通道在权限规则中使用的工具名。
///
/// exec 复用 `shell_command`，使得用户已配置的 allow/deny 规则自动生效（DRY）；
/// PTY 使用独立名字，因为"开一个交互式 shell"与"跑一条命令"不是同一个决策。
pub const EXEC_TOOL_NAME: &str = "shell_command";
pub const PTY_TOOL_NAME: &str = "terminal_session";

fn system_actor(id: &str, label: &str) -> Actor {
    Actor {
        kind: "system".into(),
        id: id.into(),
        label: label.into(),
    }
}

/// 授权通过后返回的凭据，携带用于闭合审计事件的 tool call id。
#[derive(Clone, Debug)]
pub struct TerminalGrant {
    pub session_id: String,
    pub tool_call_id: String,
}

#[derive(Clone)]
pub struct TerminalSessionService {
    state: AppState,
}

impl TerminalSessionService {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    fn terminal_mode(&self) -> Result<TerminalMode, AppError> {
        self.state.with_config(|config| config.terminal_mode())
    }

    async fn commit(
        &self,
        session_id: &str,
        input: AppendEventInput,
    ) -> Result<SessionEvent, AppError> {
        let event = self.state.sessions.append_event(session_id, input).await?;
        self.state.event_hub.publish(event.clone()).await;
        Ok(event)
    }

    /// 校验 session 存在。终端事件必须落在真实会话上，否则审计链断裂。
    async fn ensure_session(&self, session_id: &str) -> Result<(), AppError> {
        if Uuid::parse_str(session_id).is_err() {
            return Err(AppError::invalid_request("sessionId must be a UUID"));
        }
        if self.state.sessions.get(session_id).await?.is_none() {
            return Err(AppError::session_not_found(session_id));
        }
        Ok(())
    }

    /// 授权一条一次性终端命令。
    ///
    /// 与 `shell_command` 工具走完全相同的规则求值：deny → 直接拒绝，
    /// allow → 放行，ask（含未匹配任何规则）→ 发起跨终端审批。
    pub async fn authorize_exec(
        &self,
        session_id: &str,
        command: &str,
        workdir: &str,
    ) -> Result<TerminalGrant, AppError> {
        let mode = self.terminal_mode()?;
        mode.ensure_enabled()?;
        self.ensure_session(session_id).await?;

        let tool_call_id = Uuid::new_v4().to_string();
        let summary = json!({
            "command": redact_command_secrets(command),
            "workdir": workdir,
            "channel": "terminal_exec",
        });

        self.commit(
            session_id,
            AppendEventInput {
                event_id: Uuid::new_v4().to_string(),
                event_type: "tool.call.started".to_owned(),
                actor: system_actor("terminal", "Terminal"),
                payload: json!({
                    "toolCallId": tool_call_id,
                    "toolName": EXEC_TOOL_NAME,
                    "channel": "terminal_exec",
                    "arguments": summary,
                }),
            },
        )
        .await?;

        if mode.requires_approval() {
            let decision = self
                .evaluate_and_authorize(
                    session_id,
                    &tool_call_id,
                    EXEC_TOOL_NAME,
                    command,
                    &summary,
                )
                .await?;
            if decision != ApprovalDecision::Approved {
                self.finish(
                    &TerminalGrant {
                        session_id: session_id.to_owned(),
                        tool_call_id: tool_call_id.clone(),
                    },
                    EXEC_TOOL_NAME,
                    json!({ "status": "denied" }),
                )
                .await;
                return Err(AppError::forbidden("Terminal command denied"));
            }
        }

        Ok(TerminalGrant {
            session_id: session_id.to_owned(),
            tool_call_id,
        })
    }

    /// 授权开启一个交互式 PTY 会话。
    pub async fn authorize_pty(
        &self,
        session_id: &str,
        cwd: &str,
    ) -> Result<TerminalGrant, AppError> {
        let mode = self.terminal_mode()?;
        mode.ensure_enabled()?;
        self.ensure_session(session_id).await?;

        let tool_call_id = Uuid::new_v4().to_string();
        let summary = json!({
            "cwd": cwd,
            "channel": "terminal_pty",
            "note": "Interactive shell — individual commands are not separately approved",
        });

        self.commit(
            session_id,
            AppendEventInput {
                event_id: Uuid::new_v4().to_string(),
                event_type: "tool.call.started".to_owned(),
                actor: system_actor("terminal", "Terminal"),
                payload: json!({
                    "toolCallId": tool_call_id,
                    "toolName": PTY_TOOL_NAME,
                    "channel": "terminal_pty",
                    "arguments": summary,
                }),
            },
        )
        .await?;

        if mode.requires_approval() {
            let decision = self
                .evaluate_and_authorize(session_id, &tool_call_id, PTY_TOOL_NAME, cwd, &summary)
                .await?;
            if decision != ApprovalDecision::Approved {
                self.finish(
                    &TerminalGrant {
                        session_id: session_id.to_owned(),
                        tool_call_id: tool_call_id.clone(),
                    },
                    PTY_TOOL_NAME,
                    json!({ "status": "denied" }),
                )
                .await;
                return Err(AppError::forbidden("Terminal session denied"));
            }
        }

        Ok(TerminalGrant {
            session_id: session_id.to_owned(),
            tool_call_id,
        })
    }

    /// 写入终止事件，闭合审计链。best-effort：调用方通常已在错误路径上。
    pub async fn finish(&self, grant: &TerminalGrant, tool_name: &str, outcome: Value) {
        let _ = self
            .commit(
                &grant.session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "tool.call.completed".to_owned(),
                    actor: system_actor("terminal", "Terminal"),
                    payload: json!({
                        "toolCallId": grant.tool_call_id,
                        "toolName": tool_name,
                        "outcome": outcome,
                    }),
                },
            )
            .await;
    }

    /// 规则求值 + 必要时的跨终端审批。返回最终裁决。
    async fn evaluate_and_authorize(
        &self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        target: &str,
        summary: &Value,
    ) -> Result<ApprovalDecision, AppError> {
        let rules = self.state.configuration.list_permission_rules().await?;
        let evaluation = evaluate_permission(&rules, tool_name, target);
        if !evaluation.rules.is_empty() {
            let _ = self
                .commit(
                    session_id,
                    AppendEventInput {
                        event_id: Uuid::new_v4().to_string(),
                        event_type: "permission.rule.matched".to_owned(),
                        actor: system_actor("permission-policy", "Permission Policy"),
                        payload: json!({
                            "toolCallId": tool_call_id,
                            "toolName": tool_name,
                            "effect": evaluation.decision.as_str(),
                            "arguments": summary,
                            "rules": evaluation.rules.iter().map(|rule| json!({
                                "id": rule.id,
                                "pattern": rule.pattern,
                            })).collect::<Vec<_>>(),
                        }),
                    },
                )
                .await;
        }
        match evaluation.decision {
            PermissionDecision::Allow => return Ok(ApprovalDecision::Approved),
            PermissionDecision::Deny => return Ok(ApprovalDecision::Denied),
            PermissionDecision::Ask => {}
        }

        let (approval_id, receiver) = self.state.approvals.create(session_id)?;
        let _ = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "approval.requested".to_owned(),
                    actor: system_actor("approval-gate", "Approval Gate"),
                    payload: json!({
                        "approvalId": approval_id,
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "arguments": summary,
                    }),
                },
            )
            .await;

        // 超时按拒绝处理：一个永远等不到裁决的 PTY 升级请求会占住连接。
        let decision = match tokio::time::timeout(APPROVAL_TIMEOUT, receiver).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(_)) | Err(_) => ApprovalDecision::Denied,
        };

        let _ = self
            .commit(
                session_id,
                AppendEventInput {
                    event_id: Uuid::new_v4().to_string(),
                    event_type: "approval.resolved".to_owned(),
                    actor: system_actor("approval-gate", "Approval Gate"),
                    payload: json!({
                        "approvalId": approval_id,
                        "toolCallId": tool_call_id,
                        "toolName": tool_name,
                        "decision": decision.as_str(),
                    }),
                },
            )
            .await;

        Ok(decision)
    }
}

/// 与 `shell_command` 工具共用的脱敏逻辑，避免密钥进入 durable 事件。
pub fn redact_command_secrets(command: &str) -> String {
    let mut output = command.to_owned();
    for key in ["api_key", "token", "password", "secret"] {
        if let Some(index) = output.to_ascii_lowercase().find(key) {
            let after = index + key.len();
            if let Some(rest) = output.get(after..)
                && (rest.starts_with('=') || rest.starts_with(':'))
            {
                let value_start = after + 1;
                let value_end = output[value_start..]
                    .find(char::is_whitespace)
                    .map(|offset| value_start + offset)
                    .unwrap_or(output.len());
                output.replace_range(value_start..value_end, "[redacted]");
            }
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_inline_credentials_before_persisting() {
        assert_eq!(
            redact_command_secrets("curl -H token=abc123 https://x.test"),
            "curl -H token=[redacted] https://x.test"
        );
        assert_eq!(
            redact_command_secrets("echo hello"),
            "echo hello"
        );
    }

    #[test]
    fn exec_reuses_shell_command_rules_so_existing_policy_applies() {
        // 这一断言是刻意的：`/api/terminal/exec` 与 shell_command 工具能力等价，
        // 必须共享同一套用户已配置的规则，而不是另开一个更宽松的命名空间。
        assert_eq!(EXEC_TOOL_NAME, "shell_command");
        assert_ne!(PTY_TOOL_NAME, EXEC_TOOL_NAME);
    }
}
