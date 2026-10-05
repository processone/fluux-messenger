//! Hands a local file to the system share sheet (iOS), where the user saves it
//! to Photos or Files, or sends it to another app.

#[cfg(target_os = "ios")]
mod platform {
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };

    tauri::ios_plugin_binding!(init_plugin_share_sheet);

    struct ShareSheet<R: Runtime>(PluginHandle<R>);

    /// A file to share, shown to the receiving app under `name`.
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct SharedFile {
        path: String,
        name: String,
    }

    /// Whether the user completed a share or dismissed the sheet.
    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct ShareOutcome {
        completed: bool,
    }

    #[tauri::command]
    async fn share_file<R: Runtime>(app: tauri::AppHandle<R>, path: String, name: String) -> Result<ShareOutcome, String> {
        app.state::<ShareSheet<R>>()
            .0
            .run_mobile_plugin_async("shareFile", SharedFile { path, name })
            .await
            .map_err(|e| e.to_string())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("share-sheet")
            .invoke_handler(tauri::generate_handler![share_file])
            .setup(|app, api| {
                let handle = api.register_ios_plugin(init_plugin_share_sheet)?;
                app.manage(ShareSheet(handle));
                Ok(())
            })
            .build()
    }
}

#[cfg(target_os = "ios")]
pub use platform::init;
