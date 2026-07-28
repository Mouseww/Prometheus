use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use prometheus_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::tempdir;
use tower::ServiceExt;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn extension_stores_are_connected_by_default_and_support_install() {
    let workspace = tempdir().expect("workspace");
    let config = Config::new(workspace.path())
        .expect("config")
        .with_data_file(workspace.path().join("runtime.db"))
        .with_master_key([61_u8; 32]);
    let app = build_router(AppState::open(config).await.expect("state"));

    let stores_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/extension-stores")
                .body(Body::empty())
                .expect("stores req"),
        )
        .await
        .expect("stores resp");
    assert_eq!(stores_response.status(), StatusCode::OK);
    let stores_body: Value = serde_json::from_slice(
        &to_bytes(stores_response.into_body(), 1024 * 1024)
            .await
            .expect("stores body"),
    )
    .expect("stores json");
    let stores = stores_body["stores"].as_array().expect("stores array");
    assert!(stores.iter().any(|store| {
        store["id"] == "open-skills" && store["defaultConnected"] == true && store["kind"] == "skills"
    }));
    assert!(stores.iter().any(|store| {
        store["id"] == "open-mcp" && store["defaultConnected"] == true && store["kind"] == "mcp"
    }));

    let skill_catalog_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/extension-stores/open-skills/catalog")
                .body(Body::empty())
                .expect("skill catalog req"),
        )
        .await
        .expect("skill catalog resp");
    assert_eq!(skill_catalog_response.status(), StatusCode::OK);
    let skill_catalog: Value = serde_json::from_slice(
        &to_bytes(skill_catalog_response.into_body(), 1024 * 1024)
            .await
            .expect("skill catalog body"),
    )
    .expect("skill catalog json");
    let skill_entries = skill_catalog["entries"].as_array().expect("skill entries");
    assert!(skill_entries.len() >= 2);
    assert!(
        skill_entries
            .iter()
            .any(|entry| entry["id"] == "prometheus-pr-review" && entry["installed"] == false)
    );

    let install_skill_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/extension-stores/open-skills/install")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "entryId": "prometheus-pr-review" }).to_string(),
                ))
                .expect("install skill req"),
        )
        .await
        .expect("install skill resp");
    let install_skill_status = install_skill_response.status();
    let install_skill_body: Value = serde_json::from_slice(
        &to_bytes(install_skill_response.into_body(), 1024 * 1024)
            .await
            .expect("install skill body"),
    )
    .expect("install skill json");
    assert_eq!(
        install_skill_status,
        StatusCode::CREATED,
        "{install_skill_body}"
    );
    assert_eq!(install_skill_body["result"]["kind"], "skill");
    assert_eq!(
        install_skill_body["result"]["skill"]["id"],
        "prometheus-pr-review"
    );
    assert!(
        workspace
            .path()
            .join(".prometheus")
            .join("skills")
            .join("prometheus-pr-review")
            .join("SKILL.md")
            .is_file()
    );

    let skills_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/skills")
                .body(Body::empty())
                .expect("skills req"),
        )
        .await
        .expect("skills resp");
    let skills_body: Value = serde_json::from_slice(
        &to_bytes(skills_response.into_body(), 1024 * 1024)
            .await
            .expect("skills body"),
    )
    .expect("skills json");
    assert!(
        skills_body["skills"]
            .as_array()
            .expect("skills")
            .iter()
            .any(|skill| skill["id"] == "prometheus-pr-review")
    );

    let mcp_catalog_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/extension-stores/open-mcp/catalog?q=memory")
                .body(Body::empty())
                .expect("mcp catalog req"),
        )
        .await
        .expect("mcp catalog resp");
    assert_eq!(mcp_catalog_response.status(), StatusCode::OK);
    let mcp_catalog: Value = serde_json::from_slice(
        &to_bytes(mcp_catalog_response.into_body(), 1024 * 1024)
            .await
            .expect("mcp catalog body"),
    )
    .expect("mcp catalog json");
    let mcp_entries = mcp_catalog["entries"].as_array().expect("mcp entries");
    assert_eq!(mcp_entries.len(), 1);
    assert_eq!(mcp_entries[0]["id"], "mcp-memory");
    assert_eq!(mcp_entries[0]["installed"], false);

    let install_mcp_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/extension-stores/open-mcp/install")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "entryId": "mcp-memory" }).to_string()))
                .expect("install mcp req"),
        )
        .await
        .expect("install mcp resp");
    let install_mcp_status = install_mcp_response.status();
    let install_mcp_body: Value = serde_json::from_slice(
        &to_bytes(install_mcp_response.into_body(), 1024 * 1024)
            .await
            .expect("install mcp body"),
    )
    .expect("install mcp json");
    assert_eq!(install_mcp_status, StatusCode::CREATED, "{install_mcp_body}");
    assert_eq!(install_mcp_body["result"]["kind"], "mcp");
    assert_eq!(install_mcp_body["result"]["server"]["name"], "memory");
    assert_eq!(install_mcp_body["result"]["server"]["command"], "npx");
    assert_eq!(install_mcp_body["result"]["server"]["enabled"], true);

    let missing_env_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/extension-stores/open-mcp/install")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "entryId": "mcp-brave-search" }).to_string(),
                ))
                .expect("missing env req"),
        )
        .await
        .expect("missing env resp");
    assert_eq!(missing_env_response.status(), StatusCode::BAD_REQUEST);

    let install_brave_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/extension-stores/open-mcp/install")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "entryId": "mcp-brave-search",
                        "env": { "BRAVE_API_KEY": "test-key" },
                        "enabled": true
                    })
                    .to_string(),
                ))
                .expect("brave req"),
        )
        .await
        .expect("brave resp");
    let install_brave_status = install_brave_response.status();
    let install_brave_body: Value = serde_json::from_slice(
        &to_bytes(install_brave_response.into_body(), 1024 * 1024)
            .await
            .expect("brave body"),
    )
    .expect("brave json");
    assert_eq!(
        install_brave_status,
        StatusCode::CREATED,
        "{install_brave_body}"
    );
    assert_eq!(install_brave_body["result"]["server"]["name"], "brave-search");
    assert_eq!(install_brave_body["result"]["server"]["enabled"], true);

    let health_response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .expect("health req"),
        )
        .await
        .expect("health resp");
    let health_body: Value = serde_json::from_slice(
        &to_bytes(health_response.into_body(), 1024 * 1024)
            .await
            .expect("health body"),
    )
    .expect("health json");
    assert!(
        health_body["capabilities"]
            .as_array()
            .expect("capabilities")
            .iter()
            .any(|value| value == "extension-store")
    );
}
