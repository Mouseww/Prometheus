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

pub async fn stream_messages(
    provider: &RuntimeProvider,
    model: &str,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    on_text_delta: Option<UnboundedSender<String>>,
) -> Result<ProviderResponse, AppError> {
    let base_url = provider
        .base_url
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://api.anthropic.com".to_owned());
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

    let mut body = json!({
        "model": model,
        "max_tokens": 8192,
        "system": system_prompt,
        "messages": messages.iter().map(map_message).collect::<Vec<_>>(),
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "input_schema": tool.input_schema,
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
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2023-06-01")
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
    let mut usage = ProviderUsage::default();
    let mut pending: BTreeMap<u64, PendingToolCall> = BTreeMap::new();
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
            if line.is_empty() || line.starts_with("event:") {
                continue;
            }
            if !line.starts_with("data:") {
                continue;
            }
            let data = line[5..].trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let payload: Value = serde_json::from_str(data).map_err(|error| {
                AppError::provider_request_failed(format!("Invalid Anthropic SSE payload: {error}"))
            })?;
            let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            match event_type {
                "message_start" => {
                    if let Some(message) = payload.get("message") {
                        if let Some(id) = message.get("id").and_then(Value::as_str) {
                            provider_response_id = Some(id.to_owned());
                        }
                        if let Some(input) = message
                            .pointer("/usage/input_tokens")
                            .and_then(Value::as_u64)
                        {
                            usage.input_tokens = Some(input);
                        }
                    }
                }
                "content_block_start" => {
                    let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
                    if let Some(block) = payload.get("content_block")
                        && block.get("type").and_then(Value::as_str) == Some("tool_use")
                    {
                        let entry = pending.entry(index).or_default();
                        entry.id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        entry.name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                    }
                }
                "content_block_delta" => {
                    let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0);
                    if let Some(delta) = payload.get("delta") {
                        match delta.get("type").and_then(Value::as_str) {
                            Some("text_delta") => {
                                if let Some(piece) = delta.get("text").and_then(Value::as_str) {
                                    text.push_str(piece);
                                    if let Some(sender) = on_text_delta.as_ref() {
                                        let _ = sender.send(piece.to_owned());
                                    }
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some(piece) =
                                    delta.get("partial_json").and_then(Value::as_str)
                                {
                                    pending.entry(index).or_default().arguments.push_str(piece);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "message_delta" => {
                    if let Some(output) = payload
                        .pointer("/usage/output_tokens")
                        .and_then(Value::as_u64)
                    {
                        usage.output_tokens = Some(output);
                    }
                }
                _ => {}
            }
        }
    }

    if usage.input_tokens.is_some() || usage.output_tokens.is_some() {
        usage.total_tokens = Some(
            usage.input_tokens.unwrap_or(0) + usage.output_tokens.unwrap_or(0),
        );
    }

    let tool_calls = pending
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
            "Anthropic returned an empty response",
        ));
    }

    let usage = if usage.input_tokens.is_none()
        && usage.output_tokens.is_none()
        && usage.total_tokens.is_none()
    {
        None
    } else {
        Some(usage)
    };

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

fn map_message(message: &ChatMessage) -> Value {
    if message.role == "tool" {
        return json!({
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": message.tool_call_id.clone().unwrap_or_default(),
                "content": message.content,
                "is_error": message.is_error,
            }],
        });
    }
    if message.role == "assistant" && !message.tool_calls.is_empty() {
        let mut content = Vec::new();
        if !message.content.is_empty() {
            content.push(json!({"type": "text", "text": message.content}));
        }
        for tool_call in &message.tool_calls {
            content.push(json!({
                "type": "tool_use",
                "id": tool_call.id,
                "name": tool_call.name,
                "input": tool_call.arguments,
            }));
        }
        return json!({
            "role": "assistant",
            "content": content,
        });
    }
    json!({
        "role": message.role,
        "content": message.content,
    })
}
