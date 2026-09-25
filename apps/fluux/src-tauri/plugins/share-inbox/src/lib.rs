mod inbox;

#[cfg(any(target_os = "ios", target_os = "android"))]
mod mobile {
    use super::inbox::Inbox;
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime, State,
    };
    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_share_inbox);

    struct Mobile<R: Runtime>(PluginHandle<R>);

    async fn inbox<R: Runtime>(state: &Mobile<R>) -> Result<Inbox, String> {
        #[derive(serde::Deserialize)]
        struct Location {
            path: String,
        }
        let location: Location = state
            .0
            .run_mobile_plugin_async("inboxPath", ())
            .await
            .map_err(|_| "Share storage unavailable".to_string())?;
        Ok(Inbox(std::path::PathBuf::from(location.path)))
    }

    #[tauri::command]
    async fn list<R: Runtime>(
        _app: tauri::AppHandle<R>,
        state: State<'_, Mobile<R>>,
    ) -> Result<Vec<super::inbox::Entry>, String> {
        inbox(&state)
            .await?
            .list()
            .map_err(|_| "Cannot read shared items".into())
    }

    #[tauri::command]
    async fn read<R: Runtime>(
        _app: tauri::AppHandle<R>,
        state: State<'_, Mobile<R>>,
        id: String,
        offset: u64,
    ) -> Result<String, String> {
        inbox(&state)
            .await?
            .read(&id, offset)
            .map_err(|_| "Cannot read shared file".into())
    }

    #[tauri::command]
    async fn remove<R: Runtime>(
        _app: tauri::AppHandle<R>,
        state: State<'_, Mobile<R>>,
        id: String,
    ) -> Result<(), String> {
        inbox(&state)
            .await?
            .remove(&id)
            .map_err(|_| "Cannot remove shared item".into())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("share-inbox")
            .invoke_handler(tauri::generate_handler![list, read, remove])
            .setup(|app, api| {
                #[cfg(target_os = "android")]
                let handle =
                    api.register_android_plugin("com.processone.shareinbox", "ShareInboxPlugin")?;
                #[cfg(target_os = "ios")]
                let handle = api.register_ios_plugin(init_plugin_share_inbox)?;
                app.manage(Mobile(handle));
                Ok(())
            })
            .build()
    }
}
#[cfg(any(target_os = "ios", target_os = "android"))]
pub use mobile::init;
