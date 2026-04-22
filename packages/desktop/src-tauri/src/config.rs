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
    base.join(".yep-anywhere-desktop")
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
