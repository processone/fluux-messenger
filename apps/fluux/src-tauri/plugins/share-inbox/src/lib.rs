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
    pub(crate) struct Mobile<R: Runtime>(pub(crate) tauri::plugin::PluginHandle<R>);

    #[cfg(any(target_os = "ios", target_os = "android"))]
    pub(crate) async fn inbox<R: Runtime>(
        app: &tauri::AppHandle<R>,
    ) -> Result<Option<Inbox>, String> {
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
        Ok(Some(Inbox::new(std::path::PathBuf::from(location.path))))
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
        Ok(Some(Inbox::new(
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
        // Photo reduction is offered on iOS only; other platforms keep their commands.
        #[cfg(target_os = "ios")]
        let builder = Builder::new("share-inbox").invoke_handler(tauri::generate_handler![
            list,
            read,
            remove,
            super::photos::stage_photo,
            super::photos::probe_photo,
            super::photos::encode_photo,
            super::photos::read_photo,
            super::photos::discard_photo
        ]);
        #[cfg(not(target_os = "ios"))]
        let builder = Builder::new("share-inbox")
            .invoke_handler(tauri::generate_handler![list, read, remove]);
        builder
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

/// Native reduction of large photos before sending, on iOS only (FLM-22).
///
/// The app names a photo by its import or staging id, never by a path: these
/// commands resolve the confined directory and hand its paths to Image I/O.
#[cfg(target_os = "ios")]
mod photos {
    use super::inbox::{read_reduced, reduced_path, Staging};
    use super::platform::{inbox, Mobile};
    use serde::{Deserialize, Serialize};
    use std::path::PathBuf;
    use tauri::{ipc::InvokeBody, AppHandle, Manager, Runtime};

    #[derive(Deserialize)]
    #[serde(tag = "kind", content = "id", rename_all = "camelCase")]
    pub enum PhotoSource {
        Share(String),
        Staged(String),
    }

    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct PhotoProbe {
        #[serde(rename = "type")]
        kind: String,
        width: u32,
        height: u32,
        reducible: bool,
    }

    #[derive(Serialize, Deserialize)]
    pub struct PhotoEncoded {
        width: u32,
        height: u32,
        size: u64,
    }

    #[derive(Serialize)]
    struct ProbeArgs {
        path: String,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct EncodeArgs {
        source: String,
        destination: String,
        max_side: u32,
        quality: f64,
    }

    fn staging<R: Runtime>(app: &AppHandle<R>) -> Result<Staging, String> {
        app.path()
            .app_cache_dir()
            .map(|dir| Staging(dir.join("PhotoPrep")))
            .map_err(|_| "Photo storage unavailable".to_string())
    }

    async fn directory<R: Runtime>(
        app: &AppHandle<R>,
        source: &PhotoSource,
    ) -> Result<PathBuf, String> {
        match source {
            PhotoSource::Share(id) => inbox(app)
                .await?
                .ok_or("Share storage unavailable")?
                .photo(id),
            PhotoSource::Staged(id) => staging(app)?.photo(id),
        }
        .map_err(|_| "Photo unavailable".to_string())
    }

    fn path(value: PathBuf) -> Result<String, String> {
        value
            .into_os_string()
            .into_string()
            .map_err(|_| "Photo unavailable".to_string())
    }

    /// Copies a photo picked or pasted in the app, sent as the raw request body.
    #[tauri::command]
    pub async fn stage_photo<R: Runtime>(
        app: AppHandle<R>,
        request: tauri::ipc::Request<'_>,
    ) -> Result<(), String> {
        let id = request
            .headers()
            .get("x-photo-id")
            .and_then(|value| value.to_str().ok())
            .ok_or("Invalid photo")?
            .to_string();
        let InvokeBody::Raw(bytes) = request.body() else {
            return Err("Invalid photo".into());
        };
        let bytes = bytes.clone();
        let staging = staging(&app)?;
        tauri::async_runtime::spawn_blocking(move || staging.create(&id, &bytes))
            .await
            .map_err(|_| "Photo storage unavailable".to_string())?
            .map_err(|_| "Photo could not be staged".to_string())
    }

    #[tauri::command]
    pub async fn probe_photo<R: Runtime>(
        app: AppHandle<R>,
        source: PhotoSource,
    ) -> Result<PhotoProbe, String> {
        let data = path(directory(&app, &source).await?.join("data"))?;
        app.state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("probePhoto", ProbeArgs { path: data })
            .await
            .map_err(|_| "Unreadable photo".to_string())
    }

    #[tauri::command]
    pub async fn encode_photo<R: Runtime>(
        app: AppHandle<R>,
        source: PhotoSource,
        attempt: u8,
        max_side: u32,
        quality: f64,
    ) -> Result<PhotoEncoded, String> {
        if !(256..=8192).contains(&max_side) || !(0.1..=1.0).contains(&quality) {
            return Err("Invalid photo size".into());
        }
        let dir = directory(&app, &source).await?;
        let destination = path(reduced_path(&dir, attempt).map_err(|_| "Invalid photo size")?)?;
        let args = EncodeArgs {
            source: path(dir.join("data"))?,
            destination,
            max_side,
            quality,
        };
        app.state::<Mobile<R>>()
            .0
            .run_mobile_plugin_async("encodePhoto", args)
            .await
            .map_err(|_| "Photo could not be reduced".to_string())
    }

    /// Returns a reduced copy as raw bytes, without base64 or a JSON byte list.
    #[tauri::command]
    pub async fn read_photo<R: Runtime>(
        app: AppHandle<R>,
        source: PhotoSource,
        attempt: u8,
    ) -> Result<tauri::ipc::Response, String> {
        let dir = directory(&app, &source).await?;
        tauri::async_runtime::spawn_blocking(move || read_reduced(&dir, attempt))
            .await
            .map_err(|_| "Photo unavailable".to_string())?
            .map(tauri::ipc::Response::new)
            .map_err(|_| "Photo unavailable".to_string())
    }

    /// Removes a staged photo and its copies. An import's copies go with the import.
    #[tauri::command]
    pub async fn discard_photo<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), String> {
        staging(&app)?
            .remove(&id)
            .map_err(|_| "Photo unavailable".to_string())
    }
}
