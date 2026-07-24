use tokio::sync::mpsc::UnboundedSender;

use crate::{
    error::AppError,
    models::{ChatMessage, ProviderResponse, RuntimeProvider},
    tools::ToolDefinition,
};

pub mod anthropic;
pub mod gemini;
pub mod openai_compatible;
pub mod openai_responses;
pub mod util;

pub async fn generate(
    provider: &RuntimeProvider,
    model: &str,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    on_text_delta: Option<UnboundedSender<String>>,
) -> Result<ProviderResponse, AppError> {
    match provider.kind.as_str() {
        "openai_compatible" => {
            openai_compatible::stream_chat_completion(
                provider,
                model,
                system_prompt,
                messages,
                tools,
                on_text_delta,
            )
            .await
        }
        "openai" => {
            openai_responses::stream_responses(
                provider,
                model,
                system_prompt,
                messages,
                tools,
                on_text_delta,
            )
            .await
        }
        "anthropic" => {
            anthropic::stream_messages(
                provider,
                model,
                system_prompt,
                messages,
                tools,
                on_text_delta,
            )
            .await
        }
        "gemini" => {
            gemini::stream_generate_content(
                provider,
                model,
                system_prompt,
                messages,
                tools,
                on_text_delta,
            )
            .await
        }
        other => Err(AppError::provider_request_failed(format!(
            "Provider kind '{other}' is not supported by the Rust agent runtime"
        ))),
    }
}
