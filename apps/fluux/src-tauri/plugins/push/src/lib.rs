//! Registers the device with the platform push service (APNs on iOS) and
//! returns the device token the XMPP push registration needs.

mod conversation_destination;
mod notification_names;

#[cfg(target_os = "ios")]
mod platform {
    use super::conversation_destination::{valid_bare_jid, ConversationDestination};
    use super::notification_names::SenderNames;
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
    async fn export_notification_diagnostic<R: Runtime>(
        app: tauri::AppHandle<R>,
    ) -> Result<(), String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("exportNotificationDiagnostic", ())
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    async fn register<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Registration, String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("register", ())
            .await
            .map_err(|e| e.to_string())
    }

    /// The payload of the remote or app-posted local notification the user
    /// last tapped, if the app has not taken it yet.
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

    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct NotificationAvatar {
        account: String,
        hash: String,
        data: String,
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct AvatarWriteResult {
        written: bool,
    }

    #[tauri::command]
    async fn set_notification_avatar<R: Runtime>(
        app: tauri::AppHandle<R>,
        avatar: NotificationAvatar,
    ) -> Result<AvatarWriteResult, String> {
        if avatar.data.len() > 2 * 1024 * 1024 * 4 / 3 + 4
            || avatar.hash.len() != 40
            || !avatar.hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid notification avatar".into());
        }
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("setNotificationAvatar", avatar)
            .await
            .map_err(|e| e.to_string())
    }

    /// What the app icon badge counts, for the notification service extension
    /// to raise it on pushes while the app is suspended.
    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BadgeState {
        unread: Vec<String>,
        events: u32,
        notify_all_rooms: Vec<String>,
    }

    #[tauri::command]
    async fn set_badge<R: Runtime>(
        app: tauri::AppHandle<R>,
        badge: BadgeState,
    ) -> Result<(), String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("setBadge", badge)
            .await
            .map_err(|e| e.to_string())
    }

    #[derive(serde::Serialize)]
    struct DismissTarget {
        target: String,
    }

    /// Removes the delivered notifications of a conversation that was read:
    /// pushes from its JID and the app's own notifications for it.
    #[tauri::command]
    async fn dismiss_notifications<R: Runtime>(
        app: tauri::AppHandle<R>,
        target: String,
    ) -> Result<(), String> {
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("dismissNotifications", DismissTarget { target })
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    async fn set_sender_names<R: Runtime>(
        app: tauri::AppHandle<R>,
        names: SenderNames,
    ) -> Result<(), String> {
        if names.conversations.iter().any(|entry| {
            !valid_bare_jid(&entry.id)
                || !valid_bare_jid(&entry.account)
                || names.account.as_deref() != Some(entry.account.as_str())
                || !matches!(entry.kind.as_str(), "chat" | "groupchat")
        }) {
            return Err("Invalid shortcut conversation".into());
        }
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("setSenderNames", names)
            .await
            .map_err(|e| e.to_string())
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum NotificationTone {
        Default,
        Bell,
        Chime,
        Pulse,
        Silent,
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    pub struct SoundSettings {
        account: Option<String>,
        enabled: bool,
        tone: NotificationTone,
    }

    #[tauri::command]
    async fn set_notification_sound<R: Runtime>(
        app: tauri::AppHandle<R>,
        settings: SoundSettings,
    ) -> Result<(), String> {
        if settings
            .account
            .as_ref()
            .is_some_and(|account| !valid_bare_jid(account))
        {
            return Err("Invalid notification sound account".into());
        }
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("setNotificationSound", settings)
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    async fn remove_conversation_donations<R: Runtime>(
        app: tauri::AppHandle<R>,
        destination: ConversationDestination,
    ) -> Result<(), String> {
        destination.validate()?;
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("removeConversationDonations", destination)
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    async fn donate_conversation<R: Runtime>(
        app: tauri::AppHandle<R>,
        destination: ConversationDestination,
    ) -> Result<(), String> {
        destination.validate()?;
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async("donateConversation", destination)
            .await
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    async fn set_notification_preview<R: Runtime>(
        app: tauri::AppHandle<R>,
        snapshot: Option<serde_json::Value>,
        operation: Option<String>,
        deltas: Option<serde_json::Value>,
        request_id: Option<String>,
        account: Option<String>,
        fast_token: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        if snapshot
            .as_ref()
            .is_some_and(|s| s.to_string().len() > 512 * 1024)
        {
            return Err("Notification snapshot too large".into());
        }
        if deltas
            .as_ref()
            .is_some_and(|d| d.to_string().len() > 256 * 1024)
        {
            return Err("Notification ledger delta too large".into());
        }
        app.state::<Push<R>>()
            .0
            .run_mobile_plugin_async::<serde_json::Value>(
                "setNotificationPreview",
                serde_json::json!({"snapshot": snapshot, "operation": operation.unwrap_or_else(|| "revoke".into()), "deltas": deltas, "requestId": request_id, "account": account, "fastToken": fast_token}),
            )
            .await
            .map_err(|e| e.to_string())
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("push")
            .invoke_handler(tauri::generate_handler![
                register,
                take_pending_tap,
                set_sender_names,
                donate_conversation,
                remove_conversation_donations,
                set_notification_sound,
                set_notification_avatar,
                set_notification_preview,
                export_notification_diagnostic,
                set_badge,
                dismiss_notifications
            ])
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
