//! Startup-only policy for the automatic-once startup recovery (FLM-393).
//!
//! No WebKit, network, credential or storage access belongs here. The macOS
//! adapter must supply qualified drawing observations, actual shell readiness,
//! and visibility/power transitions. In particular, snapshot completion is NOT
//! a Drawing::Failed or Drawing::Verified observation by itself. The tests
//! below cover the policy only; the drawing check and the reload are exercised
//! against a real window by the lab app in scripts/lab/startup-recovery.

use std::time::Duration;

#[cfg(all(target_os = "macos", feature = "startup-recovery-lab"))]
pub mod lab;
#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(all(feature = "startup-recovery-lab", feature = "macos-communication-test"))]
compile_error!("startup lab must not enable the signed communication test mode");

pub const ATTEMPT_BUDGET: Duration = Duration::from_secs(20);
include!(concat!(env!("OUT_DIR"), "/startup_cleanup_timeout.rs"));
const CLEANUP_IPC_MARGIN_MS: u64 = 500;
pub const CLEANUP_BUDGET: Duration =
    Duration::from_millis(SDK_DISCONNECT_CLEANUP_MS + CLEANUP_IPC_MARGIN_MS);
pub fn cleanup_within_budget(elapsed: Duration) -> bool {
    elapsed < CLEANUP_BUDGET
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    MissingReadiness,
    RenderingUnavailable,
    RenderingFailed,
    PageTerminated,
    CleanupFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Starting,
    Recovering,
    Usable,
    Controls(Failure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    None,
    /// Adapter must retire the old page/connection before resetting. If bounded
    /// cleanup times out, native code may retire its connections and reload.
    Reset {
        generation: u64,
    },
    /// Native transport retirement must complete before issuing this reload.
    Reload {
        generation: u64,
    },
    Open,
    ShowControls(Failure),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Drawing {
    Verified,
    Failed,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub generation: u64,
    pub sequence: u64,
}

#[derive(Debug)]
pub struct StartupRecovery {
    phase: Phase,
    generation: u64,
    retried: bool,
    elapsed: Duration,
    last_tick: Duration,
    visible_awake: bool,
    ready: bool,
    credential_prompt: bool,
    drawing: Drawing,
    sequence: u64,
    pending: Option<Sample>,
    pending_usable: bool,
    timeout_reset: bool,
}

impl StartupRecovery {
    /// `now` is a monotonic reading, never wall-clock time. Start paused until
    /// the adapter establishes an actually visible, awake, unlocked window.
    pub fn new(now: Duration) -> Self {
        Self {
            phase: Phase::Starting,
            generation: 1,
            retried: false,
            elapsed: Duration::ZERO,
            last_tick: now,
            visible_awake: false,
            ready: false,
            credential_prompt: false,
            drawing: Drawing::Unavailable,
            sequence: 0,
            pending: None,
            pending_usable: false,
            timeout_reset: false,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn elapsed(&self) -> Duration {
        self.elapsed
    }
    pub fn retried(&self) -> bool {
        self.retried
    }

    fn active(&self) -> bool {
        matches!(self.phase, Phase::Starting | Phase::Recovering)
    }

    /// Call on every visibility/power transition, as well as native timer ticks.
    /// Returning to the foreground rebases the clock and invalidates old image
    /// requests; time spent hidden/asleep must not cause recovery.
    pub fn tick(&mut self, now: Duration, visible_awake: bool) -> Action {
        if !self.active() {
            return Action::None;
        }
        self.account_time(now);
        if self.visible_awake != visible_awake {
            self.pending_usable = false;
            self.drawing = Drawing::Unavailable;
        }
        self.visible_awake = visible_awake;
        if !visible_awake || self.credential_prompt || self.elapsed < ATTEMPT_BUDGET {
            return Action::None;
        }
        let failure = if !self.ready {
            Failure::MissingReadiness
        } else {
            match self.drawing {
                Drawing::Failed => Failure::RenderingFailed,
                _ => Failure::RenderingUnavailable,
            }
        };
        if failure == Failure::RenderingFailed && !self.retried {
            self.reset(false)
        } else {
            self.controls(failure)
        }
    }

    /// Page-initiated reloads remain allowed. They retire the old document's
    /// proof but neither spend a native retry nor reset time.
    pub fn page_started(&mut self) {
        if !self.active() {
            return;
        }
        self.generation += 1;
        self.ready = false;
        self.drawing = Drawing::Unavailable;
        // A new document permits abandoning its retired request.
        self.pending = None;
        self.pending_usable = false;
    }

    pub fn shell_ready(&mut self, generation: u64) -> bool {
        if self.active() && generation == self.generation {
            self.ready = true;
            true
        } else {
            false
        }
    }

    fn account_time(&mut self, now: Duration) {
        if self.visible_awake && !self.credential_prompt {
            self.elapsed = self
                .elapsed
                .saturating_add(now.saturating_sub(self.last_tick));
        }
        self.last_tick = now;
    }

    pub fn credential_prompt(&mut self, now: Duration, generation: u64, waiting: bool) {
        if self.active() && generation == self.generation {
            self.account_time(now);
            self.credential_prompt = waiting;
            // A snapshot acquired before the prompt cannot qualify its dismissal.
            self.pending_usable = false;
            self.drawing = Drawing::Unavailable;
        }
    }

    /// Only one request per current document. On timeout call sample_timed_out,
    /// never manufacture Failed or overlap requests before the new page starts.
    /// Adapter must vary the known-pattern sample content with this identity.
    pub fn begin_sample(&mut self) -> Option<Sample> {
        if !self.active()
            || !self.visible_awake
            || !self.ready
            || self.credential_prompt
            || self.pending.is_some()
        {
            return None;
        }
        self.sequence += 1;
        let sample = Sample {
            generation: self.generation,
            sequence: self.sequence,
        };
        self.pending = Some(sample);
        self.pending_usable = true;
        Some(sample)
    }

    pub fn finish_sample(&mut self, now: Duration, sample: Sample, drawing: Drawing) -> Action {
        if !self.active() || self.pending != Some(sample) {
            return Action::None;
        }
        // This callback completed the physical request, even if it is the
        // event that crosses the deadline and starts the next generation.
        self.pending = None;
        // A delayed native timer must not let a late callback open the shell.
        let deadline = self.tick(now, self.visible_awake);
        if deadline != Action::None {
            return deadline;
        }
        if !self.pending_usable || sample.generation != self.generation {
            return Action::None;
        }
        self.drawing = drawing;
        if self.drawing == Drawing::Verified {
            self.phase = Phase::Usable;
            Action::Open
        } else {
            Action::None
        }
    }

    pub fn sample_timed_out(&mut self, sample: Sample) -> Action {
        if self.active() && self.pending == Some(sample) && sample.generation == self.generation {
            if self.retried {
                self.controls(Failure::RenderingUnavailable)
            } else {
                self.reset(true)
            }
        } else {
            Action::None
        }
    }

    /// The adapter must intercept termination BEFORE the runtime reload. Route
    /// its reload through this same budget, not a second automatic-retry loop.
    /// Once usable, leave post-startup behavior to the existing runtime.
    pub fn terminated(&mut self, generation: u64) -> Action {
        if !self.active() || generation != self.generation {
            return Action::None;
        }
        if self.retried {
            self.controls(Failure::PageTerminated)
        } else {
            self.reset(false)
        }
    }

    pub fn cleanup_failed(&mut self, generation: u64) -> Action {
        if self.active() && generation == self.generation {
            self.controls(Failure::CleanupFailed)
        } else {
            Action::None
        }
    }

    /// Only an acknowledgement timeout after a snapshot-timeout reset gets the
    /// reload fallback. Explicit failure stays terminal.
    pub fn cleanup_timed_out(&mut self, generation: u64) -> Action {
        if !self.active() || generation != self.generation {
            return Action::None;
        }
        if self.timeout_reset {
            Action::Reload { generation }
        } else {
            self.cleanup_failed(generation)
        }
    }

    fn reset(&mut self, timeout: bool) -> Action {
        self.timeout_reset = timeout;
        self.retried = true;
        self.generation += 1;
        self.phase = Phase::Recovering;
        self.elapsed = Duration::ZERO;
        self.ready = false;
        // Backend access outlives the retired document.
        self.drawing = Drawing::Unavailable;
        // Own an outstanding request until its callback or the new document
        // starts. Reset alone does not release it.
        self.pending_usable = false;
        Action::Reset {
            generation: self.generation,
        }
    }

    fn controls(&mut self, failure: Failure) -> Action {
        self.phase = Phase::Controls(failure);
        self.pending = None;
        Action::ShowControls(failure)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn seconds(n: u64) -> Duration {
        Duration::from_secs(n)
    }
    fn visible() -> StartupRecovery {
        let mut guard = StartupRecovery::new(Duration::ZERO);
        guard.tick(Duration::ZERO, true);
        guard
    }
    fn observe(guard: &mut StartupRecovery, drawing: Drawing) -> Action {
        guard.shell_ready(guard.generation());
        let sample = guard.begin_sample().unwrap();
        guard.finish_sample(guard.last_tick, sample, drawing)
    }

    // Intent: FLM-393 requires both actual shell readiness and drawing proof.
    #[test]
    fn healthy_shell_opens_only_with_qualified_drawing() {
        let mut guard = visible();
        assert_eq!(guard.begin_sample(), None);
        guard.shell_ready(1);
        assert_eq!(guard.phase(), Phase::Starting);
        assert_eq!(observe(&mut guard, Drawing::Verified), Action::Open);
        assert_eq!(guard.phase(), Phase::Usable);
        assert_eq!(guard.tick(seconds(60), true), Action::None);
        assert_eq!(guard.terminated(1), Action::None);
        assert_eq!(guard.begin_sample(), None);
    }

    // Intent: selected A bounds recovery to 20 + 20 visible awake seconds.
    // Readings follow FLM-389's 3 s helper abandonment and 15 s drawing wait;
    // those earlier milestones must not themselves trigger a reset.
    #[test]
    fn permanent_drawing_failure_uses_one_retry_then_stops() {
        let mut guard = visible();
        observe(&mut guard, Drawing::Failed);
        for reading in [3, 15, 19] {
            assert_eq!(guard.tick(seconds(reading), true), Action::None);
        }
        assert_eq!(
            guard.tick(seconds(20), true),
            Action::Reset { generation: 2 }
        );
        assert!(guard.retried());
        observe(&mut guard, Drawing::Failed);
        assert_eq!(
            guard.tick(seconds(40), true),
            Action::ShowControls(Failure::RenderingFailed)
        );
        assert_eq!(guard.tick(seconds(60), true), Action::None);
        assert_eq!(guard.terminated(2), Action::None);
    }

    // Intent: A may recover a transient drawing failure, without resetting a
    // conversation after it has become usable.
    #[test]
    fn second_attempt_can_open_and_retire_the_guard() {
        let mut guard = visible();
        observe(&mut guard, Drawing::Failed);
        guard.tick(seconds(20), true);
        assert_eq!(observe(&mut guard, Drawing::Verified), Action::Open);
        assert_eq!(guard.tick(seconds(40), true), Action::None);
    }

    // Intent: missing/uncertain proof must not be diagnosed as a graphics hang.
    #[test]
    fn missing_readiness_or_uncertain_rendering_never_resets() {
        let mut missing = visible();
        assert_eq!(
            missing.tick(seconds(20), true),
            Action::ShowControls(Failure::MissingReadiness)
        );
        let mut uncertain = visible();
        observe(&mut uncertain, Drawing::Unavailable);
        assert_eq!(
            uncertain.tick(seconds(20), true),
            Action::ShowControls(Failure::RenderingUnavailable)
        );
    }

    // FLM-403 F4: credential access pauses, rather than exhausts, time.
    #[test]
    fn credential_wait_pauses_time_and_invalidates_inflight_proof() {
        let mut guard = visible();
        guard.shell_ready(1);
        let sample = guard.begin_sample().unwrap();
        guard.credential_prompt(seconds(3), 1, true);
        assert_eq!(
            guard.finish_sample(seconds(15), sample, Drawing::Verified),
            Action::None
        );
        assert_eq!(guard.tick(seconds(60), true), Action::None);
        assert_eq!(guard.elapsed(), seconds(3));
        assert_eq!(guard.begin_sample(), None);
        guard.credential_prompt(seconds(60), 1, false);
        assert_eq!(guard.tick(seconds(76), true), Action::None);
        assert_eq!(guard.elapsed(), seconds(19));
        assert_eq!(observe(&mut guard, Drawing::Verified), Action::Open);
        assert!(!guard.retried());
    }

    // Intent: no overlapping samples or late callback acceptance (FLM-393).
    #[test]
    fn completed_unavailable_sample_cannot_complete_a_new_request() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        assert_eq!(guard.begin_sample(), None);
        guard.finish_sample(guard.last_tick, old, Drawing::Unavailable);
        let new = guard.begin_sample().unwrap();
        assert_ne!(old, new);
        assert_eq!(
            guard.finish_sample(guard.last_tick, old, Drawing::Verified),
            Action::None
        );
        assert_eq!(
            guard.finish_sample(guard.last_tick, new, Drawing::Verified),
            Action::Open
        );
    }

    // FLM-403 F7: a snapshot timeout spends the same one retry.
    #[test]
    fn snapshot_timeout_uses_one_retry_without_overlapping_physical_requests() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        assert_eq!(guard.sample_timed_out(old), Action::Reset { generation: 2 });
        guard.shell_ready(2);
        assert_eq!(guard.begin_sample(), None); // Old API request has not completed.
        assert_eq!(
            guard.finish_sample(seconds(3), old, Drawing::Verified),
            Action::None
        );
        let next = guard.begin_sample().unwrap();
        assert_eq!(
            guard.sample_timed_out(next),
            Action::ShowControls(Failure::RenderingUnavailable)
        );
        assert_eq!(guard.begin_sample(), None);
        assert_eq!(
            guard.finish_sample(seconds(3), next, Drawing::Verified),
            Action::None
        );
    }

    // Intent: a callback delayed beyond the native deadline cannot open chat.
    #[test]
    fn late_success_cannot_bypass_a_delayed_deadline_timer() {
        let mut guard = visible();
        guard.shell_ready(1);
        let sample = guard.begin_sample().unwrap();
        assert_eq!(
            guard.finish_sample(seconds(20), sample, Drawing::Verified),
            Action::ShowControls(Failure::RenderingUnavailable)
        );
    }

    // FLM-403 F3: the completion that crosses the deadline releases the
    // physical request even when the previous failed result causes Reset.
    #[test]
    fn late_callback_reset_releases_the_completed_request_for_retry() {
        let mut guard = visible();
        observe(&mut guard, Drawing::Failed);
        let old = guard.begin_sample().unwrap();
        assert_eq!(
            guard.finish_sample(seconds(20), old, Drawing::Verified),
            Action::Reset { generation: 2 }
        );
        guard.shell_ready(2);
        let next = guard.begin_sample().unwrap();
        assert_eq!(
            guard.finish_sample(seconds(20), next, Drawing::Verified),
            Action::Open
        );
    }

    // FLM-403 F12: page reloads are allowed, but old document proof, the
    // clock and the native retry budget must not be renewed with them.
    #[test]
    fn page_reload_retires_proof_without_resetting_time_or_native_retry() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        guard.tick(seconds(15), true);
        guard.page_started();
        assert_eq!(guard.elapsed(), seconds(15));
        assert_eq!(guard.sample_timed_out(old), Action::None);
        assert!(!guard.retried());
        guard.shell_ready(1);
        assert_eq!(
            guard.finish_sample(seconds(15), old, Drawing::Verified),
            Action::None
        );
        assert_eq!(guard.begin_sample(), None);
        assert_eq!(observe(&mut guard, Drawing::Failed), Action::None);
        assert!(matches!(
            guard.tick(seconds(20), true),
            Action::Reset { .. }
        ));
        guard.tick(seconds(23), true);
        guard.page_started();
        assert!(guard.retried());
        assert_eq!(guard.elapsed(), seconds(3));
    }

    // FLM-403 F7/F12 share the generation invariant: a timeout from the retired
    // request must not terminate a fresh native retry before it can verify.
    #[test]
    fn retired_snapshot_timeout_cannot_end_the_fresh_native_retry() {
        let mut guard = visible();
        observe(&mut guard, Drawing::Failed);
        let old = guard.begin_sample().unwrap();
        assert_eq!(
            guard.tick(seconds(20), true),
            Action::Reset { generation: 2 }
        );
        assert_eq!(guard.sample_timed_out(old), Action::None);
        guard.shell_ready(2);
        assert_eq!(
            guard.finish_sample(seconds(21), old, Drawing::Unavailable),
            Action::None
        );
        let next = guard.begin_sample().unwrap();
        assert_eq!(
            guard.finish_sample(seconds(21), next, Drawing::Verified),
            Action::Open
        );
    }

    // FLM-403 F19: old snapshots may be abandoned only at new-page start,
    // and a late result cannot complete that page's different request.
    #[test]
    fn new_page_abandons_retired_snapshot_and_rejects_late_callback() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        assert_eq!(guard.sample_timed_out(old), Action::Reset { generation: 2 });
        guard.shell_ready(2);
        assert_eq!(guard.begin_sample(), None);
        guard.page_started();
        guard.shell_ready(3);
        let next = guard.begin_sample().unwrap();
        assert_eq!(
            guard.finish_sample(seconds(3), old, Drawing::Verified),
            Action::None
        );
        assert_eq!(
            guard.sample_timed_out(next),
            Action::ShowControls(Failure::RenderingUnavailable)
        );
        assert!(guard.retried());
    }

    // FLM-403 F29: the timeout fallback spends no new retry and ignores stale acks.
    #[test]
    fn only_timeout_reset_allows_cleanup_timeout_reload() {
        let mut guard = visible();
        guard.shell_ready(1);
        let sample = guard.begin_sample().unwrap();
        assert_eq!(
            guard.sample_timed_out(sample),
            Action::Reset { generation: 2 }
        );
        assert_eq!(guard.cleanup_timed_out(1), Action::None);
        assert_eq!(guard.cleanup_timed_out(2), Action::Reload { generation: 2 });
        assert!(guard.retried());
        guard.page_started();
        assert_eq!(guard.cleanup_timed_out(2), Action::None);
        assert_eq!(guard.sample_timed_out(sample), Action::None);
        let mut drawing = visible();
        observe(&mut drawing, Drawing::Failed);
        drawing.tick(seconds(20), true);
        assert_eq!(
            drawing.cleanup_timed_out(2),
            Action::ShowControls(Failure::CleanupFailed)
        );
    }

    // FLM-403 F9: a disconnect using its full SDK bound still has IPC margin.
    #[test]
    fn cleanup_allows_sdk_bound_and_rejects_at_native_deadline() {
        assert!(cleanup_within_budget(Duration::from_millis(
            SDK_DISCONNECT_CLEANUP_MS
        )));
        assert!(!cleanup_within_budget(CLEANUP_BUDGET));
    }

    // Intent: retired page readiness, snapshots and terminations cannot affect
    // the fresh attempt. Reproduce a callback outstanding across termination.
    #[test]
    fn retired_generation_cannot_qualify_or_terminate_new_attempt() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        assert_eq!(guard.terminated(1), Action::Reset { generation: 2 });
        assert!(!guard.shell_ready(1));
        assert_eq!(guard.begin_sample(), None);
        assert_eq!(
            guard.finish_sample(guard.last_tick, old, Drawing::Verified),
            Action::None
        );
        assert_eq!(guard.terminated(1), Action::None);
        assert_eq!(
            guard.terminated(2),
            Action::ShowControls(Failure::PageTerminated)
        );
    }

    // Intent: hiding/minimizing/locking/sleep pauses and rebases native time.
    // These are policy transitions only, not proof of actual OS notifications.
    #[test]
    fn invisible_interval_invalidates_samples_and_does_not_spend_budget() {
        let mut guard = visible();
        guard.shell_ready(1);
        let old = guard.begin_sample().unwrap();
        guard.tick(seconds(3), false);
        guard.tick(seconds(60), false);
        guard.tick(seconds(60), true);
        assert_eq!(guard.elapsed(), seconds(3));
        assert_eq!(guard.begin_sample(), None); // Physical request still owned.
        assert_eq!(
            guard.finish_sample(guard.last_tick, old, Drawing::Verified),
            Action::None
        );
        observe(&mut guard, Drawing::Failed);
        assert_eq!(guard.tick(seconds(76), true), Action::None);
        assert_eq!(
            guard.tick(seconds(77), true),
            Action::Reset { generation: 2 }
        );
    }

    // Intent: bounded cleanup failure must never create a second client.
    #[test]
    fn cleanup_failure_is_terminal() {
        let mut guard = visible();
        guard.terminated(1);
        assert_eq!(guard.cleanup_failed(1), Action::None);
        assert_eq!(
            guard.cleanup_failed(2),
            Action::ShowControls(Failure::CleanupFailed)
        );
        assert_eq!(observe_after_controls(&mut guard), None);
        assert_eq!(guard.terminated(2), Action::None);
    }
    fn observe_after_controls(guard: &mut StartupRecovery) -> Option<Sample> {
        guard.shell_ready(guard.generation());
        guard.begin_sample()
    }
}
