# Modal transparency on machines that cannot blur

## Outcome (added post-merge-review, 2026-07-22)

**The software-rendering probe described in §1 and §2 was implemented, then
removed before merge.** §3's overlay restructure, the panel-fade fix that
followed it, and the light-mode specificity fix all shipped as designed and
are unaffected by this reversal. §1/§2 are kept below as historical record of
the reasoning that led to (and then away from) the probe — not as shipped
design.

**Why it was removed.** The probe's flagship pattern, `swiftshader`, was
disproven by a direct test against the repo's own bundled Chromium:

```
renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)"
verdict:  backdrop-filter DOES paint here
```

SwiftShader is software *GL*; Chromium still composites `backdrop-filter`
through Skia on the CPU regardless. The probe's `classifyRenderer` would have
flattened glass on machines where it demonstrably works. The Mesa patterns
(`llvmpipe`, `softpipe`, `swrast`, `lavapipe`) only matter on Linux, and Linux
already renders `.fluux-glass` solid unconditionally via the
`:root[data-platform="linux"]` gate (§ "Non-goals" above) — the probe had no
platform left where it could fire *and* add value. And per §6's own risk
note, the reporter's screenshots came from a real machine with a real GPU, so
`classifyRenderer` would have returned `'hardware'` there too: the probe was
never going to fire on the one machine it was built for, only on machines
where it was wrong.

**Blast radius the probe would have had.** `npm run screenshots` (Playwright),
the release-blog hero pipeline, and the promo-video capture, along with any
future UX audit, all run headless Chromium — which uses SwiftShader by
default in this sandbox. Left in place, the probe would have silently
flattened glass in every one of those pipelines, shipping flat, blur-free
panels in release marketing images while looking correct in every manual
check on real hardware.

**What DID ship:** the backdrop-root restructure (§3 — panel rendered as a
sibling of `.modal-scrim` instead of a descendant), the restoration of the
panel's own fade after the sibling split, and the light-mode specificity fix
(`:where(.light)` so the light liquid tier can't outrank the
reduced-transparency revert).

**The original Windows symptom (see "Problem" below) therefore remains
unfixed**, pending the maintainer building and testing the restructure on the
affected machine. If the restructure alone does not resolve it there, the
remedy is a Windows-scoped alpha adjustment or a flat tier for Windows,
following the same pattern as §6's fallback for the probe.

---

**Date:** 2026-07-22
**Status:** Approved, ready for planning

## Problem

Modals on Windows are too see-through: chat and settings content reads straight
through the dialog panel. Two screenshots from a Windows build show the
"Créer un chat rapide" and OpenPGP identity-conflict dialogs with legible
background content behind them.

Investigation found **two independent defects**. Conflating them would have
shipped a fix that did not fix the reported problem.

### Defect 1 — the panel's frost has never painted, on any platform

`ModalOverlay` renders the `.fluux-glass` panel as a **child** of the element
carrying `.modal-scrim`, and `.modal-scrim` has `backdrop-filter: blur(10px)`:

```
<div class="fixed inset-0 modal-scrim flex …">   ← scrim AND layout container
  <div class="modal-scrim-aurora" />
  <button class="absolute inset-0" />            ← click-to-dismiss
  <div class="… fluux-glass …">                  ← panel, a DESCENDANT
```

Per the Filter Effects spec an element with `backdrop-filter` forms a **Backdrop
Root** for its descendants, so the panel's own `blur(22px)` samples nothing but
the scrim's flat wash and is effectively discarded. The liquid tier is therefore
**bare translucency with no frost of its own, everywhere including macOS**.

Confirmed empirically in Chromium: a panel nested inside the blurring scrim
leaves background text legible, while an otherwise identical panel rendered as a
*sibling* of the scrim produces a proper smear.

`ui/BottomSheet.tsx` has the identical nesting and the identical defect.

### Defect 2 — the Windows compositor drops `backdrop-filter` entirely

In the reported screenshots the **entire left sidebar** ("Paramètres", "Profil",
"GÉNÉRAL", "Apparence", …) is razor-sharp while sitting underneath
`.modal-scrim`. If the scrim's `blur(10px)` were painting, that content would be
an unreadable smear. The translucency is honoured; the blur is silently dropped.

This is not the reduced-transparency preference — that path renders the panel
opaque, and the panel is visibly translucent.

This is the same failure class as the WebKitGTK problem fixed in `ee7b0cfa`
(#884): `@supports` reports a *capability*, never a rendering guarantee.

**Defect 2 is the cause of the reported complaint. Defect 1 is not** — restoring
a `backdrop-filter` that the compositor refuses to paint changes nothing. Both
are fixed here, but they are separate fixes.

## Non-goals

- **Linux.** The solid revert from #884 stands and its rationale is unchanged.
  Whether Linux still shows excess transparency on a current build is tracked
  separately; no Linux behaviour changes here.
- **Re-tuning the liquid tier.** Initially planned to keep macOS looking as it
  does today. Measurement showed the repaired frost is nearly indistinguishable
  from today on macOS, because the scrim's blur already destroys the backdrop
  before the panel samples it. The tier keeps its current values (40% dark /
  34% light) and macOS is unchanged by construction.
- Surfacing the probe's verdict in the settings UI.

## Design

### 1. Software-rendering probe (removed before merge — see Outcome)

New module `apps/fluux/src/themes/softwareRendering.ts`, split so the decision
logic is pure and testable without a GPU:

```ts
type RendererClass = 'software' | 'hardware' | 'unknown'

/** Pure. Classifies a WebGL UNMASKED_RENDERER_WEBGL string. */
export function classifyRenderer(renderer: string | null): RendererClass

/** Impure, memoized. Creates one throwaway WebGL context, reads the renderer
 *  string, disposes the context, returns classify(...) === 'software'. */
export function detectSoftwareRendering(): boolean
```

Software markers matched case-insensitively against the renderer string:
`swiftshader`, `llvmpipe`, `softpipe`, `lavapipe`, `swrast`, `warp`,
`basic render driver`, `apple software renderer`.

**`'unknown'` counts as hardware.** No WebGL context, a missing
`WEBGL_debug_renderer_info` extension, or a masked string must not flatten
glass — failing open preserves today's behaviour rather than stripping the
effect from every browser that hides its renderer.

The probe runs once per session, memoized, and disposes its context
(`loseContext()`) so it holds no GPU resources.

There is deliberately no attempt to detect whether `backdrop-filter` *painted*.
Composited output cannot be read back from the page; the renderer string is a
proxy, and §6 gates the work on confirming the proxy actually fires.

### 2. Wiring — reuse the existing reduced-wins seam (removed before merge — see Outcome)

No new CSS and no new selectors. The probe feeds `resolveTransparency`
(`apps/fluux/src/themes/transparency.ts`), whose `[data-transparency="reduced"]`
output already flattens `.fluux-glass`, the scrim frost and
`.modal-scrim-aurora`. This is the same seam the Pure theme uses.

**Precedence:** the probe ORs into the same slot as the OS
`prefers-reduced-transparency` query, so it decides only in `'system'` mode
(the default):

| Setting | Probe: software | Probe: hardware |
| --- | --- | --- |
| `system` (default) | reduced | follows OS query |
| `full` | **full** — user override wins | full |
| `reduced` | reduced | reduced |

An explicit "Full" therefore remains an escape hatch if the probe
false-positives on a machine that composites correctly. A theme-forced
`reduced` keeps winning over everything, unchanged.

`useTheme` passes the probe result into `resolveTransparency` alongside the
existing inputs.

### 3. Overlay restructure

Split the two jobs the scrim element currently does — layout and frost — so the
panel stops being a descendant of a backdrop root:

```
<div class="fixed inset-0 flex … z-50">              ← layout only, no filter
  <div class="absolute inset-0 modal-scrim {scrimClass}">   ← scrim + frost + fade
    <div class="modal-scrim-aurora" />
  </div>
  <button class="absolute inset-0" />                ← click-to-dismiss
  <div ref={panelRef} class="relative z-10 fluux-glass">    ← now a SIBLING
```

`scrimClass` (the `scrim-in` / `scrim-out` opacity fade) moves onto the scrim
layer. As a sibling rather than an ancestor its transient `opacity < 1` can no
longer form a backdrop root over the panel either.

`ui/BottomSheet.tsx` gets the same split.

Consequences:
- The panel's `blur(22px)` composites on top of the scrim's `blur(10px)` — a
  second live backdrop-filter that today is computed and thrown away. Modals are
  transient, and Linux is unaffected (panel blur is already `none` there), but it
  is a real cost and not free.
- `.modal-scrim-aurora` begins genuinely refracting through the panel, which is
  what its comment already claims it does.

`modalGlass.test.ts` restricts the glass literals to these two primitive files;
the restructure keeps both literals in place and stays compatible.

### 4. Tests

- `classifyRenderer` — table tests over real renderer strings, covering
  SwiftShader, llvmpipe, Microsoft Basic Render Driver, a normal hardware ANGLE
  string, `null`, and an unrecognised string. Asserts `'unknown'` → not flattened.
- `resolveTransparency` — the full precedence table above, including that
  explicit `full` beats a software verdict and that theme-forced `reduced` still
  wins.
- **Structural guard** — a new **DOM** test, `ModalOverlay.backdroproot.test.tsx`.
  Renders `ModalOverlay` and `BottomSheet` in jsdom and asserts
  `scrimEl.contains(panelEl) === false` for each, where `scrimEl` is the
  `.modal-scrim` element and `panelEl` the `.fluux-glass` panel. Defect 1 is
  silent: nothing errors, the frost just dies. Without this guard the next
  wrapper `<div>` reintroduces it invisibly.

  This deliberately does **not** live in `modalGlass.test.ts`, which reads
  component files as *source text* to police where the glass literals appear.
  Descendancy is a DOM relationship and cannot be expressed by string matching;
  the two guards are complementary and both stay.

Every one of these gets a **deliberate-break check**: introduce the exact
regression, confirm the test FAILS, revert, confirm green. Review alone has
never caught a hollow test in this codebase.

### 5. Files touched

| File | Change |
| --- | --- |
| `themes/softwareRendering.ts` | new — probe + pure classifier |
| `themes/softwareRendering.test.ts` | new — classifier table tests |
| `themes/transparency.ts` | new reduced-wins input |
| `themes/transparency.test.ts` | precedence table |
| `hooks/useTheme.ts` | pass probe result into `resolveTransparency` |
| `components/ModalOverlay.tsx` | scrim/layout split |
| `components/ui/BottomSheet.tsx` | scrim/layout split |
| `components/ModalOverlay.backdroproot.test.tsx` | new — DOM nesting guard |

No CSS changes.

### 6. Verification gate

**The probe must be confirmed to fire on the Windows machine from the
screenshots before this merges.** If WebView2 there reports a plausible hardware
renderer while still refusing to composite `backdrop-filter`, the probe is
useless on the one machine it was built for.

If it does not fire, the fallback is to gate Windows onto the flat tier the way
Linux is gated, and this spec needs revisiting.

**Risk revised upward during implementation.** The screenshots were captured
from a **real machine through JetKVM** (HDMI capture plus compression), not a
virtual machine as originally assumed. Two consequences:

- The **diagnosis is unaffected**. Compression can soften an image or add
  artifacts; it cannot sharpen one. The sidebar under `.modal-scrim` arrived
  legible, so it was at least that legible on the physical panel, and the scrim's
  blur is genuinely not painting.
- The **probe's premise is weaker**. A real machine driving real HDMI almost
  certainly has a real GPU, which reports a real renderer string —
  `classifyRenderer` returns `'hardware'`, the probe returns `false`, and glass
  stays on. WebGL and compositing are separate subsystems in Chromium: WebGL can
  be hardware-accelerated while compositing, which is what `backdrop-filter`
  actually depends on, is not. In that configuration the probe reads the wrong
  subsystem and cannot detect the fault.

The probe remains correct where it fires — a genuinely software-rendered box,
including the WebKitGTK class — so it is not wasted work. But this gate is now
the likely outcome rather than a remote risk, and §3's restructure is the part of
this change expected to stand on its own.

Additional verification:

- Deliberate-break check on each new test (§4).
- macOS: open a modal before and after the restructure and confirm no
  perceptible change.
- Accessibility → transparency: `full` / `reduced` / `system` all still behave,
  and `full` overrides a software verdict.
- `npm test`, `npm run typecheck`, and the linter clean before commit.

## Follow-ups (not in this PR)

- Verify on a current Linux build whether modals still read as too transparent,
  and if so diagnose separately — the #884 revert should already make them solid.
- Consider whether the probe should also relax the hardcoded
  `data-platform="linux"` CSS gate, once there is evidence about what WebKitGTK
  reports as its renderer.
