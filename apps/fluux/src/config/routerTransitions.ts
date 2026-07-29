/**
 * Whether React Router may wrap its own location updates in `React.startTransition`.
 *
 * Left at its default (`undefined` → enabled), the router commits a location
 * change at transition priority. The Zustand store writes that accompany a
 * navigation are urgent, so a Conversations/Rooms rail switch through
 * `useViewNavigation.navigateToView` — which clears the outgoing tab's active
 * id, starts any incoming hydrating activation, then navigates — is torn across
 * two commits. When an item is restored, that activation also flags the
 * incoming store's `activationPending`:
 *
 *   1. urgent: stores updated, `useLocation()` still on the OLD route
 *   2. transition: location catches up
 *
 * Frame 1 is painted. Anything that cross-references the route against store
 * state reads a stale view there. `ChatLayout`'s `activationHoldsMainPane`
 * checks that the in-flight activation belongs to the tab we are on, so in
 * frame 1 it sees `sidebarView === 'messages'` next to
 * `roomActivationPending === true`, decides no activation is holding the pane,
 * and falls through to the empty-state hero — a one-frame flash of the tab the
 * user just left during an affected restored-content switch.
 *
 * Disabling transitions makes the location update urgent, so it batches with
 * the store writes into a single commit and the torn frame never exists.
 * Nothing here depends on transitions: every route renders the same
 * `<ChatLayout />` element, and the lazy views inside own explicit Suspense
 * fallbacks that we *want* shown while they load.
 *
 * Shared by the app and demo entry points and by the regression test, so the
 * test pins the behaviour the app actually ships.
 */
export const ROUTER_USE_TRANSITIONS = false
