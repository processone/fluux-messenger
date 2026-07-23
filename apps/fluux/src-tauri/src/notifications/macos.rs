//! macOS native notifications via `UNUserNotificationCenter`.

use crate::notifications::backend::{AuthState, NativeNotification, NavTarget};
use core::ptr::NonNull;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSBundle, NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationTrigger, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::time::Duration;
use tauri::AppHandle;

/// Keeps the notification-center delegate alive for the app's lifetime.
/// `setDelegate:` stores it as a weak reference, so we must own it here.
static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

/// Identifiers delivered during this process, grouped by conversation. The
/// native identifier now carries optional message/account context, so a read
/// action needs this index to remove every notification for the conversation.
static DELIVERED_IDS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

/// Whether the process is running from a proper `.app` bundle. The notification
/// APIs require it: `+[UNUserNotificationCenter currentNotificationCenter]`
/// raises `NSInternalInconsistencyException` — which unwinds across the ObjC→Rust
/// FFI boundary and `abort()`s the process — when `NSBundle.mainBundle` has no
/// bundle identifier. That is the case when the raw executable is launched
/// directly instead of via the `.app` wrapper, e.g. under `tauri dev`
/// (`target/debug/fluux`).
fn is_bundled() -> bool {
    NSBundle::mainBundle().bundleIdentifier().is_some()
}

/// The system notification center, or `None` when the process is not running
/// from an app bundle (see [`is_bundled`]). Callers degrade to "no native
/// notifications" rather than crashing on startup.
fn current_center() -> Option<Retained<UNUserNotificationCenter>> {
    if !is_bundled() {
        return None;
    }
    Some(UNUserNotificationCenter::currentNotificationCenter())
}

/// Encode the complete target into the identifier. The identifier survives a
/// cold start, unlike in-memory callback state.
fn encode_identifier(target: &NavTarget) -> String {
    serde_json::to_string(target)
        .unwrap_or_else(|_| format!("{}:{}", target.nav_type, target.nav_target))
}

/// Parse the current JSON identifier, with a compatibility fallback for
/// notifications delivered by older Fluux versions.
fn parse_identifier(identifier: &str) -> Option<NavTarget> {
    if let Ok(target) = serde_json::from_str(identifier) {
        return Some(target);
    }
    let (nav_type, nav_target) = identifier.split_once(':')?;
    Some(NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
        message_id: None,
        account_id: None,
    })
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "FluuxNotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotificationDelegate {
        // void userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let identifier = response.notification().request().identifier();
            handle_activation(&identifier.to_string());
            completion.call(());
        }

        // void userNotificationCenter:willPresentNotification:withCompletionHandler:
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Show notifications for background chats even while the app is
            // frontmost — the JS layer already decides whether to notify.
            let opts = UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound;
            completion.call((opts,));
        }
    }
);

impl NotificationDelegate {
    fn new() -> Retained<Self> {
        // SAFETY: standard NSObject allocation/init for a defined subclass with
        // no instance variables.
        unsafe { msg_send![super(Self::alloc().set_ivars(())), init] }
    }
}

fn set_delegate() {
    let Some(center) = current_center() else {
        return;
    };
    let delegate = NotificationDelegate::new();
    let proto = ProtocolObject::from_ref(&*delegate);
    center.setDelegate(Some(proto));
    // Keep the delegate alive for the app's lifetime (weak property).
    let _ = DELEGATE.set(delegate);
}

/// Parse the persisted target and hand it to the shared activation dispatcher.
fn handle_activation(identifier: &str) {
    let Some(target) = parse_identifier(identifier) else {
        return;
    };
    super::activate_target(target);
}

pub fn setup(_app: &AppHandle) {
    if !is_bundled() {
        // Common under `tauri dev` (raw `target/debug/fluux`): the notification
        // APIs would abort, so skip them and run without native notifications.
        tracing::warn!("not running from an app bundle; native notifications disabled");
        return;
    }
    set_delegate();
    // Surface the OS prompt early without blocking the main thread. The live
    // status is read later via `authorization_state()`, so the async result of
    // this request is intentionally ignored.
    prime_authorization();
}

pub fn post(n: NativeNotification) -> Result<(), String> {
    let Some(center) = current_center() else {
        return Err("native notifications unavailable (app not bundled)".to_string());
    };
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&n.title));
    content.setBody(&NSString::from_str(&n.body));

    // Attach the contact/room avatar as a thumbnail when a local file path is
    // provided (the JS layer wrote the blob to a temp file).
    if let Some(path) = n.avatar_path.as_deref() {
        use objc2_foundation::{NSArray, NSURL};
        use objc2_user_notifications::UNNotificationAttachment;
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        // SAFETY: `identifier`, `url` are valid for the call; `options` is nil.
        let attachment = unsafe {
            UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(
                &NSString::from_str("avatar"),
                &url,
                None,
            )
        };
        if let Ok(att) = attachment {
            content.setAttachments(&NSArray::from_slice(&[&*att]));
        }
    }

    // Identifier carries the complete JSON navigation target and survives a
    // cold start. The parser retains compatibility with the old
    // "<navType>:<navTarget>" form.
    let identifier = NSString::from_str(&encode_identifier(&n.target));
    let identifier_string = identifier.to_string();
    let group_key = n.target.group_key();
    {
        let mut delivered = DELIVERED_IDS.lock().unwrap_or_else(|e| e.into_inner());
        delivered
            .get_or_insert_with(HashMap::new)
            .entry(group_key)
            .or_default()
            .push(identifier_string);
    }

    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &identifier,
        &content,
        None::<&UNNotificationTrigger>, // nil trigger = deliver immediately
    );
    // Log a rejected enqueue instead of dropping it silently: the OS can refuse
    // a request (bad attachment, authorization revoked mid-session, …) and a
    // silent failure makes the next "no banner" report undiagnosable. The
    // handler runs on a background queue.
    use block2::RcBlock;
    let handler = RcBlock::new(|err: *mut NSError| {
        if let Some(err) = unsafe { err.as_ref() } {
            tracing::warn!(error = ?err, "native notification could not be scheduled");
        }
    });
    center.addNotificationRequest_withCompletionHandler(&request, Some(&handler));
    Ok(())
}

/// Remove already-delivered notifications from Notification Center by their
/// identifiers (see `encode_identifier`). Called when a conversation/room is
/// read so its stale entry disappears. Best-effort: no-op when the process is
/// not app-bundled (`current_center()` returns `None`) or when an identifier
/// has no matching delivered notification.
fn remove_delivered(identifiers: Vec<String>) {
    let Some(center) = current_center() else {
        return;
    };
    use objc2_foundation::NSArray;
    // Keep the NSStrings alive in `ids` while `refs` borrows them for the call.
    let ids: Vec<Retained<NSString>> = identifiers.iter().map(|s| NSString::from_str(s)).collect();
    let refs: Vec<&NSString> = ids.iter().map(|s| &**s).collect();
    let array = NSArray::from_slice(&refs);
    center.removeDeliveredNotificationsWithIdentifiers(&array);
}

pub fn dismiss(nav_type: &str, nav_target: &str, account_id: Option<&str>) -> Result<(), String> {
    let target = NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
        message_id: None,
        account_id: account_id.map(str::to_string),
    };
    let mut identifiers = DELIVERED_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_or_insert_with(HashMap::new)
        .remove(&target.group_key())
        .unwrap_or_default();
    // Also clear the identifier used by pre-routing releases.
    identifiers.push(format!("{nav_type}:{nav_target}"));
    remove_delivered(identifiers);
    Ok(())
}

fn map_status(status: UNAuthorizationStatus) -> AuthState {
    // Provisional/Ephemeral both permit delivery, so treat them as granted.
    if status == UNAuthorizationStatus::Authorized
        || status == UNAuthorizationStatus::Provisional
        || status == UNAuthorizationStatus::Ephemeral
    {
        AuthState::Granted
    } else if status == UNAuthorizationStatus::Denied {
        AuthState::Denied
    } else {
        AuthState::NotDetermined
    }
}

/// Read the live authorization status from the OS. Unlike a cached flag this
/// survives restarts and avoids the startup race where the app connected (and
/// the permission check ran) before any async auth callback had populated
/// in-memory state. The completion handler runs on a background queue, so this
/// blocks briefly for the answer — it MUST run off the main thread (the command
/// wraps it in `spawn_blocking`).
pub fn authorization_state() -> AuthState {
    use block2::RcBlock;
    let Some(center) = current_center() else {
        return AuthState::NotDetermined;
    };
    let (tx, rx) = mpsc::channel::<AuthState>();
    let handler = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
        // SAFETY: the system passes a valid, non-null settings object that is
        // alive for the duration of this callback.
        let status = unsafe { settings.as_ref().authorizationStatus() };
        let _ = tx.send(map_status(status));
    });
    center.getNotificationSettingsWithCompletionHandler(&handler);
    rx.recv_timeout(Duration::from_secs(2))
        .unwrap_or(AuthState::NotDetermined)
}

/// Fire an authorization request without waiting. Used at startup to surface the
/// OS prompt early; the result is read later via `authorization_state()`.
fn prime_authorization() {
    use block2::RcBlock;
    let Some(center) = current_center() else {
        return;
    };
    let options = UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound
        | UNAuthorizationOptions::Badge;
    let handler = RcBlock::new(|_granted: Bool, _err: *mut NSError| {});
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
}

/// Request authorization and wait for the user's decision, returning the real
/// result rather than a pre-callback placeholder. First run shows a system
/// prompt; the completion handler fires on a background queue, so this blocks
/// until the user answers — it MUST run off the main thread (the command wraps
/// it in `spawn_blocking`).
pub fn request_authorization() -> AuthState {
    use block2::RcBlock;
    let Some(center) = current_center() else {
        return AuthState::NotDetermined;
    };
    let options = UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound
        | UNAuthorizationOptions::Badge;
    let (tx, rx) = mpsc::channel::<AuthState>();
    let handler = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
        let _ = tx.send(if granted.as_bool() {
            AuthState::Granted
        } else {
            AuthState::Denied
        });
    });
    center.requestAuthorizationWithOptions_completionHandler(options, &handler);
    // The prompt is user-driven; allow ample time before falling back.
    rx.recv_timeout(Duration::from_secs(300))
        .unwrap_or(AuthState::NotDetermined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_conversation() {
        let t = NavTarget {
            nav_type: "conversation".to_string(),
            nav_target: "alice@example.com".to_string(),
            message_id: Some("message-1".to_string()),
            account_id: Some("me@example.com".to_string()),
        };
        let parsed = parse_identifier(&encode_identifier(&t)).expect("parses");
        assert_eq!(parsed, t);
    }

    #[test]
    fn round_trips_room_bare_jid() {
        let t = NavTarget {
            nav_type: "room".to_string(),
            nav_target: "team@conference.example.com".to_string(),
            message_id: None,
            account_id: None,
        };
        let parsed = parse_identifier(&encode_identifier(&t)).expect("parses");
        assert_eq!(parsed, t);
    }

    #[test]
    fn parses_legacy_identifier_and_splits_on_first_colon_only() {
        // A navTarget containing ':' must be preserved intact (only the first
        // colon delimits navType).
        let parsed = parse_identifier("room:team@host/weird:resource").expect("parses");
        assert_eq!(parsed.nav_type, "room");
        assert_eq!(parsed.nav_target, "team@host/weird:resource");
        assert_eq!(parsed.message_id, None);
        assert_eq!(parsed.account_id, None);
    }

    #[test]
    fn parse_rejects_missing_delimiter() {
        assert!(parse_identifier("no-delimiter-here").is_none());
    }
}
