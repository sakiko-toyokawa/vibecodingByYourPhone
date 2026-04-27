use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(target_os = "android")]
use jni::objects::JValue;

#[tauri::command]
fn set_system_bars(window: tauri::WebviewWindow, light: bool) {
    #[cfg(target_os = "android")]
    {
        let _ = window.with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _webview| {
                env.call_method(
                    activity,
                    "setSystemBars",
                    "(Z)V",
                    &[JValue::Bool(if light {
                        jni::sys::JNI_TRUE
                    } else {
                        jni::sys::JNI_FALSE
                    })],
                )
                .expect("setSystemBars call failed");
            });
        });
    }
}

#[tauri::command]
fn exit_app(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

/// Extract query string from an app link URL and convert to hash fragment.
///
/// Input:  https://yepanywhere.com/open?u=username&p=password&r=relay_url
/// Output: #u=username&p=password&r=relay_url
///
/// The existing remote client's parseHashCredentials() in RelayLoginPage.tsx
/// reads from window.location.hash to auto-login.
fn deep_link_to_hash(url_str: &str) -> Option<String> {
    let query = url_str.split('?').nth(1)?;
    if query.is_empty() {
        return None;
    }
    Some(format!("#{query}"))
}

fn build_hash_assignment_script(hash: &str) -> Option<String> {
    let serialized = serde_json::to_string(hash).ok()?;
    Some(format!("window.location.hash = {serialized};"))
}

fn handle_deep_link(app: &tauri::AppHandle, url_str: &str) {
    if let Some(hash) = deep_link_to_hash(url_str) {
        if let Some(window) = app.get_webview_window("main") {
            if let Some(script) = build_hash_assignment_script(&hash) {
                let _ = window.eval(&script);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_system_bars, exit_app])
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Handle deep links that launched the app
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let handle = app.handle().clone();
                for url in urls {
                    handle_deep_link(&handle, url.as_ref());
                }
            }

            // Handle deep links received while app is running
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_deep_link(&handle, url.as_ref());
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Yep Anywhere");

    app.run(|_, _| {});
}
