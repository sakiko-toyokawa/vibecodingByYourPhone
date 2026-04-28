use rand::Rng;
use std::fs;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};

use crate::{bundle, config};

pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub desktop_token: Mutex<Option<String>>,
    /// The port the server is actually running on (auto-picked or user-specified).
    pub port: Mutex<Option<u16>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            desktop_token: Mutex::new(None),
            port: Mutex::new(None),
        }
    }

    /// Synchronously kill the server process and its entire process group.
    /// Called during app exit when the async runtime may not be available.
    pub fn kill_sync(&self) {
        if let Ok(mut lock) = self.child.lock() {
            if let Some(ref mut child) = *lock {
                #[cfg(unix)]
                if let Some(pid) = child.id() {
                    unsafe {
                        // Kill the entire process group (negative PID = PGID).
                        // Works because we set process_group(0) on spawn.
                        libc::kill(-(pid as i32), libc::SIGTERM);
                    }
                }
                #[cfg(not(unix))]
                {
                    let _ = child.start_kill();
                }
            }
            *lock = None;
        }
    }
}

/// Generate a 32-byte random hex token for desktop auth.
fn generate_token() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 32] = rng.gen();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Resolve the bundled Bun sidecar binary path.
/// Tauri places externalBin sidecars next to the main executable (Contents/MacOS/).
fn bun_path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Could not resolve executable: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "Could not resolve executable directory".to_string())?;
    let bin_name = if cfg!(windows) { "bun.exe" } else { "bun" };
    let path = exe_dir.join(bin_name);
    if path.exists() {
        return Ok(path);
    }
    Err(format!("Bun sidecar not found at {}", path.display()))
}

/// Resolve the Node.js runtime path.
/// On Windows, checks common installation paths in addition to PATH because
/// GUI apps often don't see PATH changes until logout/login.
fn node_path() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    {
        config::find_node_windows()
    }
    #[cfg(not(windows))]
    {
        config::which_in_path("node")
    }
}

/// Find the yep server entry point.
fn server_entry() -> Result<std::path::PathBuf, String> {
    let installed = config::data_dir()
        .join("node_modules")
        .join("yepanywhere")
        .join("dist")
        .join("index.js");
    if installed.exists() {
        return Ok(installed);
    }

    Err("Yep Anywhere server not found. Run setup first.".to_string())
}

/// Set up child process for clean shutdown: kill-on-drop and own process group.
fn setup_child_process(cmd: &mut Command, hide_window: bool) {
    cmd.kill_on_drop(true);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    #[cfg(windows)]
    {
        if hide_window {
            use std::os::windows::process::CommandExt;

            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.as_std_mut().creation_flags(CREATE_NO_WINDOW);
        }
    }
}

#[tauri::command]
pub async fn start_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();

    {
        let child_lock = state.child.lock().map_err(|e| e.to_string())?;
        if child_lock.is_some() {
            return Err("Server is already running".to_string());
        }
    }

    let cfg = config::load_config();
    let data_dir = config::data_dir();
    let token = generate_token();

    // Let the server pick its own port to avoid race conditions.
    // When port is not user-specified, pass PORT=0 and PORT_FILE so the
    // server writes the actual bound port to a file we can read back.
    let port_file = data_dir.join("server-port.txt");
    let _ = fs::remove_file(&port_file);

    // Remove stray package.json/bun.lock in data dir root so Bun does not treat
    // the data directory as a project root (which breaks module resolution).
    let _ = fs::remove_file(data_dir.join("package.json"));
    let _ = fs::remove_file(data_dir.join("bun.lock"));

    // Always copy from bundled resources to ensure the server package is up-to-date.
    // (The old "if not exists" logic caused stale npm-installed packages to persist.)
    let server_pkg = data_dir.join("node_modules").join("yepanywhere");
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("yepanywhere-server");
        if bundled.exists() {
            // Remove old server package first; failure here can leave a partially
            // written directory that breaks subsequent copy_dir_all.
            if server_pkg.exists() {
                if let Err(e) = fs::remove_dir_all(&server_pkg) {
                    return Err(format!(
                        "Failed to remove old server package at {}: {e}",
                        server_pkg.display()
                    ));
                }
            }
            if let Err(e) = config::copy_dir_all(&bundled, &server_pkg) {
                return Err(format!(
                    "Failed to copy bundled server from {} to {}: {e}",
                    bundled.display(),
                    server_pkg.display()
                ));
            }
            if let Err(e) = bundle::validate_server_package_dir(&server_pkg) {
                return Err(format!(
                    "Bundled server copied from {} is incomplete: {e}",
                    bundled.display()
                ));
            }
            eprintln!("[Desktop] Copied bundled server from resources");
        }
    }

    // Ensure dependencies are installed. Skip bun install when bundled server already
    // includes node_modules to avoid version drift (bundled has no lockfile, so
    // bun install may resolve newer incompatible versions).
    let tmp_dir = data_dir.join("tmp");
    let _ = fs::create_dir_all(&tmp_dir);
    let has_core_deps = bundle::has_required_runtime_dependencies(&server_pkg);

    if has_core_deps {
        eprintln!("[Desktop] Bundled server includes node_modules, skipping bun install");
    } else {
        eprintln!("[Desktop] Bundled server missing dependencies, running bun install...");
        if let Ok(bun) = bun_path(&app) {
            let mut install_cmd = Command::new(&bun);
            install_cmd
                .arg("install")
                .current_dir(&server_pkg)
                .env("TMP", tmp_dir.to_string_lossy().as_ref())
                .env("TEMP", tmp_dir.to_string_lossy().as_ref())
                .env("BUN_TMPDIR", tmp_dir.to_string_lossy().as_ref());
            match install_cmd.status().await {
                Ok(status) if status.success() => {
                    eprintln!("[Desktop] Dependencies installed");
                }
                Ok(status) => {
                    eprintln!("[Desktop] Dependency install exited with code: {status:?}");
                }
                Err(e) => {
                    eprintln!("[Desktop] Failed to install dependencies: {e}");
                }
            }
        }
    }

    bundle::validate_server_package_dir(&server_pkg).map_err(|e| {
        format!(
            "Yep Anywhere server package is incomplete at {}: {e}",
            server_pkg.display()
        )
    })?;

    // Create log directory for server stdout/stderr capture.
    let log_dir = data_dir.join("logs");
    let _ = fs::create_dir_all(&log_dir);
    let stdout_path = log_dir.join("server-stdout.log");
    let stderr_path = log_dir.join("server-stderr.log");

    let mut child = if let Some(dev_dir) = config::dev_dir() {
        // Dev mode: run `pnpm dev` from local source.
        // Use a login shell so pnpm/node are on PATH (GUI apps have minimal PATH).
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let mut cmd = Command::new(&shell);
        let dev_tmp_dir = data_dir.join("tmp");
        let _ = fs::create_dir_all(&dev_tmp_dir);
        cmd.args(["--login", "-c", "exec pnpm dev"])
            .current_dir(&dev_dir)
            .env("PORT", cfg.port.map_or("0".to_string(), |p| p.to_string()))
            .env("HOST", "127.0.0.1")
            .env("PORT_FILE", port_file.to_string_lossy().as_ref())
            .env("YEP_ANYWHERE_DATA_DIR", data_dir.to_string_lossy().as_ref())
            .env("DESKTOP_AUTH_TOKEN", &token)
            .env("TMP", dev_tmp_dir.to_string_lossy().as_ref())
            .env("TEMP", dev_tmp_dir.to_string_lossy().as_ref())
            .env("BUN_TMPDIR", dev_tmp_dir.to_string_lossy().as_ref());
        setup_child_process(&mut cmd, false);
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        cmd.spawn()
            .map_err(|e| format!("Failed to start dev server in {}: {e}", dev_dir.display()))?
    } else {
        // Production mode: use system Node.js when available (avoids Bun 1.2.x
        // Windows readline/child_process internal bugs).
        // On Windows we refuse to fall back to Bun because the readline crash is
        // unavoidable; show a clear error so the user knows to install Node.js.
        let entry = server_entry()?;
        let (runtime, runtime_name) = if let Some(node) = node_path() {
            (node, "Node.js")
        } else if cfg!(windows) {
            return Err(
                "Node.js is required on Windows.\n\n"
                    .to_string()
                    + "Please install Node.js from https://nodejs.org/ and restart the app.\n"
                    + "(If you already installed it, log out and log back in so the PATH update takes effect.)",
            );
        } else {
            (bun_path(&app)?, "Bun")
        };
        eprintln!("[Desktop] Starting server with {runtime_name}, entry: {}", entry.display());
        eprintln!("[Desktop] Data dir: {}", data_dir.display());
        let mut cmd = Command::new(&runtime);
        cmd.arg(&entry)
            .current_dir(&server_pkg)
            .env("NODE_ENV", "production")
            .env("PORT", cfg.port.map_or("0".to_string(), |p| p.to_string()))
            .env("HOST", "127.0.0.1")
            .env("PORT_FILE", port_file.to_string_lossy().as_ref())
            .env("YEP_ANYWHERE_DATA_DIR", data_dir.to_string_lossy().as_ref())
            .env("DESKTOP_AUTH_TOKEN", &token)
            .env("TMP", tmp_dir.to_string_lossy().as_ref())
            .env("TEMP", tmp_dir.to_string_lossy().as_ref());
        // Only set BUN_TMPDIR when actually using Bun
        if runtime_name == "Bun" {
            cmd.env("BUN_TMPDIR", tmp_dir.to_string_lossy().as_ref());
        }
        setup_child_process(&mut cmd, runtime_name == "Node.js");
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        cmd.spawn()
            .map_err(|e| format!("Failed to start server: {e}"))?
    };

    // Give the process a moment to start; if it exits immediately, capture stderr.
    tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
    match child.try_wait() {
        Ok(Some(status)) => {
            // Try to capture any stderr output before the process exited.
            let mut stderr_msg = String::new();
            if let Some(mut stderr) = child.stderr.take() {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                if !buf.is_empty() {
                    stderr_msg = format!(" stderr: {}", String::from_utf8_lossy(&buf));
                }
            }
            return Err(format!(
                "Server process exited immediately (code: {:?}).{}",
                status.code(),
                stderr_msg
            ));
        }
        Ok(None) => {}
        Err(e) => {
            return Err(format!("Failed to check server process status: {e}"));
        }
    }

    // Determine the actual port the server bound to.
    let port = if let Some(user_port) = cfg.port {
        user_port
    } else {
        let mut waited = 0u64;
        let max_wait = 5000u64;
        let interval = 100u64;
        let port_str = loop {
            if waited >= max_wait {
                return Err("Server did not write its port file in time".to_string());
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(interval)).await;
            waited += interval;
            match fs::read_to_string(&port_file) {
                Ok(s) if s.trim().is_empty() => continue,
                Ok(s) => break s,
                Err(_) => continue,
            }
        };
        let _ = fs::remove_file(&port_file);
        port_str.trim().parse::<u16>().map_err(|e| {
            format!("Server wrote invalid port: {e}")
        })?
    };

    // Spawn a background task to stream stdout/stderr to log files.
    // Take stdout/stderr before storing child in mutex to avoid partial move.
    let stdout_opt = child.stdout.take();
    let stderr_opt = child.stderr.take();
    let stdout_file = fs::File::create(&stdout_path).ok();
    let stderr_file = fs::File::create(&stderr_path).ok();
    if stdout_file.is_some() || stderr_file.is_some() {
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            if let (Some(mut stdout), Some(file)) = (stdout_opt, stdout_file) {
                let mut file = tokio::fs::File::from_std(file);
                let mut buf = [0u8; 4096];
                loop {
                    match stdout.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = file.write_all(&buf[..n]).await;
                            let _ = file.flush().await;
                        }
                        Err(_) => break,
                    }
                }
            }
            if let (Some(mut stderr), Some(file)) = (stderr_opt, stderr_file) {
                let mut file = tokio::fs::File::from_std(file);
                let mut buf = [0u8; 4096];
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            let _ = file.write_all(&buf[..n]).await;
                            let _ = file.flush().await;
                        }
                        Err(_) => break,
                    }
                }
            }
        });
    }

    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
    *child_lock = Some(child);

    let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
    *token_lock = Some(token);

    let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
    *port_lock = Some(port);

    Ok(())
}

#[tauri::command]
pub async fn stop_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();

    // Take the child out of the mutex so we don't hold the lock across .await
    let child = {
        let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
        child_lock.take()
    };

    // Clear the desktop token and port
    {
        let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
        *token_lock = None;
    }
    {
        let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }

    if let Some(mut child) = child {
        child.kill().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_server_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<ServerState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    match child_lock.as_mut() {
        None => Ok("stopped".to_string()),
        Some(child) => match child.try_wait() {
            Ok(Some(_status)) => {
                *child_lock = None;
                Ok("stopped".to_string())
            }
            Ok(None) => Ok("running".to_string()),
            Err(e) => Err(e.to_string()),
        },
    }
}

#[tauri::command]
pub async fn get_desktop_token(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<ServerState>();
    let token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
    Ok(token_lock.clone())
}

#[tauri::command]
pub async fn get_server_port(app: AppHandle) -> Result<Option<u16>, String> {
    let state = app.state::<ServerState>();
    let port_lock = state.port.lock().map_err(|e| e.to_string())?;
    Ok(*port_lock)
}
