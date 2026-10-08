//! Asks iOS for time to finish pending work once the app is in the background,
//! instead of being suspended within seconds.

#[cfg(target_os = "ios")]
mod platform {
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };

    tauri::ios_plugin_binding!(init_plugin_background_task);

    struct BackgroundTask<R: Runtime>(PluginHandle<R>);

    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct Task {
        id: i64,
    }

    /// Starts a background task; iOS expires it on its own after about 30 seconds.
    #[tauri::command]
    async fn begin<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Task, String> {
        app.state::<BackgroundTask<R>>()
            .0
            .run_mobile_plugin_async("begin", ())
            .await
            .map_err(|e| e.to_string())
    }

    /// Ends a task started by `begin`; ending an expired task does nothing.
    #[tauri::command]
    async fn end<R: Runtime>(app: tauri::AppHandle<R>, id: i64) -> Result<(), String> {
        app.state::<BackgroundTask<R>>()
            .0
            .run_mobile_plugin_async("end", Task { id })
            .await
            .map_err(|e| e.to_string())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("background-task")
            .invoke_handler(tauri::generate_handler![begin, end])
            .setup(|app, api| {
                let handle = api.register_ios_plugin(init_plugin_background_task)?;
                app.manage(BackgroundTask(handle));
                Ok(())
            })
            .build()
    }
}

#[cfg(target_os = "ios")]
pub use platform::init;
