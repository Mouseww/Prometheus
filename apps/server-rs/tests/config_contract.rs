use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use prometheus_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;
use uuid::Uuid;

#[tokio::test]
async fn configuration_persistence_contract() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("config.db"))
        .with_master_key([9_u8; 32]);
    let app = build_router(AppState::open(config.clone()).await.expect("state"));

    let provider_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/providers")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Local OpenAI",
                        "kind": "openai_compatible",
                        "baseUrl": "https://api.example.com/v1",
                        "defaultModel": "gpt-test",
                        "apiKey": "sk-secret"
                    })
                    .to_string(),
                ))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(provider_response.status(), StatusCode::CREATED);
    let provider_body: Value = serde_json::from_slice(
        &to_bytes(provider_response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    let provider_id = provider_body["provider"]["id"].as_str().unwrap().to_owned();
    assert_eq!(provider_body["provider"]["hasApiKey"], true);
    assert!(provider_body["provider"].get("apiKey").is_none());

    let missing_agent = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Coder",
                        "systemPrompt": "You write code",
                        "providerId": Uuid::new_v4().to_string(),
                        "model": "gpt-test"
                    })
                    .to_string(),
                ))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(missing_agent.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let missing_body: Value = serde_json::from_slice(
        &to_bytes(missing_agent.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(missing_body["error"], "configuration_reference_not_found");

    let agent_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/agents")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Coder",
                        "description": "writes",
                        "systemPrompt": "You write code",
                        "providerId": provider_id,
                        "model": "gpt-test"
                    })
                    .to_string(),
                ))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(agent_response.status(), StatusCode::CREATED);

    let rule_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/permission-rules")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "toolName": "shell",
                        "effect": "ask",
                        "pattern": "*"
                    })
                    .to_string(),
                ))
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(rule_response.status(), StatusCode::CREATED);
    let rule_body: Value = serde_json::from_slice(
        &to_bytes(rule_response.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    let rule_id = rule_body["rule"]["id"].as_str().unwrap().to_owned();

    let reopened = build_router(AppState::open(config).await.expect("reopen"));
    let list_providers = reopened
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/providers")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    let providers: Value = serde_json::from_slice(
        &to_bytes(list_providers.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(providers["providers"].as_array().unwrap().len(), 1);
    assert_eq!(providers["providers"][0]["id"], provider_id);

    let list_rules = reopened
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/permission-rules")
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    let rules: Value = serde_json::from_slice(
        &to_bytes(list_rules.into_body(), 64 * 1024)
            .await
            .expect("body"),
    )
    .expect("json");
    assert_eq!(rules["rules"][0]["effect"], "ask");

    let delete = reopened
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/permission-rules/{rule_id}"))
                .body(Body::empty())
                .expect("req"),
        )
        .await
        .expect("resp");
    assert_eq!(delete.status(), StatusCode::NO_CONTENT);
}

#[test]
fn secret_vault_roundtrip_unit() {
    let vault = prometheus_server::secret_vault::SecretVault::new(&[3_u8; 32]).expect("vault");
    let envelope = vault.encrypt("hello-key").expect("encrypt");
    assert!(envelope.starts_with("v1:"));
    assert_eq!(vault.decrypt(&envelope).expect("decrypt"), "hello-key");
}
