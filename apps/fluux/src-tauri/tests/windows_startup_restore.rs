//! Native regression for #1820, startup half: a window-state file holding the
//! 144 x 19 sliver is restored by the real plugin into a real Tauri window,
//! and the startup repair brings the window back to a usable size. Runs only
//! on Windows (the `rust-windows` CI job), alone in its process because it
//! owns a WebView2 window.
#![cfg(target_os = "windows")]

#[allow(dead_code)]
#[path = "../src/window_behavior.rs"]
mod window_behavior;

use std::io::Write;
use tauri::Manager;

/// Progress marker that survives a crash: it bypasses the test output capture.
fn stage(message: &str) {
    let _ = writeln!(std::io::stderr(), "[startup-restore] {message}");
}

/// Removes the throwaway app directories, also when the test panics.
struct DisposableAppDirs(Vec<std::path::PathBuf>);

impl Drop for DisposableAppDirs {
    fn drop(&mut self) {
        for dir in &self.0 {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// #1820 recovery through the real startup path: the window-state plugin
/// restores a saved 144 x 19 sliver into a real Tauri window built from
/// tauri.conf.json, then the startup repair runs on it. The app gets a unique
/// identifier, which moves both its config directory (where the plugin reads
/// the state file) and its WebView2 profile away from Fluux's own.
#[test]
#[allow(deprecated)]
fn saved_sliver_is_repaired_by_the_startup_restore() {
    let identifier = format!("net.processone.fluux.test1820.{}", std::process::id());
    let roaming = std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"));
    let local = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA"));
    let config_dir = roaming.join(&identifier);
    let _cleanup = DisposableAppDirs(vec![config_dir.clone(), local.join(&identifier)]);

    // The plugin reads the state while the app is being built, so the file
    // goes in first. It is the shape of the file reported in #1820, at 100%
    // scaling.
    std::fs::create_dir_all(&config_dir).unwrap();
    std::fs::write(
        config_dir.join(".window-state.json"),
        r#"{"main":{"width":144,"height":19,"x":100,"y":100,"prev_x":100,"prev_y":100,
            "maximized":false,"visible":true,"decorated":false,"fullscreen":false}}"#,
    )
    .unwrap();

    stage("state file written");
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = identifier;
    let mut app = tauri::Builder::default()
        .any_thread()
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(window_behavior::persisted_window_state())
                .build(),
        )
        .build(context)
        .expect("build app");

    let pump = |app: &mut tauri::App| {
        for _ in 0..20 {
            app.run_iteration(|_, _| {});
        }
    };
    stage("app built");
    pump(&mut app);
    stage("startup pumped");

    let window = app.get_webview_window("main").expect("main window");
    let logical = |w: &tauri::WebviewWindow| {
        let scale = w.scale_factor().unwrap();
        let size = w.inner_size().unwrap().to_logical::<f64>(scale);
        (size.width, size.height)
    };
    let (w, h) = logical(&window);
    stage(&format!("restored size: {w} x {h}"));
    assert!(
        window_behavior::saved_size_is_unusable(w, h, false, false),
        "the plugin did not restore the saved sliver ({w} x {h}), so this run proves nothing"
    );

    window_behavior::reset_unusable_window_size(&window);
    pump(&mut app);

    let (w, h) = logical(&window);
    stage(&format!("size after repair: {w} x {h}"));
    // Skip the WebView2 teardown, which is not what this test is about.
    std::mem::forget(window);
    std::mem::forget(app);
    assert!(
        !window_behavior::saved_size_is_unusable(w, h, false, false),
        "window still a sliver after startup repair: {w} x {h}"
    );
}
