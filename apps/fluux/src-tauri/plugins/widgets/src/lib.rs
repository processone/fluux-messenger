//! The unread list an Apple native widget shows. The app hands it over here; Swift writes it into
//! the App Group folder and asks WidgetKit to redraw (mobile plugin or desktop bridge).
#[cfg(target_os = "ios")]
mod platform {
    use tauri::{
        plugin::{Builder, PluginHandle, TauriPlugin},
        Manager, Runtime,
    };
    tauri::ios_plugin_binding!(init_plugin_widgets);
    struct Widgets<R: Runtime>(PluginHandle<R>);

    #[derive(serde::Serialize, serde::Deserialize)]
    struct UnreadRow {
        id: String,
        kind: String,
        name: String,
        unread: u32,
        mentions: u32,
        last: f64,
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct UnreadList {
        account: String,
        total: u32,
        rows: Vec<UnreadRow>,
        updated: f64,
    }

    #[derive(serde::Serialize)]
    struct UnreadListArguments {
        list: Option<UnreadList>,
    }

    /// Writes the list, or empties it for `None` (signed out).
    #[tauri::command]
    async fn set_unread_list<R: Runtime>(
        app: tauri::AppHandle<R>,
        list: Option<UnreadList>,
    ) -> Result<(), String> {
        app.state::<Widgets<R>>()
            .0
            .run_mobile_plugin_async("setUnreadList", UnreadListArguments { list })
            .await
            .map_err(|e| e.to_string())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("widgets")
            .invoke_handler(tauri::generate_handler![set_unread_list])
            .setup(|app, api| {
                let handle = api.register_ios_plugin(init_plugin_widgets)?;
                app.manage(Widgets(handle));
                Ok(())
            })
            .build()
    }
}
#[cfg(target_os = "ios")]
pub use platform::init;

#[cfg(target_os = "macos")]
mod desktop;
#[cfg(target_os = "macos")]
pub use desktop::init;
