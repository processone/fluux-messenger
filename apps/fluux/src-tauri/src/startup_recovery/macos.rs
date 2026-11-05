//! AppKit bridge. Policy stays in the parent module; Cocoa stays in macos/.
//! This module turns adapter events into policy calls and policy actions into
//! adapter calls. The drawing check and the reload themselves are exercised by
//! the disposable lab app in scripts/lab/startup-recovery, not by unit tests.
use super::{cleanup_within_budget, Action, Drawing, Phase, Sample, StartupRecovery};
use std::{
    collections::VecDeque,
    ffi::{c_char, c_void, CString},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

// This package also has a mobile library: build-script link-lib flags target
// that library, so the desktop binary/test target must name its archive too.
#[link(name = "fluux_startup", kind = "static")]
extern "C" {
    fn fluux_startup_install(webview: *mut c_void, event: extern "C" fn(i32, u64, u64, i32, u64));
    fn fluux_startup_sample(generation: u64, sample: u64);
    fn fluux_startup_present(state: i32);
    fn fluux_startup_reload();
    fn fluux_startup_page_started(generation: u64);
    fn fluux_startup_copy(diagnostics: *const c_char);
}

struct Session {
    app: tauri::AppHandle,
    webview: usize,
    clock: Instant,
    policy: StartupRecovery,
    cleanup: Option<(u64, Instant)>,
    diagnostics: Diagnostics,
    credential_accesses: usize,
}
static SESSION: OnceLock<Mutex<Session>> = OnceLock::new();

fn rgb(pixel: u32) -> String {
    if pixel == u32::MAX {
        return "unavailable".to_owned();
    }
    format!(
        "({},{},{})",
        (pixel >> 16) & 255,
        (pixel >> 8) & 255,
        pixel & 255
    )
}

enum DiagnosticKind {
    Event,
    Sample,
    Eligibility,
}
const ELIGIBILITY_DIAGNOSTICS_LIMIT: usize = 8;

#[derive(Default)]
struct Diagnostics {
    events: VecDeque<String>,
    samples: VecDeque<String>,
    eligibility: VecDeque<String>,
}
impl Diagnostics {
    fn record(&mut self, line: String, kind: DiagnosticKind) {
        let (lines, limit) = match kind {
            DiagnosticKind::Sample => (&mut self.samples, 4),
            DiagnosticKind::Event => (&mut self.events, 64),
            DiagnosticKind::Eligibility => (&mut self.eligibility, ELIGIBILITY_DIAGNOSTICS_LIMIT),
        };
        if lines.len() == limit {
            lines.pop_front();
        }
        lines.push_back(line);
    }
    fn text(&self) -> String {
        format!(
            "{}\nRecent samples:\n{}\nRecent eligibility:\n{}",
            self.events.iter().cloned().collect::<Vec<_>>().join("\n"),
            self.samples.iter().cloned().collect::<Vec<_>>().join("\n"),
            self.eligibility
                .iter()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        )
    }
}
fn record(session: &mut Session, event: &str, kind: DiagnosticKind) {
    let line = format!(
        "{}ms attempt={} generation={} elapsed={}ms retry={} {event}",
        session.clock.elapsed().as_millis(),
        1 + u8::from(session.policy.retried()),
        session.policy.generation(),
        session.policy.elapsed().as_millis(),
        session.policy.retried()
    );
    tracing::info!("startup recovery: {line}");
    session.diagnostics.record(line, kind);
}
// Mirror the adapter's failure mask; log all changing causes, not just the
// eligible boolean, without changing policy time or qualification.
fn eligibility_milestone(failures: i32) -> String {
    let reasons = [
        (1, "hidden"),
        (2, "miniaturized"),
        (4, "occluded"),
        (8, "asleep"),
        (16, "locked"),
        (32, "invisible"),
    ]
    .into_iter()
    .filter_map(|(bit, name)| (failures & bit != 0).then_some(name))
    .collect::<Vec<_>>()
    .join(",");
    format!(
        "eligibility eligible={} reasons={}",
        failures == 0,
        if reasons.is_empty() { "none" } else { &reasons }
    )
}

fn milestone(session: &mut Session, event: &str) {
    record(session, event, DiagnosticKind::Event);
}

// Reset policy and native status from the same backend access count.
fn recovery_status(policy: &mut StartupRecovery, now: Duration, accesses: usize) -> i32 {
    let generation = policy.generation();
    policy.credential_prompt(now, generation, accesses > 0);
    if accesses > 0 {
        4
    } else {
        1
    }
}

// Never keep the policy mutex while calling AppKit or emitting a frontend event.
// Both can synchronously reenter the bridge on the main thread.
fn apply(action: Action) {
    match action {
        Action::None => {}
        Action::Reload { generation } => retire_and_reload(generation),
        Action::Open => unsafe { fluux_startup_present(0) },
        Action::ShowControls(_) => {
            if let Some(state) = SESSION.get() {
                state.lock().unwrap().cleanup = None;
            }
            unsafe {
                fluux_startup_present(2);
            }
        }
        Action::Reset { generation } => {
            let (app, status) = {
                let mut session = SESSION.get().unwrap().lock().unwrap();
                session.cleanup = Some((generation, Instant::now()));
                let now = session.clock.elapsed();
                let accesses = session.credential_accesses;
                let status = recovery_status(&mut session.policy, now, accesses);
                (session.app.clone(), status)
            };
            unsafe {
                fluux_startup_present(status);
            }
            // Prefer bounded SDK cleanup. The acknowledgement-timeout fallback
            // retires native loopback/server transports before reload without
            // depending on JS.
            let _ = app.emit_to("main", "startup-recovery-cleanup", generation);
        }
    }
}

// Connection retirement is owned by the native proxy layer, not the page.
// Validate the generation again on the main thread after the asynchronous join.
fn retire_and_reload(generation: u64) {
    let Some(state) = SESSION.get() else { return };
    let app = state.lock().unwrap().app.clone();
    tauri::async_runtime::spawn(async move {
        let retired = crate::xmpp_proxy::retire_for_page_reload().await;
        let _ = app.run_on_main_thread(move || {
            let Some(state) = SESSION.get() else { return };
            let action = {
                let mut session = state.lock().unwrap();
                if session.policy.generation() != generation
                    || session.policy.phase() != Phase::Recovering
                {
                    return;
                }
                if retired.is_ok() {
                    milestone(&mut session, "native-transports-retired-reload");
                    Action::Reload { generation }
                } else {
                    milestone(&mut session, "native-transport-retirement-failed");
                    session.policy.cleanup_failed(generation)
                }
            };
            if matches!(action, Action::Reload { .. }) {
                unsafe {
                    fluux_startup_reload();
                }
            } else {
                apply(action);
            }
        });
    });
}

extern "C" fn event(kind: i32, generation: u64, sequence: u64, value: i32, pixels: u64) {
    let Some(state) = SESSION.get() else { return };
    let (action, sample, app, diagnostics) = {
        let mut session = state.lock().unwrap();
        let now = session.clock.elapsed();
        let action = match kind {
            1 => {
                let deadline = session.policy.tick(now, value != 0);
                if deadline != Action::None {
                    deadline
                } else if let Some((generation, started)) = session.cleanup {
                    if !cleanup_within_budget(started.elapsed()) {
                        session.cleanup = None;
                        milestone(&mut session, "cleanup-ack-timeout");
                        session.policy.cleanup_timed_out(generation)
                    } else {
                        Action::None
                    }
                } else {
                    Action::None
                }
            }
            2 => session.policy.finish_sample(
                now,
                Sample {
                    generation,
                    sequence,
                },
                match value {
                    0 => Drawing::Verified,
                    1 => Drawing::Failed,
                    _ => Drawing::Unavailable,
                },
            ),
            3 => session.policy.sample_timed_out(Sample {
                generation,
                sequence,
            }),
            _ => Action::None,
        };
        if kind == 2 {
            record(
                &mut session,
                &format!("sampleGeneration={generation} sample={sequence} expectedRGB={} observedRGB={} {}",
                    rgb((pixels >> 32) as u32), rgb(pixels as u32),
                    match value { 0 => "drawing-match", 1 => "drawing-mismatch", _ => "drawing-unavailable" }),
                DiagnosticKind::Sample,
            );
        }
        if kind == 7 {
            record(
                &mut session,
                &eligibility_milestone(value),
                DiagnosticKind::Eligibility,
            );
        }
        if kind == 3 {
            milestone(&mut session, "drawing-timeout");
        }
        if action != Action::None {
            milestone(&mut session, &format!("{action:?}"));
        }
        let sample = if kind == 1 && session.cleanup.is_none() && action == Action::None {
            session.policy.begin_sample()
        } else {
            None
        };
        if let Some(sample) = sample {
            record(
                &mut session,
                &format!(
                    "sample-requested sampleGeneration={} sample={}",
                    sample.generation, sample.sequence
                ),
                DiagnosticKind::Sample,
            );
        }
        let diagnostics = if kind == 5 {
            Some(format!(
                "Fluux {}\nStartup recovery\nstate={:?}\n{}\n",
                env!("CARGO_PKG_VERSION"),
                session.policy.phase(),
                session.diagnostics.text()
            ))
        } else {
            None
        };
        (action, sample, session.app.clone(), diagnostics)
    };
    apply(action);
    if let Some(sample) = sample {
        unsafe {
            fluux_startup_sample(sample.generation, sample.sequence);
        }
    }
    match kind {
        4 => app.restart(),
        5 => {
            if let Some(text) = diagnostics.and_then(|text| CString::new(text).ok()) {
                unsafe {
                    fluux_startup_copy(text.as_ptr());
                }
            }
        }
        6 => app.exit(0),
        _ => {}
    }
}

pub fn install(app: &tauri::AppHandle) -> tauri::Result<()> {
    wry::set_fluux_startup_termination_gate(fluux_startup_consumes_termination);
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let app = app.clone();
    window.with_webview(move |view| {
        let ptr = view.inner();
        let _ = SESSION.set(Mutex::new(Session {
            app,
            webview: ptr as usize,
            clock: Instant::now(),
            policy: StartupRecovery::new(Duration::ZERO),
            cleanup: None,
            diagnostics: Diagnostics::default(),
            credential_accesses: 0,
        }));
        unsafe {
            fluux_startup_install(ptr, event);
        }
    })
}

/// Observe backend access lifetime; the secrets backend knows nothing about
/// startup policy or UI. main.rs owns registration of this adapter callback.
pub fn credential_access_changed(pending: bool) {
    if let Some(state) = SESSION.get() {
        let app = {
            let mut session = state.lock().unwrap();
            if pending {
                session.credential_accesses += 1;
            } else {
                session.credential_accesses = session.credential_accesses.saturating_sub(1);
            }
            let generation = session.policy.generation();
            let now = session.clock.elapsed();
            let waiting = session.credential_accesses > 0;
            session.policy.credential_prompt(now, generation, waiting);
            milestone(
                &mut session,
                if waiting {
                    "credential-access-pending"
                } else {
                    "credential-access-complete"
                },
            );
            session.app.clone()
        };
        credential_status(app);
    }
}
fn credential_status(app: tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| {
        let Some(state) = SESSION.get() else { return };
        let session = state.lock().unwrap();
        let status = match session.policy.phase() {
            Phase::Starting | Phase::Recovering if session.credential_accesses > 0 => 4,
            Phase::Starting => 5,
            Phase::Recovering => 1,
            _ => return,
        };
        drop(session);
        unsafe {
            fluux_startup_present(status);
        }
    });
}

pub fn page_started(label: &str) {
    if label != "main" {
        return;
    }
    if let Some(state) = SESSION.get() {
        let app = state.lock().unwrap().app.clone();
        let _ = app.run_on_main_thread(|| {
            let Some(state) = SESSION.get() else { return };
            let generation = {
                let mut session = state.lock().unwrap();
                session.policy.page_started();
                session.cleanup = None;
                milestone(&mut session, "page-started-retired-snapshot");
                session.policy.generation()
            };
            // Only a new document releases ownership of an unreturned old
            // request. Old native callbacks must not touch the new one.
            crate::xmpp_proxy::page_started();
            unsafe {
                fluux_startup_page_started(generation);
            }
        });
    }
}

#[tauri::command]
pub fn startup_attempt(window: tauri::WebviewWindow) -> Option<u64> {
    if window.label() != "main" {
        return None;
    }
    SESSION.get().and_then(|state| {
        let session = state.lock().unwrap();
        if session.cleanup.is_none()
            && matches!(session.policy.phase(), Phase::Starting | Phase::Recovering)
        {
            Some(session.policy.generation())
        } else {
            None
        }
    })
}

#[tauri::command]
pub fn startup_shell_ready(window: tauri::WebviewWindow, generation: u64) {
    if window.label() != "main" {
        return;
    }
    if let Some(state) = SESSION.get() {
        let mut session = state.lock().unwrap();
        if session.policy.shell_ready(generation) {
            milestone(&mut session, "shell-ready");
        } else {
            milestone(&mut session, "shell-ready-ignored");
        }
    }
}

#[tauri::command]
pub fn startup_cleanup_complete(window: tauri::WebviewWindow, generation: u64, succeeded: bool) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle().clone();
    let _ = app.run_on_main_thread(move || {
        let Some(state) = SESSION.get() else { return };
        let action = {
            let mut session = state.lock().unwrap();
            let Some((pending, started)) = session.cleanup else {
                return;
            };
            if generation != pending || session.policy.phase() != Phase::Recovering {
                return;
            }
            session.cleanup = None;
            if succeeded && cleanup_within_budget(started.elapsed()) {
                milestone(&mut session, "client-retired-reload");
                Action::Reload { generation }
            } else if !cleanup_within_budget(started.elapsed()) {
                session.policy.cleanup_timed_out(generation)
            } else {
                session.policy.cleanup_failed(generation)
            }
        };
        apply(action);
    });
}

/// Narrow vendored-Wry hook: preserve its delegate and runtime termination
/// behavior once startup is usable. During startup consume the same retry budget
/// before Wry/Tauri can perform their otherwise unbounded default reload.
extern "C" fn fluux_startup_consumes_termination(webview: *mut c_void) -> bool {
    let Some(state) = SESSION.get() else {
        return false;
    };
    let (action, consumed, status) = {
        let mut session = state.lock().unwrap();
        if session.webview != webview as usize {
            return false;
        }
        if session.policy.phase() == Phase::Usable {
            return false;
        }
        let generation = session.policy.generation();
        let action = session.policy.terminated(generation);
        milestone(&mut session, "webcontent-terminated");
        let now = session.clock.elapsed();
        let accesses = session.credential_accesses;
        let status = if matches!(action, Action::Reset { .. }) {
            recovery_status(&mut session.policy, now, accesses)
        } else {
            1
        };
        (action, true, status)
    };
    // The page is dead: its JS cannot acknowledge disconnect, and no page
    // connection can remain usable. Retire the page by reload without spawning
    // another view. This is the runtime's existing supported termination reset.
    if matches!(action, Action::Reset { .. }) {
        unsafe {
            fluux_startup_present(status);
        }
        if let Action::Reset { generation } = action {
            retire_and_reload(generation);
        }
    } else {
        apply(action);
    }
    consumed
}

#[cfg(test)]
mod tests {
    use std::ffi::c_void;
    #[repr(C)]
    struct RequestClock {
        elapsed: f64,
        last_tick: f64,
        eligible: bool,
    }
    extern "C" {
        fn fluux_startup_request_clock_advance(clock: *mut RequestClock, now: f64, eligible: bool);
        fn fluux_startup_pattern_rgb(generation: u64, sequence: u64) -> u32;
        fn fluux_startup_compare_snapshot(
            image: *mut c_void,
            expected: u32,
            observed: *mut u32,
            space_name: *mut std::ffi::c_char,
            capacity: usize,
        ) -> i32;
    }

    // FLM-403 F42: actual C mask + formatter expose every AppKit eligibility cause.
    #[test]
    fn native_eligibility_reasons_report_each_failure_and_recovery() {
        extern "C" {
            fn fluux_startup_eligibility_failures(
                hidden: bool,
                visible: bool,
                miniaturized: bool,
                occluded: bool,
                asleep: bool,
                locked: bool,
            ) -> u32;
        }
        for (values, expected) in [
            ([false, true, false, false, false, false], "eligibility eligible=true reasons=none"),
            ([true, true, false, false, false, false], "eligibility eligible=false reasons=hidden"),
            ([false, true, true, false, false, false], "eligibility eligible=false reasons=miniaturized"),
            ([false, true, false, true, false, false], "eligibility eligible=false reasons=occluded"),
            ([false, true, false, false, true, false], "eligibility eligible=false reasons=asleep"),
            ([false, true, false, false, false, true], "eligibility eligible=false reasons=locked"),
            ([false, false, false, false, false, false], "eligibility eligible=false reasons=invisible"),
            ([true, false, true, true, true, true], "eligibility eligible=false reasons=hidden,miniaturized,occluded,asleep,locked,invisible"),
        ] {
            let [h, v, m, o, a, l] = values;
            let failures = unsafe { fluux_startup_eligibility_failures(h, v, m, o, a, l) };
            assert_eq!(super::eligibility_milestone(failures as i32), expected);
        }
    }

    // FLM-403 F19: execute the actual callback identity gate used by both native stages.
    #[test]
    fn native_callback_identity_rejects_retired_request_after_new_page() {
        extern "C" {
            fn fluux_startup_request_matches(
                pending: bool,
                active_generation: u64,
                active_sequence: u64,
                generation: u64,
                sequence: u64,
            ) -> bool;
        }
        unsafe {
            assert!(fluux_startup_request_matches(true, 1, 1, 1, 1));
            assert!(!fluux_startup_request_matches(false, 3, 0, 1, 1));
            assert!(!fluux_startup_request_matches(true, 3, 2, 1, 1));
            assert!(fluux_startup_request_matches(true, 3, 2, 3, 2));
        }
    }

    // FLM-403 F18: real sample traffic must not evict transitions from copied text.
    #[test]
    fn copied_diagnostics_preserve_reset_cleanup_and_final_failure_after_sample_traffic() {
        let mut log = super::Diagnostics::default();
        log.record("shell-ready".into(), super::DiagnosticKind::Event);
        for _ in 0..200 {
            log.record("drawing-mismatch".into(), super::DiagnosticKind::Sample);
        }
        for event in [
            "Reset",
            "client-retired-reload",
            "drawing-timeout",
            "ShowControls",
        ] {
            log.record(event.into(), super::DiagnosticKind::Event);
        }
        let copy = log.text();
        for event in [
            "shell-ready",
            "Reset",
            "client-retired-reload",
            "drawing-timeout",
            "ShowControls",
        ] {
            assert!(copy.contains(event));
        }
        assert_eq!(log.samples.len(), 4);
    }

    // FLM-403 F46: switching visibility must not evict the recovery chain from Copy diagnostics.
    #[test]
    fn copied_diagnostics_keep_recovery_chain_after_eligibility_traffic() {
        let mut log = super::Diagnostics::default();
        let chain = [
            "credential-access-pending",
            "page-started-retired-snapshot",
            "shell-ready",
            "Reset",
        ];
        for event in chain {
            log.record(event.into(), super::DiagnosticKind::Event);
        }
        for index in 0..200 {
            log.record(
                super::eligibility_milestone(if index % 2 == 0 { 4 } else { 0 }),
                super::DiagnosticKind::Eligibility,
            );
        }
        let copy = log.text();
        for event in chain {
            assert!(copy.lines().any(|line| line == event));
        }
        assert_eq!(log.eligibility.len(), super::ELIGIBILITY_DIAGNOSTICS_LIMIT);
        assert_eq!(log.events.len(), chain.len());
        assert!(copy.contains("Recent eligibility:"));
    }

    // FLM-403 F21: backend access survives a termination reset and pauses attempt 2.
    #[test]
    fn reset_reapplies_pending_access_to_policy_and_native_status() {
        use super::super::{Action, StartupRecovery};
        use std::time::Duration;
        let mut policy = StartupRecovery::new(Duration::ZERO);
        policy.tick(Duration::ZERO, true);
        policy.credential_prompt(Duration::from_secs(3), 1, true);
        assert_eq!(policy.terminated(1), Action::Reset { generation: 2 });
        assert_eq!(
            super::recovery_status(&mut policy, Duration::from_secs(10), 1),
            4
        );
        policy.tick(Duration::from_secs(60), true);
        assert_eq!(policy.elapsed(), Duration::ZERO);
        assert_eq!(
            super::recovery_status(&mut policy, Duration::from_secs(60), 0),
            1
        );
        policy.tick(Duration::from_secs(62), true);
        assert_eq!(policy.elapsed(), Duration::from_secs(2));
    }

    // FLM-403 F6: exercise the actual adapter clock, not a duplicate Rust model.
    #[test]
    fn native_snapshot_age_excludes_ineligible_interval() {
        let mut clock = RequestClock {
            elapsed: 0.0,
            last_tick: 0.0,
            eligible: true,
        };
        unsafe {
            fluux_startup_request_clock_advance(&mut clock, 1.0, true);
            fluux_startup_request_clock_advance(&mut clock, 1.0, false);
            fluux_startup_request_clock_advance(&mut clock, 15.0, false);
            assert_eq!(clock.elapsed, 1.0);
            fluux_startup_request_clock_advance(&mut clock, 15.0, true);
            assert_eq!(clock.elapsed, 1.0);
            fluux_startup_request_clock_advance(&mut clock, 17.0, true);
            assert_eq!(clock.elapsed, 3.0);
        }
    }

    // FLM-403 F22: the real NSImage-to-RGB path, using CGImage-backed opaque
    // bytes of a known pattern. No app or window runs.
    #[test]
    fn native_snapshot_reads_known_srgb_and_device_bytes_without_tiff_relabeling() {
        use objc2::{class, msg_send, rc::Retained, runtime::AnyObject};
        use objc2_foundation::NSSize;
        use std::ffi::CStr;
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            static kCGColorSpaceSRGB: *const c_void;
            fn CGColorSpaceCreateWithName(name: *const c_void) -> *mut c_void;
            fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
            fn CGColorSpaceRelease(space: *mut c_void);
            fn CGBitmapContextCreate(
                data: *mut c_void,
                width: usize,
                height: usize,
                bits: usize,
                row: usize,
                space: *mut c_void,
                info: u32,
            ) -> *mut c_void;
            fn CGBitmapContextCreateImage(context: *mut c_void) -> *mut c_void;
            fn CGContextRelease(context: *mut c_void);
            fn CGImageRelease(image: *mut c_void);
        }
        unsafe {
            for device in [false, true] {
                let expected = fluux_startup_pattern_rgb(2, 1);
                let mut pixels = [0_u8; 36];
                for pixel in pixels.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
                pixels[16..20].copy_from_slice(&[
                    (expected >> 16) as u8,
                    (expected >> 8) as u8,
                    expected as u8,
                    255,
                ]);
                let space = if device {
                    CGColorSpaceCreateDeviceRGB()
                } else {
                    CGColorSpaceCreateWithName(kCGColorSpaceSRGB)
                };
                let context = CGBitmapContextCreate(
                    pixels.as_mut_ptr().cast(),
                    3,
                    3,
                    8,
                    12,
                    space,
                    (4 << 12) | 1,
                );
                assert!(!context.is_null());
                let cg = CGBitmapContextCreateImage(context);
                assert!(!cg.is_null());
                let allocated: *mut AnyObject = msg_send![class!(NSImage), alloc];
                let initialized: *mut AnyObject =
                    msg_send![allocated, initWithCGImage: cg, size: NSSize::new(3.0, 3.0)];
                let image = Retained::from_raw(initialized).expect("CGImage-backed NSImage");
                CGImageRelease(cg);
                CGContextRelease(context);
                CGColorSpaceRelease(space);
                let mut observed = u32::MAX;
                let mut name = [0; 128];
                assert_eq!(
                    fluux_startup_compare_snapshot(
                        (&*image as *const AnyObject).cast_mut().cast(),
                        expected,
                        &mut observed,
                        name.as_mut_ptr(),
                        name.len()
                    ),
                    0
                );
                assert_eq!(observed, expected);
                assert!(!CStr::from_ptr(name.as_ptr()).to_bytes().is_empty());
                assert_eq!(
                    fluux_startup_compare_snapshot(
                        (&*image as *const AnyObject).cast_mut().cast(),
                        fluux_startup_pattern_rgb(2, 2),
                        &mut observed,
                        name.as_mut_ptr(),
                        name.len()
                    ),
                    1
                );
            }
            let mut observed = 0;
            let mut name = [0; 128];
            assert_eq!(
                fluux_startup_compare_snapshot(
                    std::ptr::null_mut(),
                    0,
                    &mut observed,
                    name.as_mut_ptr(),
                    name.len()
                ),
                2
            );
            assert_eq!(observed, u32::MAX);
        }
    }
}
