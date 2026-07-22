# Desktop App (Tauri)

System tray app that bundles Node.js and runs yepanywhere server. No webview — users access the UI via their normal browser.

## Goals

- **No CLI required** — Download, install, done
- **System tray** — Status, quick actions, native notifications
- **Browser-based UI** — Uses user's preferred browser
- **Auto-update** — Seamless updates via GitHub Releases
- **Cross-platform** — macOS, Windows, Linux

## Target Users

- Claude Pro subscribers ($20/mo) who aren't developers
- Anyone intimidated by terminal/npm
- Users who want a "real app" experience

## Architecture

```
yepanywhere.app/
├── Contents/
│   ├── MacOS/
│   │   ├── yepanywhere        # Tauri binary (tray only, no window)
│   │   └── node               # Bundled Node.js binary (sidecar)
│   └── Resources/
│       └── app/               # yepanywhere JS server code
```

**Size:** ~20MB (no webview = much smaller than Electron)

**Runtime:**
1. Tauri launches (no window, tray only)
2. Spawns Node.js sidecar: `node app/server.js`
3. User clicks "Open in Browser" → opens `http://localhost:3400`

## System Tray Menu

### macOS (Menu Bar)

```
● yepanywhere
├── Open in Browser              → opens localhost:3400
├── ────────────────────────────
├── ● 3 sessions active
├── ● Waiting: project-x         → opens that session
├── ────────────────────────────
├── Start on Login         ✓
├── ────────────────────────────
├── Restart Server
├── Quit
```

### Windows / Linux (System Tray)

Same menu, accessed via right-click on tray icon.

## Features

| Feature | Description |
|---------|-------------|
| **Tray icon** | Shows status (green = running, yellow = needs attention, red = error) |
| **Open in Browser** | Launches default browser to localhost:3400 |
| **Session shortcuts** | Quick access to sessions needing attention |
| **Native notifications** | OS-level alerts when approval needed |
| **Auto-launch** | Option to start on login |
| **Deep links** | `yepanywhere://session/abc123` opens in browser |
| **Auto-update** | Checks GitHub Releases, prompts to update |

## Onboarding

First launch opens browser to `http://localhost:3400/setup` which shows:

1. Claude CLI status (installed or not)
2. Instructions: `npm install -g @anthropic-ai/claude-code`
3. Auth status
4. Link to run `claude` for OAuth

All in the web UI — no native onboarding needed. Tray app just runs the server.

**Licensing:** We don't distribute Claude CLI. User installs via npm. Clean legally.

## Code Signing

### macOS

Tauri handles signing + notarization automatically.

**Requirements:**
- Apple Developer account ($99/year)
- Developer ID Application certificate

**Environment variables (CI):**
```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)"
APPLE_CERTIFICATE="base64-encoded-.p12"
APPLE_CERTIFICATE_PASSWORD="password"
APPLE_ID="your@apple.id"
APPLE_PASSWORD="app-specific-password"
APPLE_TEAM_ID="TEAMID"
```

### Windows

**Options:**
| Type | Cost | Trust Level |
|------|------|-------------|
| Self-signed | Free | SmartScreen warning |
| OV cert | ~$200/year | Builds reputation |
| EV cert | ~$400/year | Immediate trust |

Start with self-signed, upgrade to OV when you have users.

### Linux

No signing required. Just ship .deb, .rpm, or .AppImage.

## Auto-Update

Uses Tauri's built-in updater with GitHub Releases.

**tauri.conf.json:**
```json
{
  "plugins": {
    "updater": {
      "active": true,
      "pubkey": "YOUR_PUBLIC_KEY",
      "endpoints": [
        "https://github.com/kgraehl/yepanywhere/releases/latest/download/latest.json"
      ]
    }
  }
}
```

**Flow:**
1. App checks for updates on launch
2. If newer version, shows native notification
3. User clicks → downloads, verifies signature, installs
4. Restarts into new version

## GitHub Actions Workflow

```yaml
name: Desktop Release

on:
  push:
    tags:
      - 'desktop-v*'

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
          - os: macos-latest
            target: x86_64-apple-darwin
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install dependencies
        run: pnpm install

      - name: Download Node.js binary
        run: ./scripts/download-node.sh ${{ matrix.target }}

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # macOS signing
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          # Windows signing (optional)
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
        with:
          tagName: desktop-v__VERSION__
          releaseName: 'Desktop v__VERSION__'
          releaseBody: 'See CHANGELOG.md for details.'
```

## Project Structure

```
packages/
├── desktop/                    # New Tauri package
│   ├── src-tauri/
│   │   ├── Cargo.toml
│   │   ├── tauri.conf.json
│   │   ├── src/
│   │   │   └── main.rs         # Tray setup, sidecar spawn
│   │   └── binaries/
│   │       └── node-*          # Node.js binaries per platform
│   └── package.json
├── server/                     # Existing (bundled in Resources/)
└── client/                     # Existing (bundled, served by server)
```

## Tauri Main (Rust)

```rust
use tauri::{
    CustomMenuItem, Manager, SystemTray, SystemTrayEvent,
    SystemTrayMenu, SystemTrayMenuItem,
};

fn main() {
    let tray_menu = SystemTrayMenu::new()
        .add_item(CustomMenuItem::new("open", "Open in Browser"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("status", "● Starting...").disabled())
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("autostart", "Start on Login"))
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(CustomMenuItem::new("restart", "Restart Server"))
        .add_item(CustomMenuItem::new("quit", "Quit"));

    tauri::Builder::default()
        .setup(|app| {
            // Hide from dock (macOS)
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Spawn Node.js sidecar
            let sidecar = app.shell().sidecar("node").unwrap();
            let (mut rx, _child) = sidecar
                .args(["app/server.js"])
                .spawn()
                .expect("Failed to spawn node");

            // Handle sidecar output (for status updates)
            tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    // Update tray status based on server output
                }
            });

            Ok(())
        })
        .system_tray(SystemTray::new().with_menu(tray_menu))
        .on_system_tray_event(|app, event| match event {
            SystemTrayEvent::MenuItemClick { id, .. } => match id.as_str() {
                "open" => {
                    open::that("http://localhost:3400").unwrap();
                }
                "quit" => {
                    app.exit(0);
                }
                "restart" => {
                    // Kill and respawn sidecar
                }
                _ => {}
            },
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Implementation Steps

1. **Setup Tauri project**
   - `npm create tauri-app@latest packages/desktop -- --template vanilla`
   - Remove all window/webview config
   - Configure as tray-only app

2. **Bundle Node.js as sidecar**
   - Script to download Node.js binaries for each platform
   - Configure in `tauri.conf.json` as external binary
   - Spawn on app launch

3. **Tray menu**
   - Open in Browser
   - Session status (poll server API)
   - Start on Login toggle
   - Restart / Quit

4. **Native notifications**
   - Server emits events when approval needed
   - Tray app shows native notification
   - Click opens browser to that session

5. **Deep links**
   - Register `yepanywhere://` URL scheme
   - Parse and open in browser

6. **Signing setup**
   - Get Apple Developer account
   - Generate certificates
   - Add secrets to GitHub

7. **CI/CD**
   - Build for all platforms in matrix
   - Sign macOS, optionally sign Windows
   - Upload to GitHub Releases

## Open Questions

- **Universal binary (macOS)?** — Ship fat binary for Intel + Apple Silicon, or separate?
- **Bundled Node version** — Pin to specific LTS? How to update?
- **Notification protocol** — How does tray app know when server needs attention? Poll `/api/status`? WebSocket?

## Platform Summary

| Platform | Installer | Signing | Cost |
|----------|-----------|---------|------|
| macOS | .dmg | Required | $99/year |
| Windows | .msi, .exe | Optional | $0-400/year |
| Linux | .deb, .rpm, .AppImage | None | $0 |

## References

- [Tauri System Tray](https://tauri.app/v1/guides/features/system-tray/)
- [Tauri Sidecar](https://tauri.app/v1/guides/building/sidecar/)
- [Tauri Code Signing](https://tauri.app/v1/guides/distribution/sign-macos/)
- [Tauri Updater](https://tauri.app/v1/guides/distribution/updater/)
- [tauri-action](https://github.com/tauri-apps/tauri-action)
