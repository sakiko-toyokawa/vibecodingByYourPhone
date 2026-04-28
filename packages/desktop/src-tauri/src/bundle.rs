use std::path::{Path, PathBuf};

const REQUIRED_SERVER_FILES: &[&str] = &[
    "package.json",
    "dist/index.js",
    "dist/server.js",
    "dist/services-init.js",
    "client-dist/index.html",
];

const REQUIRED_RUNTIME_PACKAGES: &[&str] = &[
    "hono",
    "@hono/node-server",
    "@hono/node-ws",
    "pino",
    "zod",
    "ws",
    "ioredis",
    "bcrypt",
    "@anthropic-ai/claude-agent-sdk",
    "@openai/codex-sdk",
    "awilix",
    "diff",
    "marked",
    "proper-lockfile",
];

fn package_path(node_modules_root: &Path, package_name: &str) -> PathBuf {
    let mut path = node_modules_root.to_path_buf();
    for segment in package_name.split('/').filter(|segment| !segment.is_empty()) {
        path = path.join(segment);
    }
    path
}

fn missing_required_paths(server_pkg: &Path) -> Vec<PathBuf> {
    let mut missing = Vec::new();

    for relative_path in REQUIRED_SERVER_FILES {
        let full_path = server_pkg.join(relative_path);
        if !full_path.exists() {
            missing.push(full_path);
        }
    }

    let node_modules_root = server_pkg.join("node_modules");
    for package_name in REQUIRED_RUNTIME_PACKAGES {
        let full_path = package_path(&node_modules_root, package_name);
        if !full_path.exists() {
            missing.push(full_path);
        }
    }

    missing
}

pub fn has_required_runtime_dependencies(server_pkg: &Path) -> bool {
    let node_modules_root = server_pkg.join("node_modules");
    REQUIRED_RUNTIME_PACKAGES.iter().all(|package_name| {
        let package_path = package_path(&node_modules_root, package_name);
        package_path.exists()
    })
}

pub fn validate_server_package_dir(server_pkg: &Path) -> Result<(), String> {
    let missing = missing_required_paths(server_pkg);
    if missing.is_empty() {
        return Ok(());
    }

    let preview_count = 8usize;
    let mut preview = missing
        .iter()
        .take(preview_count)
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>();
    if missing.len() > preview_count {
        preview.push(format!("... and {} more", missing.len() - preview_count));
    }

    Err(format!("missing required paths: {}", preview.join(", ")))
}
