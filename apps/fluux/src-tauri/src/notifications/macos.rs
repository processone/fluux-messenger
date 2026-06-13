//! macOS native notifications via `UNUserNotificationCenter`.

use crate::notifications::backend::{AuthState, NativeNotification, NavTarget};
use objc2::rc::Retained;
use objc2::runtime::Bool;
use objc2_foundation::{NSError, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotificationRequest,
    UNNotificationTrigger, UNUserNotificationCenter,
};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::AppHandle;

/// App handle for emitting `notification-activated` from the delegate.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Target stashed when a click fires before the webview is ready (cold start).
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

/// Cached authorization state. 0 = NotDetermined, 1 = Granted, 2 = Denied.
/// Set by the async authorization callback.
static AUTH: AtomicU8 = AtomicU8::new(0);

/// The system notification center. Always valid inside a bundled app.
fn current_center() -> Retained<UNUserNotificationCenter> {
    UNUserNotificationCenter::currentNotificationCenter()
}

pub fn setup(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
    // NOTE: the delegate (click routing / foreground presentation) is wired up
    // in a later task. Here we only store the handle and request authorization.
    request_authorization();
}

pub fn post(n: NativeNotification) -> Result<(), String> {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&n.title));
    content.setBody(&NSString::from_str(&n.body));

    // Identifier carries the nav target and survives cold start.
    // Format: "<navType>:<navTarget>" — navType has no ':'; navTarget is a
    // bare JID. Parsed on the FIRST ':' (later task) so JIDs are safe.
    // (A later task attaches n.avatar_path here.)
    let identifier = NSString::from_str(&format!("{}:{}", n.target.nav_type, n.target.nav_target));

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
