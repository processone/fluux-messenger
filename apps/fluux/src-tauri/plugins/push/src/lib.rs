//! Registers the device with the platform push service (APNs on iOS) and
//! returns the device token the XMPP push registration needs.

#[cfg(target_os = "ios")]
mod platform {
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };

    tauri::ios_plugin_binding!(init_plugin_push);

    struct Push<R: Runtime>(PluginHandle<R>);

    /// A device registration with the platform push service.
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Registration {
        /// Hex-encoded APNs device token.
        token: String,
        /// APNs environment the token belongs to: `development` or `production`.
        environment: String,
    }

    #[tauri::command]
    async fn register<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Registration, String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("register", ())
            .await
            .map_err(|e| e.to_string())
    }

    /// The payload of the remote notification the user last tapped, if the
    /// app has not taken it yet.
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct PendingTap {
        payload: Option<serde_json::Value>,
    }

    #[tauri::command]
    async fn take_pending_tap<R: Runtime>(app: tauri::AppHandle<R>) -> Result<PendingTap, String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("takePendingTap", ())
            .await
            .map_err(|e| e.to_string())
    }

    /// Display names by bare JID, for the notification service extension to
    /// title each push with its sender's name.
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct SenderNames {
        contacts: std::collections::HashMap<String, String>,
        rooms: std::collections::HashMap<String, String>,
    }

    #[tauri::command]
    async fn set_sender_names<R: Runtime>(app: tauri::AppHandle<R>, names: SenderNames) -> Result<(), String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("setSenderNames", names)
            .await
            .map_err(|e| e.to_string())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("push")
            .invoke_handler(tauri::generate_handler![register, take_pending_tap, set_sender_names])
            .setup(|app, api| {
                let handle = api.register_ios_plugin(init_plugin_push)?;
                app.manage(Push(handle));
                Ok(())
            })
            .build()
    }
}

#[cfg(target_os = "ios")]
pub use platform::init;
