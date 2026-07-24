use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;

use crate::{
    error::AppError,
    models::{ChatMessage, ProviderResponse, ProviderUsage, RuntimeProvider},
    providers::util::{http_error, parse_tool_arguments},
    tools::{ToolCall, ToolDefinition},
};

pub async fn stream_chat_completion(
    provider: &RuntimeProvider,
    model: &str,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    on_text_delta: Option<UnboundedSender<String>>,
) -> Result<ProviderResponse, AppError> {
    let base_url = resolve_base_url(provider)?;
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

    let mut chat_messages = Vec::with_capacity(messages.len() + 1);
    chat_messages.push(json!({
        "role": "system",
        "content": system_prompt,
    }));
    for message in messages {
        chat_messages.push(map_chat_message(message));
    }

    let mut body = json!({
        "model": model,
        "messages": chat_messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                    })
                })
                .collect(),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| AppError::provider_request_failed(error.to_string()))?;

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| AppError::provider_request_failed(error.to_string()))?;

    let status = response.status();
    if !status.is_success() {
        let detail = response
            .text()
            .await
            .unwrap_or_else(|_| status.to_string());
        return Err(http_error(status, &detail));
    }

    let mut text = String::new();
    let mut provider_response_id: Option<String> = None;
    let mut usage: Option<ProviderUsage> = None;
    let mut pending_tool_calls: BTreeMap<u64, PendingToolCall> = BTreeMap::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| AppError::provider_request_failed(error.to_string()))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(index) = buffer.find('\n') {
            let mut line = buffer[..index].to_owned();
            buffer.drain(..=index);
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let payload: Value = serde_json::from_str(data).map_err(|error| {
                AppError::provider_request_failed(format!("Invalid provider SSE payload: {error}"))
            })?;
            if let Some(id) = payload.get("id").and_then(Value::as_str)
                && !id.is_empty()
            {
                provider_response_id = Some(id.to_owned());
            }
            if let Some(usage_value) = payload.get("usage").filter(|value| !value.is_null()) {
                usage = Some(ProviderUsage {
                    input_tokens: usage_value.get("prompt_tokens").and_then(Value::as_u64),
                    output_tokens: usage_value
                        .get("completion_tokens")
                        .and_then(Value::as_u64),
                    total_tokens: usage_value.get("total_tokens").and_then(Value::as_u64),
                });
            }
            let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
                continue;
            };
            for choice in choices {
                let Some(delta) = choice.get("delta") else {
                    continue;
                };
                if let Some(content) = delta.get("content").and_then(Value::as_str) {
                    text.push_str(content);
                    if let Some(sender) = on_text_delta.as_ref() {
                        let _ = sender.send(content.to_owned());
                    }
                }
                if let Some(tool_calls) = delta.get("tool_calls").and_then(Value::as_array) {
                    for tool_call in tool_calls {
                        let index = tool_call
                            .get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        let entry = pending_tool_calls.entry(index).or_default();
                        if let Some(id) = tool_call.get("id").and_then(Value::as_str) {
                            entry.id = id.to_owned();
                        }
                        if let Some(function) = tool_call.get("function") {
                            if let Some(name) = function.get("name").and_then(Value::as_str) {
                                entry.name.push_str(name);
                            }
                            if let Some(arguments) =
                                function.get("arguments").and_then(Value::as_str)
                            {
                                entry.arguments.push_str(arguments);
                            }
                        }
                    }
                }
            }
        }
    }

    let tool_calls = pending_tool_calls
        .into_values()
        .filter(|item| !item.id.is_empty() && !item.name.is_empty())
        .map(|item| ToolCall {
            id: item.id,
            name: item.name,
            arguments: parse_tool_arguments(&item.arguments),
        })
        .collect::<Vec<_>>();

    let text = text.trim().to_owned();
    if text.is_empty() && tool_calls.is_empty() {
        return Err(AppError::provider_request_failed(
            "OpenAI-compatible provider returned neither text nor tool calls",
        ));
    }

    Ok(ProviderResponse {
        text,
        tool_calls,
        provider_response_id,
        usage,
    })
}

#[derive(Default)]
struct PendingToolCall {
    id: String,
    name: String,
    arguments: String,
}

fn map_chat_message(message: &ChatMessage) -> Value {
    match message.role.as_str() {
        "tool" => json!({
            "role": "tool",
            "tool_call_id": message.tool_call_id.clone().unwrap_or_default(),
            "content": message.content,
        }),
        "assistant" if !message.tool_calls.is_empty() => {
            let content = if message.content.is_empty() {
                Value::Null
            } else {
                Value::String(message.content.clone())
            };
            json!({
                "role": "assistant",
                "content": content,
                "tool_calls": message.tool_calls.iter().map(|tool_call| {
                    json!({
                        "id": tool_call.id,
                        "type": "function",
                        "function": {
                            "name": tool_call.name,
                            "arguments": serde_json::to_string(&tool_call.arguments).unwrap_or_else(|_| "{}".into()),
                        }
                    })
                }).collect::<Vec<_>>(),
            })
        }
        _ => json!({
            "role": message.role,
            "content": message.content,
        }),
    }
}

fn resolve_base_url(provider: &RuntimeProvider) -> Result<String, AppError> {
    provider
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            AppError::provider_request_failed("OpenAI-compatible provider requires a base URL")
        })
}

