mod inbox;

#[cfg(any(target_os = "ios", target_os = "android", target_os = "macos"))]
mod platform {
    use super::inbox::Inbox;
    #[cfg(any(target_os = "ios", target_os = "android"))]
    use tauri::Manager;
    use tauri::{
        plugin::{Builder, TauriPlugin},
        Runtime,
    };
    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_share_inbox);

    #[cfg(any(target_os = "ios", target_os = "android"))]
    struct Mobile<R: Runtime>(tauri::plugin::PluginHandle<R>);

    #[cfg(any(target_os = "ios", target_os = "android"))]
    async fn inbox<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<Option<Inbox>, String> {
        let state = app.state::<Mobile<R>>();
        #[derive(serde::Deserialize)]
        struct Location {
            path: String,
        }
        let location: Location = state
            .0
            .run_mobile_plugin_async("inboxPath", ())
            .await
            .map_err(|_| "Share storage unavailable".to_string())?;
        Ok(Some(Inbox(std::path::PathBuf::from(location.path))))
    }

    #[cfg(target_os = "macos")]
    async fn inbox<R: Runtime>(_app: &tauri::AppHandle<R>) -> Result<Option<Inbox>, String> {
        use objc2_foundation::{NSBundle, NSFileManager, NSString};
        // Unbundled `tauri dev` has no extension or shared-container entitlement.
        let Some(value) = NSBundle::mainBundle()
            .objectForInfoDictionaryKey(&NSString::from_str("FluuxShareGroup"))
        else {
            return Ok(None);
        };
        let group = value
            .downcast::<NSString>()
            .map_err(|_| "Invalid share group")?;
        let url = NSFileManager::defaultManager()
            .containerURLForSecurityApplicationGroupIdentifier(&group)
            .ok_or("Share storage unavailable")?;
        let path = url.path().ok_or("Share storage unavailable")?;
        Ok(Some(Inbox(
            std::path::PathBuf::from(path.to_string()).join("ShareInbox"),
        )))
    }

    #[tauri::command]
    async fn list<R: Runtime>(
        app: tauri::AppHandle<R>,
    ) -> Result<Vec<super::inbox::Entry>, String> {
        let Some(inbox) = inbox(&app).await? else {
            return Ok(vec![]);
        };
        inbox.list().map_err(|_| "Cannot read shared items".into())
    }

    #[tauri::command]
    async fn read<R: Runtime>(
        app: tauri::AppHandle<R>,
        id: String,
        offset: u64,
    ) -> Result<String, String> {
        inbox(&app)
            .await?
            .ok_or("Share storage unavailable")?
            .read(&id, offset)
            .map_err(|_| "Cannot read shared file".into())
    }

    #[tauri::command]
    async fn remove<R: Runtime>(app: tauri::AppHandle<R>, id: String) -> Result<(), String> {
        inbox(&app)
            .await?
            .ok_or("Share storage unavailable")?
            .remove(&id)
            .map_err(|_| "Cannot remove shared item".into())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("share-inbox")
            .invoke_handler(tauri::generate_handler![list, read, remove])
            .setup(|_app, _api| {
                #[cfg(target_os = "android")]
                let handle =
                    _api.register_android_plugin("com.processone.shareinbox", "ShareInboxPlugin")?;
                #[cfg(target_os = "ios")]
                let handle = _api.register_ios_plugin(init_plugin_share_inbox)?;
                #[cfg(any(target_os = "ios", target_os = "android"))]
                _app.manage(Mobile(handle));
                Ok(())
            })
            .build()
    }
}
#[cfg(any(target_os = "ios", target_os = "android", target_os = "macos"))]
pub use platform::init;
