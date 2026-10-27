//! macOS spike: registers with APNs from a signed build and records what the
//! signature allows. tao 0.37.2's app delegate defines no remote-notification
//! methods, so they are added at runtime, as iOS PushPlugin.swift does.
//!
//! Inert unless the signature carries a push entitlement, and always logs to
//! `push-spike.jsonl` in the app log directory so quit and sleep trials get
//! exact delivery times.

use objc2::runtime::{AnyObject, Sel};
use objc2::{msg_send, sel, MainThreadMarker};
use objc2_app_kit::NSApplication;
use objc2_foundation::NSArray;
use objc2_user_notifications::{UNNotification, UNUserNotificationCenter};
use std::ffi::{c_char, c_void, CStr, CString};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTaskCreateFromSelf(allocator: *const c_void) -> *const c_void;
    fn SecTaskCopyValueForEntitlement(
        task: *const c_void,
        entitlement: *const c_void,
        error: *mut *const c_void,
    ) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFStringCreateWithCString(
        allocator: *const c_void,
        value: *const c_char,
        encoding: u32,
    ) -> *const c_void;
    fn CFGetTypeID(value: *const c_void) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: *const c_void) -> bool;
    fn CFStringGetCString(
        value: *const c_void,
        buffer: *mut c_char,
        size: isize,
        encoding: u32,
    ) -> bool;
    fn CFRelease(value: *const c_void);
}

#[link(name = "objc")]
extern "C" {
    fn class_addMethod(
        class: *const c_void,
        name: Sel,
        imp: *const c_void,
        types: *const c_char,
    ) -> bool;
    fn object_getClass(object: *const c_void) -> *const c_void;
}

const UTF8: u32 = 0x0800_0100;

enum Entitlement {
    Missing,
    Text(String),
    Flag(bool),
}

/// Reads one entitlement from this process's own signature.
fn entitlement(key: &str) -> Entitlement {
    let key = CString::new(key).expect("entitlement keys have no NUL");
    unsafe {
        let task = SecTaskCreateFromSelf(std::ptr::null());
        if task.is_null() {
            return Entitlement::Missing;
        }
        let name = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
        let value = SecTaskCopyValueForEntitlement(task, name, std::ptr::null_mut());
        let result = if value.is_null() {
            Entitlement::Missing
        } else if CFGetTypeID(value) == CFStringGetTypeID() {
            let mut buffer = [0 as c_char; 256];
            if CFStringGetCString(value, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) {
                Entitlement::Text(CStr::from_ptr(buffer.as_ptr()).to_string_lossy().into_owned())
            } else {
                Entitlement::Missing
            }
        } else if CFGetTypeID(value) == CFBooleanGetTypeID() {
            Entitlement::Flag(CFBooleanGetValue(value))
        } else {
            Entitlement::Missing
        };
        if !value.is_null() {
            CFRelease(value);
        }
        CFRelease(name);
        CFRelease(task);
        result
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// `development` or `production`; absent when the signature has no push entitlement.
    push_environment: Option<String>,
    sandboxed: bool,
}

/// What this build may do, read from its own signature.
pub fn capabilities() -> Capabilities {
    let push_environment = match entitlement("com.apple.developer.aps-environment") {
        Entitlement::Text(value) => Some(value),
        _ => None,
    };
    let sandboxed = matches!(entitlement("com.apple.security.app-sandbox"), Entitlement::Flag(true));
    Capabilities { push_environment, sandboxed }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    token: String,
    environment: String,
}

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static RESULT: Mutex<Option<Result<Registration, String>>> = Mutex::new(None);
static RESULT_READY: Condvar = Condvar::new();

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn log(event: &str, detail: serde_json::Value) {
    let Some(path) = LOG_PATH.get() else { return };
    let line = serde_json::json!({"atMs": now_ms(), "event": event, "detail": detail});
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn publish(result: Result<Registration, String>) {
    log("registration", match &result {
        Ok(r) => serde_json::json!({"token": r.token, "environment": r.environment}),
        Err(e) => serde_json::json!({"error": e}),
    });
    *RESULT.lock().unwrap() = Some(result);
    RESULT_READY.notify_all();
}

extern "C" fn did_register(_this: *mut AnyObject, _cmd: Sel, _app: *mut AnyObject, data: *mut AnyObject) {
    let (bytes, length): (*const u8, usize) =
        unsafe { (msg_send![&*data, bytes], msg_send![&*data, length]) };
    let token: String = unsafe { std::slice::from_raw_parts(bytes, length) }
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let environment = capabilities().push_environment.unwrap_or_else(|| "unknown".into());
    publish(Ok(Registration { token, environment }));
}

extern "C" fn did_fail(_this: *mut AnyObject, _cmd: Sel, _app: *mut AnyObject, error: *mut AnyObject) {
    let description: *mut AnyObject = unsafe { msg_send![&*error, localizedDescription] };
    let text = unsafe { CStr::from_ptr(msg_send![&*description, UTF8String]) }
        .to_string_lossy()
        .into_owned();
    publish(Err(text));
}

extern "C" fn did_receive(_this: *mut AnyObject, _cmd: Sel, _app: *mut AnyObject, _info: *mut AnyObject) {
    log("remote-notification-while-running", serde_json::json!({}));
}

/// Adds the three callbacks to the delegate Tauri installed. Adding a method
/// that already exists fails harmlessly, so this runs once per registration.
fn install_callbacks(mtm: MainThreadMarker) -> Result<(), String> {
    let app = NSApplication::sharedApplication(mtm);
    let delegate = app.delegate().ok_or("no application delegate")?;
    let object = &*delegate as *const _ as *const c_void;
    let class = unsafe { object_getClass(object) };
    let methods: [(Sel, *const c_void); 3] = [
        (sel!(application:didRegisterForRemoteNotificationsWithDeviceToken:), did_register as *const c_void),
        (sel!(application:didFailToRegisterForRemoteNotificationsWithError:), did_fail as *const c_void),
        (sel!(application:didReceiveRemoteNotification:), did_receive as *const c_void),
    ];
    for (selector, imp) in methods {
        unsafe { class_addMethod(class, selector, imp, c"v@:@@".as_ptr()) };
    }
    Ok(())
}

fn request_registration(mtm: MainThreadMarker) {
    match install_callbacks(mtm) {
        Ok(()) => {
            let app = NSApplication::sharedApplication(mtm);
            app.registerForRemoteNotifications();
        }
        Err(e) => publish(Err(e)),
    }
}

/// Records every notification Notification Center still holds, with its
/// delivery date, so quit and sleep trials get exact times at next launch.
fn log_delivered() {
    if objc2_foundation::NSBundle::mainBundle().bundleIdentifier().is_none() {
        return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let block = block2::RcBlock::new(|delivered: std::ptr::NonNull<NSArray<UNNotification>>| {
        for item in unsafe { delivered.as_ref() }.iter() {
            let date = item.date().timeIntervalSince1970();
            let content = item.request().content();
            log("delivered", serde_json::json!({
                "id": item.request().identifier().to_string(),
                "deliveredAtMs": (date * 1000.0) as u64,
                "title": content.title().to_string(),
                "body": content.body().to_string(),
            }));
        }
    });
    center.getDeliveredNotificationsWithCompletionHandler(&block);
}

#[tauri::command]
fn capabilities_command() -> Capabilities {
    capabilities()
}

#[tauri::command]
async fn register<R: Runtime>(app: tauri::AppHandle<R>) -> Result<Registration, String> {
    if capabilities().push_environment.is_none() {
        return Err("This build has no push entitlement".into());
    }
    *RESULT.lock().unwrap() = None;
    app.run_on_main_thread(|| {
        if let Some(mtm) = MainThreadMarker::new() {
            request_registration(mtm);
        }
    })
    .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(|| {
        let guard = RESULT.lock().unwrap();
        let (guard, _) = RESULT_READY
            .wait_timeout_while(guard, Duration::from_secs(30), |r| r.is_none())
            .unwrap();
        guard.clone().unwrap_or_else(|| Err("APNs registration timed out".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("push")
        .invoke_handler(tauri::generate_handler![register, capabilities_command])
        .setup(|app, _api| {
            let caps = capabilities();
            if caps.push_environment.is_some() {
                if let Ok(dir) = app.path().app_log_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = LOG_PATH.set(dir.join("push-spike.jsonl"));
                }
                log("launch", serde_json::to_value(&caps).unwrap_or_default());
                log_delivered();
            }
            Ok(())
        })
        .build()
}
