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

pub async fn stream_responses(
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
        .unwrap_or_else(|| "https://api.openai.com/v1".to_owned());
    let url = format!("{}/responses", base_url.trim_end_matches('/'));

    let mut input = Vec::new();
    for message in messages {
        input.extend(map_input_items(message));
    }

    let mut body = json!({
        "model": model,
        "instructions": system_prompt,
        "input": input,
        "stream": true,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                        "strict": false,
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

    let mut streamed_text = String::new();
    let mut completed: Option<ProviderResponse> = None;
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
                AppError::provider_request_failed(format!(
                    "Invalid OpenAI Responses SSE payload: {error}"
                ))
            })?;
            let event_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
            if event_type == "response.output_text.delta" {
                if let Some(delta) = payload.get("delta").and_then(Value::as_str) {
                    streamed_text.push_str(delta);
                    if let Some(sender) = on_text_delta.as_ref() {
                        let _ = sender.send(delta.to_owned());
                    }
                }
            } else if event_type == "response.completed" {
                let response_value = payload
                    .get("response")
                    .cloned()
                    .ok_or_else(|| {
                        AppError::provider_request_failed(
                            "OpenAI completed event omitted its response",
                        )
                    })?;
                completed = Some(map_completed_response(response_value)?);
            }
        }
    }

    if let Some(response) = completed {
        return Ok(response);
    }

    let text = streamed_text.trim().to_owned();
    if text.is_empty() {
        return Err(AppError::provider_request_failed(
            "OpenAI returned an empty response",
        ));
    }
    Ok(ProviderResponse {
        text,
        tool_calls: Vec::new(),
        provider_response_id: None,
        usage: None,
    })
}

fn map_completed_response(response: Value) -> Result<ProviderResponse, AppError> {
    let text = response
        .get("output_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let mut tool_calls = Vec::new();
    if let Some(output) = response.get("output").and_then(Value::as_array) {
        for item in output {
            if item.get("type").and_then(Value::as_str) != Some("function_call") {
                continue;
            }
            let Some(id) = item.get("call_id").and_then(Value::as_str) else {
                continue;
            };
            let Some(name) = item.get("name").and_then(Value::as_str) else {
                continue;
            };
            let arguments = item
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            tool_calls.push(ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments: parse_tool_arguments(arguments),
            });
        }
    }
    if text.is_empty() && tool_calls.is_empty() {
        return Err(AppError::provider_request_failed(
            "OpenAI returned an empty response",
        ));
    }
    let usage = response.get("usage").map(|usage_value| ProviderUsage {
        input_tokens: usage_value.get("input_tokens").and_then(Value::as_u64),
        output_tokens: usage_value.get("output_tokens").and_then(Value::as_u64),
        total_tokens: usage_value.get("total_tokens").and_then(Value::as_u64),
    });
    Ok(ProviderResponse {
        text,
        tool_calls,
        provider_response_id: response
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        usage,
    })
}

fn map_input_items(message: &ChatMessage) -> Vec<Value> {
    if message.role == "tool" {
        return vec![json!({
            "type": "function_call_output",
            "call_id": message.tool_call_id.clone().unwrap_or_default(),
            "output": message.content,
        })];
    }
    let mut items = Vec::new();
    if !message.content.is_empty() {
        items.push(json!({
            "role": message.role,
            "content": message.content,
        }));
    }
    if message.role == "assistant" {
        for tool_call in &message.tool_calls {
            items.push(json!({
                "type": "function_call",
                "call_id": tool_call.id,
                "name": tool_call.name,
                "arguments": serde_json::to_string(&tool_call.arguments).unwrap_or_else(|_| "{}".into()),
            }));
        }
    }
    items
}
