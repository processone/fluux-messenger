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
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};

/// App handle for emitting `notification-activated` from the delegate.
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Target stashed when a click fires before the webview is ready (cold start).
static PENDING_TARGET: Mutex<Option<NavTarget>> = Mutex::new(None);

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

/// Parse "<navType>:<navTarget>" and route it. Emits to the webview if one is
/// ready, otherwise stashes for the startup drain (cold start).
fn handle_activation(identifier: &str) {
    let Some((nav_type, nav_target)) = identifier.split_once(':') else {
        return;
    };
    let target = NavTarget {
        nav_type: nav_type.to_string(),
        nav_target: nav_target.to_string(),
    };

    let app = APP_HANDLE.get();
    let window = app.and_then(|a| a.get_webview_window("main"));

    if let Some(win) = &window {
        let _ = win.show();
        let _ = win.set_focus();
    }

    match app {
        Some(a) if window.is_some() => {
            let _ = a.emit("notification-activated", target);
        }
        _ => {
            *PENDING_TARGET.lock().unwrap() = Some(target);
        }
    }
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
