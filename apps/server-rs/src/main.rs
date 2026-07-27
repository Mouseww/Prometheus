use prometheus_server::{AppState, Config, build_router};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    // 安全校验必须在 bind 之前：一个非 loopback 且无 token 的控制平面，
    // 哪怕只监听一瞬间，也等同于把工作区与 shell 暴露在网络上。
    config.validate_security()?;

    let address = config.bind_address();
    let workspace = config.workspace_root().display().to_string();
    let runtime_file = config.runtime_file().display().to_string();
    let terminal_mode = config.terminal_mode().as_str();
    let auth_required = config.access_token().is_some();
    let warning = config.security_warning();

    let listener = tokio::net::TcpListener::bind(address).await?;
    let state = AppState::open(config).await?;
    println!("Prometheus Rust compatibility control plane listening on http://{address}");
    println!("Workspace root: {workspace}");
    println!("Runtime settings: {runtime_file}");
    println!("Terminal mode: {terminal_mode}");
    println!(
        "Authentication: {}",
        if auth_required {
            "token required"
        } else {
            "disabled (loopback only)"
        }
    );
    if let Some(warning) = warning {
        eprintln!("WARNING: {warning}");
    }
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
