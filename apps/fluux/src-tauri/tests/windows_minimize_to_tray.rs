//! Native regression for #1820: Show desktop minimizes Fluux without sending
//! WM_SYSCOMMAND, so tao does not record the window as minimized. Hiding it to
//! the tray then rewrote its style without WS_MINIMIZE and it came back as a
//! sliver. Runs only on Windows (the `rust-windows` CI job); the real windows
//! are created and minimized by the OS, not simulated.
#![cfg(target_os = "windows")]

#[allow(dead_code)]
#[path = "../src/window_behavior.rs"]
mod window_behavior;

use tauri::Manager;
use std::sync::atomic::{AtomicBool, Ordering};
use tao::dpi::{LogicalSize, PhysicalSize};
use tao::event_loop::{EventLoop, EventLoopBuilder};
use tao::platform::windows::{EventLoopBuilderExtWindows, WindowExtWindows};
use tao::window::{Window, WindowBuilder};
use window_behavior::{should_hide_on_minimize, WindowBehavior};

const SW_MINIMIZE: i32 = 6;
const SW_RESTORE: i32 = 9;

#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn IsIconic(hwnd: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
}

fn is_iconic(window: &Window) -> bool {
    unsafe { IsIconic(window.hwnd() as isize) != 0 }
}

fn is_visible(window: &Window) -> bool {
    unsafe { IsWindowVisible(window.hwnd() as isize) != 0 }
}

/// Minimize from outside the app, as Show desktop and minimize-all do: a plain
/// ShowWindow call, no WM_SYSCOMMAND.
fn minimize_from_outside(window: &Window) {
    unsafe { ShowWindow(window.hwnd() as isize, SW_MINIMIZE) };
    assert!(is_iconic(window), "the external minimize did not take");
}

/// Fluux's window as the app creates it: frameless, 1000 x 700, 360 x 600 minimum.
fn fluux_window() -> (EventLoop<()>, Window) {
    let event_loop = EventLoopBuilder::new().with_any_thread(true).build();
    let window = WindowBuilder::new()
        .with_decorations(false)
        .with_inner_size(LogicalSize::new(1000.0, 700.0))
        .with_min_inner_size(LogicalSize::new(360.0, 600.0))
        .build(&event_loop)
        .expect("create window");
    assert!(is_visible(&window));
    (event_loop, window)
}

/// What `WindowEvent::Resized` does in main.rs for a minimized window.
fn on_resized(window: &Window, behavior: &WindowBehavior, tray_available: bool, hidden: &AtomicBool) {
    if should_hide_on_minimize(
        behavior.keep_in_tray(),
        tray_available,
        window.is_minimized(),
        hidden.load(Ordering::Relaxed),
    ) {
        hidden.store(true, Ordering::Relaxed);
        window.set_minimized(true);
        window.set_visible(false);
    }
}

#[test]
fn show_desktop_with_tray_on_hides_the_window_and_restores_it_unchanged() {
    let (_event_loop, window) = fluux_window();
    let size_before: PhysicalSize<u32> = window.inner_size();
    let behavior = WindowBehavior::default();
    assert!(behavior.keep_in_tray());
    let hidden = AtomicBool::new(false);

    minimize_from_outside(&window);
    on_resized(&window, &behavior, true, &hidden);

    assert!(hidden.load(Ordering::Relaxed), "the window went to the tray");
    assert!(!is_visible(&window));
    assert!(
        is_iconic(&window),
        "hiding dropped the minimized state, so the tray restore shows a sliver"
    );

    // The tray's Show.
    window.set_visible(true);
    unsafe { ShowWindow(window.hwnd() as isize, SW_RESTORE) };
    assert!(!is_iconic(&window));
    assert!(is_visible(&window));
    assert_eq!(window.inner_size(), size_before, "geometry changed");
}

#[test]
fn show_desktop_with_tray_off_leaves_the_window_on_the_taskbar() {
    let (_event_loop, window) = fluux_window();
    let behavior = WindowBehavior::default();
    behavior.set_keep_in_tray(false);
    let hidden = AtomicBool::new(false);

    minimize_from_outside(&window);
    on_resized(&window, &behavior, true, &hidden);

    assert!(!hidden.load(Ordering::Relaxed));
    assert!(is_visible(&window), "a minimized window stays on the taskbar");
    assert!(is_iconic(&window));
}

#[test]
fn show_desktop_without_a_tray_leaves_the_window_on_the_taskbar() {
    let (_event_loop, window) = fluux_window();
    let behavior = WindowBehavior::default();
    let hidden = AtomicBool::new(false);

    minimize_from_outside(&window);
    on_resized(&window, &behavior, false, &hidden);

    assert!(!hidden.load(Ordering::Relaxed));
    assert!(is_visible(&window));
    assert!(is_iconic(&window));
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
    pump(&mut app);

    let window = app.get_webview_window("main").expect("main window");
    let logical = |w: &tauri::WebviewWindow| {
        let scale = w.scale_factor().unwrap();
        let size = w.inner_size().unwrap().to_logical::<f64>(scale);
        (size.width, size.height)
    };
    let (w, h) = logical(&window);
    assert!(
        window_behavior::saved_size_is_unusable(w, h, false, false),
        "the plugin did not restore the saved sliver ({w} x {h}), so this run proves nothing"
    );

    window_behavior::reset_unusable_window_size(&window);
    pump(&mut app);

    let (w, h) = logical(&window);
    assert!(
        !window_behavior::saved_size_is_unusable(w, h, false, false),
        "window still a sliver after startup repair: {w} x {h}"
    );
}
