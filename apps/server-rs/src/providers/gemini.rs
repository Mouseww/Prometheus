use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::{
    error::AppError,
    models::{ChatMessage, ProviderResponse, ProviderUsage, RuntimeProvider},
    providers::util::{http_error},
    tools::{ToolCall, ToolDefinition},
};

pub async fn stream_generate_content(
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
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_owned());
    let url = format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        base_url.trim_end_matches('/'),
        model
    );

    let mut body = json!({
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": messages.iter().map(map_message).collect::<Vec<_>>(),
    });
    if !tools.is_empty() {
        body["tools"] = json!([{
            "functionDeclarations": tools.iter().map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                })
            }).collect::<Vec<_>>()
        }]);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| AppError::provider_request_failed(error.to_string()))?;

    let response = client
        .post(url)
        .header("x-goog-api-key", &provider.api_key)
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
    let mut tool_calls: BTreeMap<String, ToolCall> = BTreeMap::new();
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
                AppError::provider_request_failed(format!("Invalid Gemini SSE payload: {error}"))
            })?;
            if let Some(id) = payload
                .get("responseId")
                .or_else(|| payload.get("response_id"))
                .and_then(Value::as_str)
            {
                provider_response_id = Some(id.to_owned());
            }
            if let Some(meta) = payload.get("usageMetadata") {
                usage = Some(ProviderUsage {
                    input_tokens: meta.get("promptTokenCount").and_then(Value::as_u64),
                    output_tokens: meta.get("candidatesTokenCount").and_then(Value::as_u64),
                    total_tokens: meta.get("totalTokenCount").and_then(Value::as_u64),
                });
            }
            let Some(candidates) = payload.get("candidates").and_then(Value::as_array) else {
                continue;
            };
            for candidate in candidates {
                let Some(parts) = candidate
                    .pointer("/content/parts")
                    .and_then(Value::as_array)
                else {
                    continue;
                };
                for part in parts {
                    if let Some(piece) = part.get("text").and_then(Value::as_str) {
                        text.push_str(piece);
                        if let Some(sender) = on_text_delta.as_ref() {
                            let _ = sender.send(piece.to_owned());
                        }
                    }
                    if let Some(call) = part.get("functionCall") {
                        let name = call
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        if name.is_empty() {
                            continue;
                        }
                        let id = call
                            .get("id")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .filter(|value| !value.is_empty())
                            .unwrap_or_else(|| Uuid::new_v4().to_string());
                        let args = call
                            .get("args")
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        tool_calls.insert(
                            id.clone(),
                            ToolCall {
                                id,
                                name,
                                arguments: args,
                            },
                        );
                    }
                }
            }
        }
    }

    let text = text.trim().to_owned();
    let tool_calls = tool_calls.into_values().collect::<Vec<_>>();
    if text.is_empty() && tool_calls.is_empty() {
        return Err(AppError::provider_request_failed(
            "Gemini returned an empty response",
        ));
    }

    Ok(ProviderResponse {
        text,
        tool_calls,
        provider_response_id,
        usage,
    })
}

fn map_message(message: &ChatMessage) -> Value {
    if message.role == "tool" {
        return json!({
            "role": "user",
            "parts": [{
                "functionResponse": {
                    "id": message.tool_call_id.clone().unwrap_or_default(),
                    "name": message.tool_name.clone().unwrap_or_default(),
                    "response": {
                        "output": message.content,
                        "isError": message.is_error,
                    }
                }
            }]
        });
    }
    if message.role == "assistant" && !message.tool_calls.is_empty() {
        let mut parts = Vec::new();
        if !message.content.is_empty() {
            parts.push(json!({ "text": message.content }));
        }
        for tool_call in &message.tool_calls {
            parts.push(json!({
                "functionCall": {
                    "id": tool_call.id,
                    "name": tool_call.name,
                    "args": tool_call.arguments,
                }
            }));
        }
        return json!({
            "role": "model",
            "parts": parts,
        });
    }
    json!({
        "role": if message.role == "assistant" { "model" } else { "user" },
        "parts": [{ "text": message.content }],
    })
}
