//! Native regression for #1820: Show desktop minimizes Fluux without sending
//! WM_SYSCOMMAND, so tao does not record the window as minimized. Hiding it to
//! the tray then rewrote its style without WS_MINIMIZE and it came back as a
//! sliver. Runs only on Windows (the `rust-windows` CI job); the real windows
//! are created and minimized by the OS, not simulated.
#![cfg(target_os = "windows")]

#[allow(dead_code)]
#[path = "../src/window_behavior.rs"]
mod window_behavior;

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
