use prometheus_server::{AppState, Config, build_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let address = config.bind_address();
    let workspace = config.workspace_root().display().to_string();
    let listener = tokio::net::TcpListener::bind(address).await?;
    let state = AppState::open(config).await?;
    println!("Prometheus Rust compatibility control plane listening on http://{address}");
    println!("Workspace root: {workspace}");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
