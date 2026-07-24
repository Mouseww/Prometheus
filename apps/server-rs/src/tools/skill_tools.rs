use crate::{
    error::AppError,
    skill_service::SkillService,
    tools::{AgentTool, ToolApprovalPolicy, ToolResult},
};
use serde_json::json;

pub fn skill_tools(service: SkillService) -> Vec<AgentTool> {
    vec![read_skill_tool(service)]
}

fn read_skill_tool(service: SkillService) -> AgentTool {
    AgentTool {
        name: "read_skill".into(),
        description: "Load the full SKILL.md instructions for a configured skill id from the workspace skills directories.".into(),
        approval: ToolApprovalPolicy::Never,
        input_schema: json!({
            "type": "object",
            "properties": {
                "skillId": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120,
                    "description": "Skill folder id returned by the available skills list"
                }
            },
            "required": ["skillId"],
            "additionalProperties": false
        }),
        summarize_arguments: Some(Box::new(|arguments| {
            json!({
                "skillId": arguments.get("skillId").cloned().unwrap_or(json!(null))
            })
        })),
        permission_target: None,
        execute: Box::new(move |call| {
            let skill_id = call
                .arguments
                .get("skillId")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| AppError::invalid_request("skillId is required"))?;
            let content = service.read(skill_id)?;
            Ok(ToolResult {
                content,
                is_error: false,
            })
        }),
    }
}
