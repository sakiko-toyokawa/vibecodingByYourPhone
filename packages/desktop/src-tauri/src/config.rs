use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub setup_complete: bool,
    pub agents: Vec<String>,
    /// User-specified port override. None = auto-pick a free port on each launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    pub start_minimized: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            setup_complete: false,
            agents: vec![],
            port: None,
            start_minimized: false,
        }
    }
}

pub fn data_dir() -> PathBuf {
    let base = dirs::home_dir().expect("Could not find home directory");
    base.join(".yep-anywhere")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

pub fn bin_dir() -> PathBuf {
    data_dir().join("bin")
}

/// If `YEP_DEV_DIR` is set, run from local source instead of installed npm package.
pub fn dev_dir() -> Option<PathBuf> {
    std::env::var("YEP_DEV_DIR").ok().map(PathBuf::from)
}

pub fn load_config() -> AppConfig {
    let path = config_path();
    if path.exists() {
        let contents = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&contents).unwrap_or_default()
    } else {
        AppConfig::default()
    }
}

pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Look up an executable name in the system PATH.
pub fn which_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let paths = std::env::split_paths(&path_var);

    for dir in paths {
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat", "com"] {
                let p = dir.join(format!("{name}.{ext}"));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Find Node.js executable on Windows, checking common installation paths
/// in addition to PATH. GUI apps often don't see PATH changes until logout.
#[cfg(windows)]
pub fn find_node_windows() -> Option<PathBuf> {
    // Check PATH first
    if let Some(p) = which_in_path("node") {
        return Some(p);
    }

    // Common Node.js installation paths on Windows
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];
    for p in &candidates {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Some(path);
        }
    }

    // Check via LOCALAPPDATA (nvs, fnm, etc.)
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local_app_data);
        let extra = [
            local.join("nvs").join("default").join("node.exe"),
            local.join("fnm").join("node.exe"),
        ];
        for p in &extra {
            if p.is_file() {
                return Some(p.clone());
            }
        }
    }

    None
}

/// Recursively copy a directory.
pub fn copy_dir_all(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("create_dir_all failed: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read_dir failed: {e}"))? {
        let entry = entry.map_err(|e| format!("entry failed: {e}"))?;
        let ty = entry.file_type().map_err(|e| format!("file_type failed: {e}"))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path).map_err(|e| {
                format!("copy {} -> {} failed: {e}", src_path.display(), dst_path.display())
            })?;
        }
    }
    Ok(())
}
