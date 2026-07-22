use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let open = MenuItem::with_id(app, "open", "Open Dashboard", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart Server", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &restart, &quit])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Yep Anywhere")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "restart" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::server::restart_server(app).await;
                });
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    // Cap graceful shutdown at 10s. If stop_server hangs (e.g.
                    // taskkill blocked by Defender), force exit and let
                    // RunEvent::Exit -> kill_sync handle the orphan.
                    let shutdown = tokio::time::timeout(
                        tokio::time::Duration::from_secs(10),
                        crate::server::stop_server(app.clone()),
                    )
                    .await;
                    match shutdown {
                        Ok(Ok(())) => {
                            eprintln!("[Desktop] Graceful shutdown completed");
                        }
                        Ok(Err(e)) => {
                            eprintln!("[Desktop] Graceful shutdown failed: {e}");
                        }
                        Err(_) => {
                            eprintln!("[Desktop] Graceful shutdown timed out, forcing exit");
                        }
                    }
                    app.exit(0);
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}
