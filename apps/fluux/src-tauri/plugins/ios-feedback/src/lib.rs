//! Native iOS gesture feedback and app-switcher snapshot privacy.
#[cfg(target_os = "ios")]
mod platform {
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };
    tauri::ios_plugin_binding!(init_plugin_ios_feedback);
    struct Feedback<R: Runtime>(PluginHandle<R>);
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum HapticKind {
        ContextMenu,
        Selection,
    }
    #[derive(serde::Serialize)]
    struct Haptic {
        kind: HapticKind,
    }
    #[tauri::command]
    async fn haptic<R: Runtime>(app: tauri::AppHandle<R>, kind: HapticKind) -> Result<(), String> {
        app.state::<Feedback<R>>()
            .0
            .run_mobile_plugin_async("haptic", Haptic { kind })
            .await
            .map_err(|e| e.to_string())
    }
    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("ios-feedback")
            .invoke_handler(tauri::generate_handler![haptic])
            .setup(|app, api| {
                let handle = api.register_ios_plugin(init_plugin_ios_feedback)?;
                app.manage(Feedback(handle));
                Ok(())
            })
            .build()
    }
}
#[cfg(target_os = "ios")]
pub use platform::init;
