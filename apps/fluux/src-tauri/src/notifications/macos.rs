//! macOS native notifications via `UNUserNotificationCenter`.

use crate::notifications::backend::{AuthState, NativeNotification, NavTarget};
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread};
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationTrigger, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

/// App handle for emitting `notification-activated` from the delegate.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Target stashed when a click fires before the webview is ready (cold start).
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

/// Whether the JS `notification-activated` listener is attached. Set by the JS
/// layer via `set_notification_listener_ready` once its `listen()` resolves.
static LISTENER_READY: AtomicBool = AtomicBool::new(false);

/// Cached authorization state. 0 = NotDetermined, 1 = Granted, 2 = Denied.
/// Set by the async authorization callback.
static AUTH: AtomicU8 = AtomicU8::new(0);

/// Keeps the notification-center delegate alive for the app's lifetime.
/// `setDelegate:` stores it as a weak reference, so we must own it here.
static DELEGATE: OnceLock<Retained<NotificationDelegate>> = OnceLock::new();

/// The system notification center. Always valid inside a bundled app.
fn current_center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
}

/// Encode a nav target into a notification identifier. The identifier survives
/// cold start (the OS persists it), so the click handler can recover the target
/// without any in-memory state. Format: "<navType>:<navTarget>" — navType never
/// contains ':'; navTarget is a bare JID.
fn encode_identifier(target: &NavTarget) -> String {
    format!("{}:{}", target.nav_type, target.nav_target)
}

/// Parse an identifier produced by `encode_identifier`. Splits on the FIRST ':'
/// only, so a navTarget that itself contains ':' is preserved intact. Returns
/// `None` if there is no delimiter.
fn parse_identifier(identifier: &str) -> Option<NavTarget> {
    let (nav_type, nav_target) = identifier.split_once(':')?;
    Some(NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
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
    let delegate = NotificationDelegate::new();
    let proto = ProtocolObject::from_ref(&*delegate);
    current_center().setDelegate(Some(proto));
    // Keep the delegate alive for the app's lifetime (weak property).
    let _ = DELEGATE.set(delegate);
}

/// Mark whether the JS `notification-activated` listener is attached. Called by
/// the JS layer once its `listen()` has resolved, and reset to false on unmount.
pub fn set_listener_ready(ready: bool) {
    LISTENER_READY.store(ready, Ordering::SeqCst);
}

/// Parse "<navType>:<navTarget>" and route it. Emits to the webview if the JS
/// listener is attached, otherwise stashes for the startup drain (cold start).
fn handle_activation(identifier: &str) {
    let Some(target) = parse_identifier(identifier) else {
        return;
    };

    let app = APP_HANDLE.get();

    // Always bring the window forward on a click.
    if let Some(win) = app.and_then(|a| a.get_webview_window("main")) {
        let _ = win.show();
        let _ = win.set_focus();
    }

    // Emit only if the JS listener is attached; otherwise stash for the
    // startup drain. On a cold start the delegate fires before the React
    // bundle has registered its listener, so the "main" window existing is
    // NOT a reliable readiness signal — the explicit flag is.
    if LISTENER_READY.load(Ordering::SeqCst) {
        if let Some(a) = app {
            let _ = a.emit("notification-activated", target);
            return;
        }
    }
    *PENDING_TARGET.lock().unwrap() = Some(target);
}

pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    set_delegate();
    request_authorization();
}

pub fn post(n: NativeNotification) -> Result<(), String> {
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

    // Identifier carries the nav target and survives cold start.
    // Format: "<navType>:<navTarget>" — navType has no ':'; navTarget is a
    // bare JID. Parsed on the FIRST ':' so JIDs are safe.
    let identifier = NSString::from_str(&encode_identifier(&n.target));

    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
        &identifier,
        &content,
        None::<&UNNotificationTrigger>, // nil trigger = deliver immediately
    );
    current_center().addNotificationRequest_withCompletionHandler(&request, None);
    Ok(())
}

pub fn authorization_state() -> AuthState {
    match AUTH.load(Ordering::SeqCst) {
        1 => AuthState::Granted,
        2 => AuthState::Denied,
        _ => AuthState::NotDetermined,
    }
}

pub fn request_authorization() -> AuthState {
    use block2::RcBlock;
    let options = UNAuthorizationOptions::Alert
        | UNAuthorizationOptions::Sound
        | UNAuthorizationOptions::Badge;
    // The completion handler is a heap-allocated `RcBlock` whose closure only
    // touches a `'static` atomic; the center copies the block.
    let handler = RcBlock::new(|granted: Bool, _err: *mut NSError| {
        AUTH.store(if granted.as_bool() { 1 } else { 2 }, Ordering::SeqCst);
    });
    current_center().requestAuthorizationWithOptions_completionHandler(options, &handler);
    // The callback is async; return the currently-known state. Callers re-poll
    // `authorization_state()` after the OS prompt resolves.
    authorization_state()
}

pub fn take_pending_target() -> Option<NavTarget> {
    PENDING_TARGET.lock().unwrap().take()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_conversation() {
        let t = NavTarget {
            nav_type: "conversation".to_string(),
            nav_target: "alice@example.com".to_string(),
        };
        let parsed = parse_identifier(&encode_identifier(&t)).expect("parses");
        assert_eq!(parsed.nav_type, "conversation");
        assert_eq!(parsed.nav_target, "alice@example.com");
    }

    #[test]
    fn round_trips_room_bare_jid() {
        let t = NavTarget {
            nav_type: "room".to_string(),
            nav_target: "team@conference.example.com".to_string(),
        };
        let parsed = parse_identifier(&encode_identifier(&t)).expect("parses");
        assert_eq!(parsed.nav_type, "room");
        assert_eq!(parsed.nav_target, "team@conference.example.com");
    }

    #[test]
    fn parse_splits_on_first_colon_only() {
        // A navTarget containing ':' must be preserved intact (only the first
        // colon delimits navType).
        let parsed = parse_identifier("room:team@host/weird:resource").expect("parses");
        assert_eq!(parsed.nav_type, "room");
        assert_eq!(parsed.nav_target, "team@host/weird:resource");
    }

    #[test]
    fn parse_rejects_missing_delimiter() {
        assert!(parse_identifier("no-delimiter-here").is_none());
    }
}
