//! Connect Hickory's Android system resolver to Tauri's Java application context.

use std::sync::OnceLock;
use tauri::Manager;

pub(super) async fn initialize_dns_context(app: &tauri::AppHandle) -> Result<(), String> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    if let Some(result) = INITIALIZED.get() {
        return result.clone();
    }
    let webview = app
        .get_webview_window("main")
        .ok_or("Missing main webview")?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = INITIALIZED.get_or_init(|| {
                    let mut initialize = || {
                        let vm = env.get_java_vm()?;
                        let context = env
                            .call_method(
                                activity,
                                "getApplicationContext",
                                "()Landroid/content/Context;",
                                &[],
                            )?
                            .l()?;
                        let context = env.new_global_ref(context)?;
                        // Hickory may resolve on worker threads for the process's
                        // lifetime. Retain the application (not Activity) globally.
                        let context = Box::leak(Box::new(context));
                        // SAFETY: OnceLock serializes the only initializer. Both
                        // pointers stay valid for the process lifetime, and proxy
                        // DNS work starts only after this callback completes.
                        unsafe {
                            ndk_context::initialize_android_context(
                                vm.get_java_vm_pointer().cast(),
                                context.as_obj().as_raw().cast(),
                            );
                        }
                        Ok::<(), tauri::Error>(())
                    };
                    initialize()
                        .map_err(|e| format!("Android DNS context initialization failed: {e}"))
                });
                let _ = tx.send(result.clone());
            });
        })
        .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|e| format!("Android DNS context callback failed: {e}"))?
}
