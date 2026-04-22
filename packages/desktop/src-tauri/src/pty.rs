use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::{Mutex, PoisonError};
use tauri::{AppHandle, Emitter, Manager};

use crate::config;

pub struct PtyState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    alive: Mutex<bool>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            master: Mutex::new(None),
            alive: Mutex::new(false),
        }
    }
}

fn lock_err<T>(e: PoisonError<T>) -> String {
    e.to_string()
}

#[derive(Clone, Serialize)]
struct PtyOutput {
    data: String,
}

#[tauri::command]
pub async fn spawn_pty(app: AppHandle, command: String, args: Vec<String>) -> Result<(), String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // Resolve command to use the bundled bun sidecar as the runtime.
    // We can't rely on system node/bun — the app must work on a fresh macOS install.
    let bun = {
        let exe = std::env::current_exe()
            .map_err(|e| format!("Could not resolve executable: {e}"))?;
        let exe_dir = exe
            .parent()
            .ok_or_else(|| "Could not resolve executable directory".to_string())?;
        let bin_name = if cfg!(windows) { "bun.exe" } else { "bun" };
        exe_dir.join(bin_name)
    };

    let data_dir = config::data_dir();

    // For known commands (claude, codex), resolve to their actual scripts/binaries
    // and run them with the bundled bun. For unknown commands, run directly.
    let cmd = match command.as_str() {
        "claude" => {
            let script = data_dir
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("cli.js");
            let mut c = CommandBuilder::new(&bun);
            c.arg(&script);
            for arg in &args {
                c.arg(arg);
            }
            c.cwd(dirs::home_dir().unwrap_or_else(|| "/".into()));
            c
        }
        _ => {
            let mut c = CommandBuilder::new(&command);
            for arg in &args {
                c.arg(arg);
            }
            c
        }
    };

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {e}"))?;

    // Store writer for sending input
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to get PTY writer: {e}"))?;

    // Clone reader before storing master
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to get PTY reader: {e}"))?;

    let state = app.state::<PtyState>();
    *state.writer.lock().map_err(lock_err)? = Some(writer);
    *state.master.lock().map_err(lock_err)? = Some(pair.master);
    *state.alive.lock().map_err(lock_err)? = true;

    // Read PTY output in background and emit events
    let app_clone = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit("pty-output", PtyOutput { data });
                }
                Err(_) => break,
            }
        }
        let state = app_clone.state::<PtyState>();
        if let Ok(mut alive) = state.alive.lock() {
            *alive = false;
        }
        let _ = app_clone.emit("pty-exit", ());
    });

    Ok(())
}

#[tauri::command]
pub async fn write_pty(app: AppHandle, data: String) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let mut writer_lock = state.writer.lock().map_err(lock_err)?;

    if let Some(ref mut writer) = *writer_lock {
        writer
            .write_all(data.as_bytes())
            .map_err(|e| format!("Failed to write to PTY: {e}"))?;
        writer.flush().map_err(|e| format!("Failed to flush PTY: {e}"))?;
    } else {
        return Err("No PTY session active".to_string());
    }

    Ok(())
}

#[tauri::command]
pub async fn resize_pty(app: AppHandle, cols: u16, rows: u16) -> Result<(), String> {
    let state = app.state::<PtyState>();
    let master_lock = state.master.lock().map_err(lock_err)?;

    if let Some(ref master) = *master_lock {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("Failed to resize PTY: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn kill_pty(app: AppHandle) -> Result<(), String> {
    let state = app.state::<PtyState>();
    *state.writer.lock().map_err(lock_err)? = None;
    *state.master.lock().map_err(lock_err)? = None;
    *state.alive.lock().map_err(lock_err)? = false;
    Ok(())
}
