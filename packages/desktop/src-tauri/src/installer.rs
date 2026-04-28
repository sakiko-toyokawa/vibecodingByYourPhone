use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Command;

use crate::{bundle, config};

#[derive(Clone, Serialize)]
struct InstallProgress {
    agent: String,
    status: String,
    message: String,
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

fn emit_progress(app: &AppHandle, agent: &str, status: &str, message: &str) {
    let _ = app.emit(
        "install-progress",
        InstallProgress {
            agent: agent.to_string(),
            status: status.to_string(),
            message: message.to_string(),
        },
    );
}

#[tauri::command]
pub async fn install_yep_server(app: AppHandle) -> Result<(), String> {
    let data_dir = config::data_dir();
    let server_pkg = data_dir.join("node_modules").join("yepanywhere");

    // Try bundled resources first (offline install)
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("yepanywhere-server");
        if bundled.exists() {
            let _ = fs::remove_dir_all(&server_pkg);
            config::copy_dir_all(&bundled, &server_pkg)?;
            if let Err(err) = bundle::validate_server_package_dir(&server_pkg) {
                let _ = fs::remove_dir_all(&server_pkg);
                let message = format!("Bundled Yep Anywhere server is incomplete: {err}");
                emit_progress(&app, "yep", "error", &message);
                return Err(message);
            }
            emit_progress(&app, "yep", "done", "Yep Anywhere server installed (bundled)");
            return Ok(());
        }
    }

    // Fallback: download from npm
    let bun = bun_path(&app)?;
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let tmp_dir = data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    emit_progress(&app, "yep", "installing", "Installing Yep Anywhere server...");

    let output = Command::new(&bun)
        .args(["install", "yepanywhere"])
        .current_dir(&data_dir)
        .env("TMP", tmp_dir.to_string_lossy().as_ref())
        .env("TEMP", tmp_dir.to_string_lossy().as_ref())
        .output()
        .await
        .map_err(|e| format!("Failed to run bun install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        emit_progress(&app, "yep", "error", &format!("Install failed: {stderr}"));
        return Err(format!("bun install failed: {stderr}"));
    }

    emit_progress(&app, "yep", "done", "Yep Anywhere server installed");
    Ok(())
}

#[tauri::command]
pub async fn install_claude(app: AppHandle) -> Result<(), String> {
    let bun = bun_path(&app)?;
    let data_dir = config::data_dir();
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let tmp_dir = data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    emit_progress(&app, "claude", "installing", "Installing Claude Code...");

    let output = Command::new(&bun)
        .args(["install", "@anthropic-ai/claude-code"])
        .current_dir(&data_dir)
        .env("TMP", tmp_dir.to_string_lossy().as_ref())
        .env("TEMP", tmp_dir.to_string_lossy().as_ref())
        .output()
        .await
        .map_err(|e| format!("Failed to run bun install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        emit_progress(
            &app,
            "claude",
            "error",
            &format!("Install failed: {stderr}"),
        );
        return Err(format!("bun install failed: {stderr}"));
    }

    emit_progress(&app, "claude", "done", "Claude Code installed");
    Ok(())
}

#[tauri::command]
pub async fn install_gemini(app: AppHandle) -> Result<(), String> {
    let bun = bun_path(&app)?;
    let data_dir = config::data_dir();
    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let tmp_dir = data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    emit_progress(&app, "gemini", "installing", "Installing Gemini CLI...");

    let output = Command::new(&bun)
        .args(["install", "@google/gemini-cli"])
        .current_dir(&data_dir)
        .env("TMP", tmp_dir.to_string_lossy().as_ref())
        .env("TEMP", tmp_dir.to_string_lossy().as_ref())
        .output()
        .await
        .map_err(|e| format!("Failed to run bun install: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        emit_progress(
            &app,
            "gemini",
            "error",
            &format!("Install failed: {stderr}"),
        );
        return Err(format!("bun install failed: {stderr}"));
    }

    emit_progress(&app, "gemini", "done", "Gemini CLI installed");
    Ok(())
}

#[tauri::command]
pub async fn install_codex(app: AppHandle) -> Result<(), String> {
    let bin_dir = config::bin_dir();
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;

    emit_progress(&app, "codex", "installing", "Downloading Codex CLI...");

    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.github.com/repos/openai/codex/releases/latest")
        .header("User-Agent", "yep-anywhere-desktop")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch release info: {e}"))?;

    let release: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {e}"))?;

    // Codex assets use Rust target triples: codex-{triple}.tar.gz (Unix) or codex-{triple}.exe (Windows)
    let triple = env!("TARGET_TRIPLE");
    let (asset_name, is_archive) = if cfg!(windows) {
        (format!("codex-{triple}.exe"), false)
    } else {
        (format!("codex-{triple}.tar.gz"), true)
    };

    let assets = release["assets"]
        .as_array()
        .ok_or("No assets in release")?;
    let asset = assets
        .iter()
        .find(|a| a["name"].as_str().is_some_and(|n| n == asset_name))
        .ok_or_else(|| format!("No asset found: {asset_name}"))?;

    let download_url = asset["browser_download_url"]
        .as_str()
        .ok_or("No download URL")?;

    emit_progress(&app, "codex", "downloading", "Downloading...");

    let bytes = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;

    let codex_bin = if cfg!(windows) {
        bin_dir.join("codex.exe")
    } else {
        bin_dir.join("codex")
    };

    if is_archive {
        // Extract codex binary from tar.gz
        emit_progress(&app, "codex", "extracting", "Extracting...");

        use flate2::read::GzDecoder;
        use std::io::Cursor;
        use tar::Archive;

        let decoder = GzDecoder::new(Cursor::new(bytes.as_ref()));
        let mut archive = Archive::new(decoder);
        let mut found = false;

        for entry in archive
            .entries()
            .map_err(|e| format!("Failed to read archive: {e}"))?
        {
            let mut entry = entry.map_err(|e| format!("Failed to read entry: {e}"))?;
            let path = entry
                .path()
                .map_err(|e| format!("Failed to read path: {e}"))?;
            if path.file_name().is_some_and(|n| {
                let s = n.to_string_lossy();
                s == "codex" || s.starts_with("codex-")
            }) {
                entry
                    .unpack(&codex_bin)
                    .map_err(|e| format!("Failed to extract codex: {e}"))?;
                found = true;
                break;
            }
        }

        if !found {
            return Err("Could not find codex binary in archive".to_string());
        }
    } else {
        fs::write(&codex_bin, &bytes).map_err(|e| format!("Failed to write binary: {e}"))?;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&codex_bin, fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to set permissions: {e}"))?;
    }

    emit_progress(&app, "codex", "done", "Codex CLI installed");
    Ok(())
}

#[tauri::command]
pub async fn check_agent_installed(agent: String) -> Result<bool, String> {
    match agent.as_str() {
        "claude" => {
            if config::which_in_path("claude").is_some() {
                return Ok(true);
            }
            let path = config::data_dir()
                .join("node_modules")
                .join(".bin")
                .join("claude");
            Ok(path.exists())
        }
        "codex" => {
            if config::which_in_path("codex").is_some() {
                return Ok(true);
            }
            let path = config::bin_dir().join(if cfg!(windows) {
                "codex.exe"
            } else {
                "codex"
            });
            Ok(path.exists())
        }
        "gemini" => {
            if config::which_in_path("gemini").is_some() {
                return Ok(true);
            }
            let path = config::data_dir()
                .join("node_modules")
                .join(".bin")
                .join("gemini");
            Ok(path.exists())
        }
        "yep" => {
            // In dev mode, the server runs from local source — no install needed.
            if config::dev_dir().is_some() {
                return Ok(true);
            }
            let path = config::data_dir()
                .join("node_modules")
                .join("yepanywhere")
                .join("dist")
                .join("index.js");
            Ok(path.exists())
        }
        _ => Err(format!("Unknown agent: {agent}")),
    }
}

/// Check if Claude is already authenticated by running `claude auth status`
/// and parsing the JSON output. Returns true if `loggedIn` is true.
#[tauri::command]
pub async fn check_claude_auth(app: AppHandle) -> Result<bool, String> {
    let _ = app;
    let data_dir = config::data_dir();
    let tmp_dir = data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // Prefer system PATH claude, fallback to data dir npm package
    #[cfg(windows)]
    let script = config::which_in_path("claude")
        .unwrap_or_else(|| data_dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe"));
    #[cfg(not(windows))]
    let script = config::which_in_path("claude")
        .unwrap_or_else(|| data_dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("cli.js"));

    if !script.exists() {
        return Ok(false);
    }

    #[cfg(windows)]
    let output = Command::new(&script)
        .args(["auth", "status"])
        .env("TMP", tmp_dir.to_string_lossy().as_ref())
        .env("TEMP", tmp_dir.to_string_lossy().as_ref())
        .output()
        .await
        .map_err(|e| format!("Failed to run claude auth status: {e}"))?;

    #[cfg(not(windows))]
    let bun = bun_path(&app)?;
    #[cfg(not(windows))]
    let output = Command::new(&bun)
        .args([script.to_string_lossy().as_ref(), "auth", "status"])
        .env("TMP", tmp_dir.to_string_lossy().as_ref())
        .env("TEMP", tmp_dir.to_string_lossy().as_ref())
        .output()
        .await
        .map_err(|e| format!("Failed to run claude auth status: {e}"))?;

    // claude auth status prints JSON to stdout (may exit non-zero even when logged in)
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.contains("loggedIn") {
        stdout
    } else {
        stderr
    };

    Ok(text.contains("\"loggedIn\": true") || text.contains("\"loggedIn\":true"))
}

/// Check if Gemini is already authenticated by running `gemini auth status`.
/// Returns true if the output indicates the user is logged in.
#[tauri::command]
pub async fn check_gemini_auth(app: AppHandle) -> Result<bool, String> {
    let data_dir = config::data_dir();
    let tmp_dir = data_dir.join("tmp");
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // Prefer system PATH gemini, fallback to data dir npm package via bun
    let output = if let Some(gemini_path) = config::which_in_path("gemini") {
        Command::new(&gemini_path)
            .args(["auth", "status"])
            .env("TMP", tmp_dir.to_string_lossy().as_ref())
            .env("TEMP", tmp_dir.to_string_lossy().as_ref())
            .output()
            .await
            .map_err(|e| format!("Failed to run gemini auth status: {e}"))?
    } else {
        let script = data_dir
            .join("node_modules")
            .join("@google")
            .join("gemini-cli")
            .join("dist")
            .join("index.js");
        if !script.exists() {
            return Ok(false);
        }
        let bun = bun_path(&app)?;
        Command::new(&bun)
            .args([script.to_string_lossy().as_ref(), "auth", "status"])
            .env("TMP", tmp_dir.to_string_lossy().as_ref())
            .env("TEMP", tmp_dir.to_string_lossy().as_ref())
            .output()
            .await
            .map_err(|e| format!("Failed to run gemini auth status: {e}"))?
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = if stdout.contains("authenticated") || stdout.contains("logged in") {
        stdout
    } else {
        stderr
    };

    Ok(text.contains("authenticated") || text.contains("logged in"))
}
