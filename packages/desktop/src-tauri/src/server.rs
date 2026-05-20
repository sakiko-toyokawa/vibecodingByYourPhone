use rand::Rng;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::{Child, Command};

use crate::{bundle, config};

const DESKTOP_SERVER_RESTART_STARTED_EVENT: &str = "desktop://server-restart-started";
const DESKTOP_SERVER_RESTART_FINISHED_EVENT: &str = "desktop://server-restart-finished";

pub struct ServerState {
    pub child: Mutex<Option<Child>>,
    pub starting: Mutex<bool>,
    pub start_epoch: Mutex<u64>,
    pub desktop_token: Mutex<Option<String>>,
    /// The port the server is actually running on (auto-picked or user-specified).
    pub port: Mutex<Option<u16>>,
    pub last_error: Mutex<Option<String>>,
    /// Last known PID of the server child process. Used as a fallback by
    /// kill_sync when the Child handle has already been taken (e.g. after
    /// stop_server timed out) so we can still force-terminate the orphan.
    pub last_pid: Mutex<Option<u32>>,
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
            starting: Mutex::new(false),
            start_epoch: Mutex::new(0),
            desktop_token: Mutex::new(None),
            port: Mutex::new(None),
            last_error: Mutex::new(None),
            last_pid: Mutex::new(None),
        }
    }

    /// Synchronously kill the server process and its entire process group.
    /// Called during app exit when the async runtime may not be available.
    pub fn kill_sync(&self) {
        // 1. Try to terminate via the active Child handle.
        let mut child_handle_existed = false;
        if let Ok(mut lock) = self.child.lock() {
            if let Some(ref mut child) = *lock {
                child_handle_existed = true;
                eprintln!("[Desktop] kill_sync: terminating server process");
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
                    if let Some(pid) = child.id() {
                        let status = std::process::Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/T", "/F"])
                            .status();
                        match status {
                            Ok(status) => {
                                eprintln!("[Desktop] kill_sync: taskkill exited with {status}");
                            }
                            Err(err) => {
                                eprintln!("[Desktop] kill_sync: taskkill failed: {err}");
                                let _ = child.start_kill();
                            }
                        }
                    } else {
                        let _ = child.start_kill();
                    }
                }
            }
            *lock = None;
        } else {
            // Could not acquire child lock — the async runtime may have poisoned it.
            // Fall back to last_pid below.
            eprintln!("[Desktop] kill_sync: child lock poisoned, will fallback to last_pid");
        }

        // 2. Fallback: if the Child handle was already taken (e.g. by stop_server
        // which then timed out), use the last known PID to force-kill the orphan.
        #[cfg(not(unix))]
        if !child_handle_existed {
            if let Ok(lock) = self.last_pid.lock() {
                if let Some(pid) = *lock {
                    eprintln!("[Desktop] kill_sync: child handle gone, force-killing orphan PID {pid}");
                    let _ = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
                }
            }
        }

        // Reset all runtime flags so the next app launch starts fresh.
        if let Ok(mut lock) = self.starting.lock() {
            *lock = false;
        }
        if let Ok(mut lock) = self.start_epoch.lock() {
            *lock = lock.saturating_add(1);
        }
        if let Ok(mut lock) = self.desktop_token.lock() {
            *lock = None;
        }
        if let Ok(mut lock) = self.port.lock() {
            *lock = None;
        }
        if let Ok(mut lock) = self.last_error.lock() {
            *lock = None;
        }
        if let Ok(mut lock) = self.last_pid.lock() {
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

fn bundled_server_root(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Could not resolve app resource directory: {e}"))?;
    let bundled = resource_dir.join("yepanywhere-server");
    if bundled.exists() {
        return Ok(bundled);
    }
    Err(format!(
        "Bundled Yep Anywhere server not found at {}",
        bundled.display()
    ))
}

fn legacy_server_root(data_dir: &Path) -> PathBuf {
    data_dir.join("node_modules").join("yepanywhere")
}

fn deployed_server_root(data_dir: &Path, hash: &str) -> PathBuf {
    data_dir.join("server-bundles").join(hash)
}

fn deployed_server_entry(server_pkg: &Path) -> Result<PathBuf, String> {
    let entry = server_pkg.join("dist").join("index.js");
    if entry.exists() {
        return Ok(entry);
    }

    Err(format!(
        "Yep Anywhere server entry not found at {}. Run setup again.",
        entry.display()
    ))
}

fn is_file_name_ignored_for_hash(name: &str) -> bool {
    matches!(
        name,
        ".DS_Store" | "Thumbs.db" | "server-stdout.log" | "server-stderr.log"
    )
}

fn collect_paths_sorted(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut entries = Vec::new();

    fn walk(root: &Path, current: &Path, entries: &mut Vec<PathBuf>) -> Result<(), String> {
        for entry in fs::read_dir(current).map_err(|e| format!("read_dir failed: {e}"))? {
            let entry = entry.map_err(|e| format!("entry failed: {e}"))?;
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if is_file_name_ignored_for_hash(&file_name) {
                continue;
            }

            let relative = path
                .strip_prefix(root)
                .map_err(|e| format!("strip_prefix failed: {e}"))?
                .to_path_buf();
            entries.push(relative.clone());

            if entry
                .file_type()
                .map_err(|e| format!("file_type failed: {e}"))?
                .is_dir()
            {
                walk(root, &path, entries)?;
            }
        }
        Ok(())
    }

    walk(root, root, &mut entries)?;
    entries.sort();
    Ok(entries)
}

fn hash_directory_contents(root: &Path) -> Result<String, String> {
    let start = std::time::Instant::now();
    let mut hasher = Sha256::new();
    let entries = collect_paths_sorted(root)?;
    let entry_count = entries.len();

    for relative in entries {
        let full_path = root.join(&relative);
        let normalized = relative.to_string_lossy().replace('\\', "/");
        hasher.update(normalized.as_bytes());

        let metadata = fs::metadata(&full_path).map_err(|e| {
            format!("metadata failed for {}: {e}", full_path.display())
        })?;
        if metadata.is_dir() {
            hasher.update(b"\0dir\0");
            continue;
        }

        hasher.update(b"\0file\0");
        let mut file = fs::File::open(&full_path)
            .map_err(|e| format!("open failed for {}: {e}", full_path.display()))?;
        let mut buf = [0u8; 8192];
        loop {
            let read = file
                .read(&mut buf)
                .map_err(|e| format!("read failed for {}: {e}", full_path.display()))?;
            if read == 0 {
                break;
            }
            hasher.update(&buf[..read]);
        }
    }

    let hash = format!("{:x}", hasher.finalize());
    eprintln!(
        "[Desktop] hash_directory_contents: {} entries hashed in {:?}",
        entry_count,
        start.elapsed()
    );
    Ok(hash)
}

fn unique_staging_dir(base_dir: &Path, hash: &str) -> PathBuf {
    let mut rng = rand::thread_rng();
    let suffix: u64 = rng.gen();
    base_dir.join(format!("{hash}.staging-{suffix:016x}"))
}

fn ensure_deployed_server_package(app: &AppHandle, data_dir: &Path) -> Result<PathBuf, String> {
    let bundled = match bundled_server_root(app) {
        Ok(path) => path,
        Err(bundle_error) => {
            let legacy = legacy_server_root(data_dir);
            if legacy.exists() {
                bundle::validate_server_package_dir(&legacy).map_err(|e| {
                    format!(
                        "{bundle_error}; legacy installed server at {} is incomplete: {e}",
                        legacy.display()
                    )
                })?;
                eprintln!(
                    "[Desktop] Falling back to legacy installed server package {}",
                    legacy.display()
                );
                return Ok(legacy);
            }
            return Err(bundle_error);
        }
    };
    let bundle_hash = hash_directory_contents(&bundled)?;
    let bundles_dir = data_dir.join("server-bundles");
    fs::create_dir_all(&bundles_dir).map_err(|e| {
        format!(
            "Failed to create server bundle directory {}: {e}",
            bundles_dir.display()
        )
    })?;

    let target_dir = deployed_server_root(data_dir, &bundle_hash);
    if target_dir.exists() {
        bundle::validate_server_package_dir(&target_dir).map_err(|e| {
            format!(
                "Existing bundled server package at {} is incomplete: {e}",
                target_dir.display()
            )
        })?;
        eprintln!(
            "[Desktop] Reusing bundled server package {}",
            target_dir.display()
        );
        return Ok(target_dir);
    }

    let staging_dir = unique_staging_dir(&bundles_dir, &bundle_hash);
    config::copy_dir_all(&bundled, &staging_dir).map_err(|e| {
        format!(
            "Failed to copy bundled server from {} to {}: {e}",
            bundled.display(),
            staging_dir.display()
        )
    })?;

    if let Err(err) = bundle::validate_server_package_dir(&staging_dir) {
        let _ = fs::remove_dir_all(&staging_dir);
        return Err(format!(
            "Bundled server copied from {} is incomplete: {err}",
            bundled.display()
        ));
    }

    match fs::rename(&staging_dir, &target_dir) {
        Ok(()) => {
            eprintln!(
                "[Desktop] Deployed bundled server package {}",
                target_dir.display()
            );
        }
        Err(err) if target_dir.exists() => {
            let _ = fs::remove_dir_all(&staging_dir);
            bundle::validate_server_package_dir(&target_dir).map_err(|e| {
                format!(
                    "Concurrent bundled server package at {} is incomplete: {e}",
                    target_dir.display()
                )
            })?;
            eprintln!(
                "[Desktop] Reusing concurrently deployed server package {} after rename failed: {}",
                target_dir.display(),
                err
            );
        }
        Err(err) => {
            let _ = fs::remove_dir_all(&staging_dir);
            return Err(format!(
                "Failed to finalize bundled server deploy at {}: {}",
                target_dir.display(),
                err
            ));
        }
    }

    Ok(target_dir)
}

fn cleanup_old_deployed_server_packages(active_dir: &Path, data_dir: &Path) {
    let bundles_dir = data_dir.join("server-bundles");
    let Ok(entries) = fs::read_dir(&bundles_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path == active_dir {
            continue;
        }
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.contains(".staging-"))
        {
            let _ = fs::remove_dir_all(&path);
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        if let Err(err) = fs::remove_dir_all(&path) {
            eprintln!(
                "[Desktop] Failed to remove old bundled server package {}: {}",
                path.display(),
                err
            );
        }
    }
}

fn emit_restart_event(app: &AppHandle, event: &str) {
    let _ = app.emit(event, ());
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

fn set_last_error(state: &ServerState, error: Option<String>) -> Result<(), String> {
    let mut lock = state.last_error.lock().map_err(|e| e.to_string())?;
    *lock = error;
    Ok(())
}

fn clear_runtime_state(state: &ServerState) -> Result<(), String> {
    {
        let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
        *token_lock = None;
    }
    {
        let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
        *port_lock = None;
    }
    Ok(())
}

fn current_start_epoch(state: &ServerState) -> Result<u64, String> {
    let lock = state.start_epoch.lock().map_err(|e| e.to_string())?;
    Ok(*lock)
}

fn is_start_epoch_active(state: &ServerState, expected_epoch: u64) -> Result<bool, String> {
    let current_epoch = current_start_epoch(state)?;
    let starting = *state.starting.lock().map_err(|e| e.to_string())?;
    Ok(starting && current_epoch == expected_epoch)
}

fn ensure_start_epoch_active(state: &ServerState, expected_epoch: u64) -> Result<(), String> {
    if is_start_epoch_active(state, expected_epoch)? {
        Ok(())
    } else {
        Err("Server startup cancelled".to_string())
    }
}

fn take_child(state: &ServerState) -> Result<Option<Child>, String> {
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
    Ok(child_lock.take())
}

async fn stop_child_process(mut child: Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        if let Some(pid) = child.id() {
            eprintln!("[Desktop] Stopping server process group {pid}");
            unsafe {
                libc::kill(-(pid as i32), libc::SIGTERM);
            }
        } else {
            eprintln!("[Desktop] Stopping server process without PID");
            child.start_kill().map_err(|e| e.to_string())?;
        }
    }

    #[cfg(windows)]
    {
        if let Some(pid) = child.id() {
            eprintln!("[Desktop] Stopping server process tree {pid} with taskkill");
            let status = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status()
                .await
                .map_err(|e| format!("Failed to run taskkill for PID {pid}: {e}"))?;
            eprintln!("[Desktop] taskkill for PID {pid} exited with {status}");
        } else {
            eprintln!("[Desktop] Stopping server process without PID");
            child.start_kill().map_err(|e| e.to_string())?;
        }
    }

    match tokio::time::timeout(tokio::time::Duration::from_secs(5), child.wait()).await {
        Ok(Ok(status)) => {
            eprintln!("[Desktop] Server process exited with {status}");
            Ok(())
        }
        Ok(Err(err)) => Err(format!("Failed while waiting for server exit: {err}")),
        Err(_) => Err("Timed out waiting for server process to exit".to_string()),
    }
}

async fn stop_child_if_running(mut child: Child) -> Result<(), String> {
    match child.try_wait() {
        Ok(Some(status)) => {
            eprintln!("[Desktop] Server process already exited with {status}");
            Ok(())
        }
        Ok(None) => stop_child_process(child).await,
        Err(err) => Err(format!(
            "Failed to inspect server process before cleanup: {err}"
        )),
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

    {
        let mut epoch_lock = state.start_epoch.lock().map_err(|e| e.to_string())?;
        let mut starting_lock = state.starting.lock().map_err(|e| e.to_string())?;
        if *starting_lock {
            return Err("Server start is already in progress".to_string());
        }
        *epoch_lock = epoch_lock.saturating_add(1);
        *starting_lock = true;
    }
    let start_epoch = current_start_epoch(&state)?;

    clear_runtime_state(&state)?;
    set_last_error(&state, None)?;

    let result = async {
        let cfg = config::load_config();
        let data_dir = config::data_dir();
        let token = generate_token();

        eprintln!(
            "[Desktop] start_server: preparing launch with data dir {}",
            data_dir.display()
        );

        // Let the server pick its own port to avoid race conditions.
        // When port is not user-specified, pass PORT=0 and PORT_FILE so the
        // server writes the actual bound port to a file we can read back.
        let port_file = data_dir.join("server-port.txt");
        let _ = fs::remove_file(&port_file);

        // Remove stray package.json/bun.lock in data dir root so Bun does not treat
        // the data directory as a project root (which breaks module resolution).
        let _ = fs::remove_file(data_dir.join("package.json"));
        let _ = fs::remove_file(data_dir.join("bun.lock"));

        let server_pkg = ensure_deployed_server_package(&app, &data_dir)?;

        ensure_start_epoch_active(&state, start_epoch)?;

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

        ensure_start_epoch_active(&state, start_epoch)?;

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
            cmd.spawn().map_err(|e| {
                format!("Failed to start dev server in {}: {e}", dev_dir.display())
            })?
        } else {
            // Production mode: use system Node.js when available (avoids Bun 1.2.x
            // Windows readline/child_process internal bugs).
            // On Windows we refuse to fall back to Bun because the readline crash is
            // unavoidable; show a clear error so the user knows to install Node.js.
            let entry = deployed_server_entry(&server_pkg)?;
            let (runtime, runtime_name) = if let Some(node) = node_path() {
                (node, "Node.js")
            } else if cfg!(windows) {
                return Err(
                    "Node.js is required on Windows.\n\n".to_string()
                        + "Please install Node.js from https://nodejs.org/ and restart the app.\n"
                        + "(If you already installed it, log out and log back in so the PATH update takes effect.)",
                );
            } else {
                (bun_path(&app)?, "Bun")
            };
            eprintln!(
                "[Desktop] Starting server with {runtime_name}, entry: {}",
                entry.display()
            );
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

        eprintln!(
            "[Desktop] start_server: spawned process with pid {:?}",
            child.id()
        );

        // Start streaming stdout/stderr to log files immediately so startup
        // failures (port-file timeout, immediate exit) still leave diagnostics
        // behind.
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

        let spawned_pid = child.id();
        {
            let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
            *child_lock = Some(child);
        }
        if let Some(pid) = spawned_pid {
            if let Ok(mut lock) = state.last_pid.lock() {
                *lock = Some(pid);
            }
        }

        ensure_start_epoch_active(&state, start_epoch)?;

        // Give the process a moment to start; if it exits immediately, capture stderr from the log file.
        tokio::time::sleep(tokio::time::Duration::from_millis(800)).await;
        ensure_start_epoch_active(&state, start_epoch)?;
        match {
            let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
            let child = child_lock
                .as_mut()
                .ok_or_else(|| "Server startup cancelled".to_string())?;
            child.try_wait()
        } {
            Ok(Some(status)) => {
                // stderr is being streamed to stderr_path by the background task above.
                // Brief sleep lets the streamer flush remaining bytes after the EOF.
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                let stderr_msg = match fs::read_to_string(&stderr_path) {
                    Ok(s) if !s.trim().is_empty() => format!(" stderr: {}", s),
                    _ => String::new(),
                };
                return Err(format!(
                    "Server process exited immediately (code: {:?}).{}",
                    status.code(),
                    stderr_msg
                ));
            }
            Ok(None) => {
                eprintln!("[Desktop] start_server: process still running after 800ms check");
            }
            Err(e) => {
                return Err(format!("Failed to check server process status: {e}"));
            }
        }

        // Determine the actual port the server bound to.
        let port = if let Some(user_port) = cfg.port {
            user_port
        } else {
            let mut waited = 0u64;
            // 60s tolerates cold-start + Defender scan on autostart.
            let max_wait = 60_000u64;
            let interval = 100u64;
            let port_str = loop {
                ensure_start_epoch_active(&state, start_epoch)?;
                if waited >= max_wait {
                    eprintln!("[Desktop] start_server: port_file wait timed out after {waited}ms");
                    return Err("Server did not write its port file in time".to_string());
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(interval)).await;
                waited += interval;
                if waited % 1000 == 0 {
                    eprintln!("[Desktop] start_server: still waiting for port_file ({waited}ms / {max_wait}ms)");
                }
                ensure_start_epoch_active(&state, start_epoch)?;
                match {
                    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;
                    let child = child_lock
                        .as_mut()
                        .ok_or_else(|| "Server startup cancelled".to_string())?;
                    child.try_wait()
                } {
                    Ok(Some(status)) => {
                        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
                        let stderr_msg = match fs::read_to_string(&stderr_path) {
                            Ok(s) if !s.trim().is_empty() => format!(" stderr: {}", s),
                            _ => String::new(),
                        };
                        return Err(format!(
                            "Server process exited before publishing its port (code: {:?}).{}",
                            status.code(),
                            stderr_msg
                        ));
                    }
                    Ok(None) => {}
                    Err(e) => {
                        return Err(format!(
                            "Failed to check server process status while waiting for port: {e}"
                        ));
                    }
                }
                match fs::read_to_string(&port_file) {
                    Ok(s) if s.trim().is_empty() => continue,
                    Ok(s) => {
                        eprintln!("[Desktop] start_server: port_file found after {waited}ms: {s}",);
                        break s;
                    }
                    Err(_) => continue,
                }
            };
            let _ = fs::remove_file(&port_file);
            port_str
                .trim()
                .parse::<u16>()
                .map_err(|e| format!("Server wrote invalid port: {e}"))?
        };

        eprintln!("[Desktop] start_server: server is listening on port {port}");

        ensure_start_epoch_active(&state, start_epoch)?;
        let mut token_lock = state.desktop_token.lock().map_err(|e| e.to_string())?;
        *token_lock = Some(token);

        let mut port_lock = state.port.lock().map_err(|e| e.to_string())?;
        *port_lock = Some(port);

        cleanup_old_deployed_server_packages(&server_pkg, &data_dir);

        Ok(())
    }
    .await;

    let still_current = is_start_epoch_active(&state, start_epoch)?;
    if still_current {
        let mut starting_lock = state.starting.lock().map_err(|e| e.to_string())?;
        *starting_lock = false;
    }

    match &result {
        Ok(()) => {
            if still_current {
                eprintln!("[Desktop] start_server: startup completed successfully");
                set_last_error(&state, None)?;
            }
        }
        Err(error) => {
            if still_current {
                eprintln!("[Desktop] start_server failed: {error}");
                clear_runtime_state(&state)?;
                if let Some(child) = take_child(&state)? {
                    let _ = stop_child_if_running(child).await;
                }
                set_last_error(&state, Some(error.clone()))?;
            } else {
                eprintln!(
                    "[Desktop] start_server result ignored for superseded startup: {error}"
                );
            }
        }
    }

    result
}

#[tauri::command]
pub async fn restart_server(app: AppHandle) -> Result<(), String> {
    emit_restart_event(&app, DESKTOP_SERVER_RESTART_STARTED_EVENT);

    if let Err(error) = stop_server(app.clone()).await {
        let _ = app.emit(DESKTOP_SERVER_RESTART_FINISHED_EVENT, error.clone());
        return Err(error);
    }

    match start_server(app.clone()).await {
        Ok(()) => {
            let _ = app.emit(DESKTOP_SERVER_RESTART_FINISHED_EVENT, "");
            Ok(())
        }
        Err(error) => {
            let _ = app.emit(DESKTOP_SERVER_RESTART_FINISHED_EVENT, error.clone());
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn stop_server(app: AppHandle) -> Result<(), String> {
    let state = app.state::<ServerState>();
    eprintln!("[Desktop] stop_server: requested");

    // Take the child out of the mutex so we don't hold the lock across .await
    let child = {
        take_child(&state)?
    };

    {
        let mut epoch_lock = state.start_epoch.lock().map_err(|e| e.to_string())?;
        let mut starting_lock = state.starting.lock().map_err(|e| e.to_string())?;
        *epoch_lock = epoch_lock.saturating_add(1);
        *starting_lock = false;
    }
    clear_runtime_state(&state)?;
    set_last_error(&state, None)?;

    if let Some(child) = child {
        if let Err(e) = stop_child_process(child).await {
            eprintln!("[Desktop] stop_server: graceful stop failed ({e}), attempting force kill via last_pid");
            // Fallback: use the last known PID to force-kill the orphan.
            // This handles the case where stop_child_process timed out but
            // the process is still running.
            if let Ok(lock) = state.last_pid.lock() {
                if let Some(pid) = *lock {
                    let status = std::process::Command::new("taskkill")
                        .args(["/PID", &pid.to_string(), "/T", "/F"])
                        .status();
                    match status {
                        Ok(s) => eprintln!("[Desktop] stop_server: fallback taskkill exited with {s}"),
                        Err(err) => eprintln!("[Desktop] stop_server: fallback taskkill failed: {err}"),
                    }
                }
            }
        }
    } else {
        eprintln!("[Desktop] stop_server: no running child process");
    }
    Ok(())
}

#[tauri::command]
pub async fn get_server_status(app: AppHandle) -> Result<String, String> {
    let state = app.state::<ServerState>();
    let mut child_lock = state.child.lock().map_err(|e| e.to_string())?;

    match child_lock.as_mut() {
        None => {
            let starting = *state.starting.lock().map_err(|e| e.to_string())?;
            if starting {
                return Ok("starting".to_string());
            }

            let last_error = state.last_error.lock().map_err(|e| e.to_string())?;
            if last_error.is_some() {
                return Ok("error".to_string());
            }

            Ok("stopped".to_string())
        }
        Some(child) => match child.try_wait() {
            Ok(Some(_status)) => {
                *child_lock = None;
                clear_runtime_state(&state)?;
                set_last_error(
                    &state,
                    Some("Server exited unexpectedly after startup".to_string()),
                )?;
                Ok("error".to_string())
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

#[tauri::command]
pub async fn get_server_error(app: AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<ServerState>();
    let error_lock = state.last_error.lock().map_err(|e| e.to_string())?;
    Ok(error_lock.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be monotonic")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("yep-anywhere-{name}-{stamp}"));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    #[test]
    fn start_epoch_changes_when_state_is_reset() {
        let state = ServerState::new();
        let first_epoch = current_start_epoch(&state).expect("epoch should be readable");
        state.kill_sync();
        let second_epoch = current_start_epoch(&state).expect("epoch should be readable");
        assert!(second_epoch > first_epoch);
    }

    #[test]
    fn cancelled_epoch_is_not_considered_active() {
        let state = ServerState::new();
        {
            let mut epoch_lock = state.start_epoch.lock().expect("epoch lock");
            let mut starting_lock = state.starting.lock().expect("starting lock");
            *epoch_lock = 7;
            *starting_lock = true;
        }

        assert!(is_start_epoch_active(&state, 7).expect("active check should succeed"));

        {
            let mut epoch_lock = state.start_epoch.lock().expect("epoch lock");
            let mut starting_lock = state.starting.lock().expect("starting lock");
            *epoch_lock = 8;
            *starting_lock = false;
        }

        assert!(
            !is_start_epoch_active(&state, 7).expect("active check should succeed")
        );
        assert_eq!(
            ensure_start_epoch_active(&state, 7).unwrap_err(),
            "Server startup cancelled"
        );
    }

    #[test]
    fn hash_directory_contents_is_stable_across_write_order() {
        let dir_a = test_temp_dir("hash-a");
        let dir_b = test_temp_dir("hash-b");
        fs::create_dir_all(dir_a.join("nested")).expect("dir a nested");
        fs::create_dir_all(dir_b.join("nested")).expect("dir b nested");

        fs::write(dir_a.join("nested").join("b.txt"), "beta").expect("write a b");
        fs::write(dir_a.join("a.txt"), "alpha").expect("write a a");

        fs::write(dir_b.join("a.txt"), "alpha").expect("write b a");
        fs::write(dir_b.join("nested").join("b.txt"), "beta").expect("write b b");

        let hash_a = hash_directory_contents(&dir_a).expect("hash a");
        let hash_b = hash_directory_contents(&dir_b).expect("hash b");
        assert_eq!(hash_a, hash_b);

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }

    #[test]
    fn deployed_server_root_uses_hash_directory() {
        let data_dir = PathBuf::from("C:/tmp/yep-test");
        let deployed = deployed_server_root(&data_dir, "abc123");
        assert_eq!(
            deployed,
            PathBuf::from("C:/tmp/yep-test/server-bundles/abc123")
        );
    }
}
