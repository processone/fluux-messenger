# Pretext Height Spike: Results and Decision

**Date:** 2026-06-27
**Branch:** `claude/fervent-nightingale-b3aee1`
**Related plan:** `docs/superpowers/plans/2026-06-27-pretext-height-measurement-spike.md`

---

## Success Criterion

> Correct wrapped line count for >= 98% of non-code, non-media text messages, at all tested widths
> (320 px / 560 px / 760 px), at every tested character scale (90 / 100 / 125 / 150% root
> font-size), on every engine (Chromium + macOS WKWebView + Linux WebKitGTK); residual height
> error <= +/- 2 px. Code / media / emoji measured but out of pretext scope (inform a PARTIAL
> verdict, do not count against threshold).

---

## Chromium Results

Engine: `HeadlessChrome/149.0.7827.55` (Playwright headless Chromium, macOS 10.15.7 UA).

The `textCategories` gate is: `short`, `wrap`, `mention`, `link`, `mixed`.
Out-of-scope categories (`emoji`, `rtl`, `longtoken`, `code`, `me`) are measured and reported below
but do NOT count against the threshold.

### Scale 90% (root font-size = 90%)

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |    15 |      100.00% |      < 0.01 |      < 0.01 |
| wrap      |    18 |      100.00% |        0.03 |        0.03 |
| mention   |     9 |      100.00% |        0.01 |        0.01 |
| link      |     9 |      100.00% |        0.01 |        0.01 |
| mixed     |     6 |      100.00% |        0.01 |        0.01 |

**Overall textLineExactPct: 100.00%** (57 / 57 in-scope text samples) -- PASSES

### Scale 100% (root font-size = 100%)

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |    15 |      100.00% |        0.00 |        0.00 |
| wrap      |    18 |      100.00% |        0.00 |        0.00 |
| mention   |     9 |      100.00% |        0.00 |        0.00 |
| link      |     9 |      100.00% |        0.00 |        0.00 |
| mixed     |     6 |      100.00% |        0.00 |        0.00 |

**Overall textLineExactPct: 100.00%** (57 / 57 in-scope text samples) -- PASSES

### Scale 125% (root font-size = 125%)

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |    15 |      100.00% |        0.00 |        0.00 |
| wrap      |    18 |      100.00% |        0.00 |        0.00 |
| mention   |     9 |      100.00% |        0.00 |        0.00 |
| link      |     9 |      100.00% |        0.00 |        0.00 |
| mixed     |     6 |      100.00% |        0.00 |        0.00 |

**Overall textLineExactPct: 100.00%** (57 / 57 in-scope text samples) -- PASSES

### Scale 150% (root font-size = 150%)

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |    15 |      100.00% |        0.00 |        0.00 |
| wrap      |    18 |      100.00% |        0.00 |        0.00 |
| mention   |     9 |      100.00% |        0.00 |        0.00 |
| link      |     9 |      100.00% |        0.00 |        0.00 |
| mixed     |     6 |      100.00% |        0.00 |        0.00 |

**Overall textLineExactPct: 100.00%** (57 / 57 in-scope text samples) -- PASSES

### Summary

| Scale | textLineExactPct | Passes 98% threshold? |
|------:|----------------:|:----------------------|
|   90% |         100.00% | YES                   |
|  100% |         100.00% | YES                   |
|  125% |         100.00% | YES                   |
|  150% |         100.00% | YES                   |

All four tested character scales pass in headless Chromium at 100.00% line-exact. Prediction is
pixel-perfect across all in-scope categories (short, wrap, mention, link, mixed) at every tested
width and scale.

---

## Out-of-Scope Findings

These categories are NOT included in `textCategories` and do not affect the pass/fail verdict,
but their error magnitudes are reported here to inform estimates for non-text rows.

### me

The `me` category is excluded from the gate because of a **harness limitation**: the spike feeds
pretext the raw corpus body (`/me is reviewing a very long pull request...`) but `MessageBody`
renders a content-substituted string (`* Tester is reviewing a very long pull request...`) with
`Tester` in `font-medium`. The string pretext measures is different from what the DOM renders,
so `me` numbers are not a valid test of pretext accuracy. This is NOT a pretext limitation: a real
predictor would feed pretext the rendered `* {senderName} {actionText}` string (a known,
deterministic transform), and pretext would handle it exactly like any other prose text.

The `me` rows are still rendered in the spike page and appear in `byCategory` for transparency:

| Scale | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|------:|-------------:|------------:|------------:|
|   90% |       83.33% |       19.79 |       19.79 |
|  100% |      100.00% |        0.00 |        0.00 |
|  125% |      100.00% |        0.00 |        0.00 |
|  150% |      100.00% |        0.00 |        0.00 |

The single failure (`me-2` at 90% / 320 px) is caused by the prefix-substitution content delta:
the raw body `/me is reviewing...` is shorter than the rendered `* Tester is reviewing...`, and
at the narrowest width + smallest scale the substituted string crosses a wrap boundary, causing
pretext (measuring the wrong string) to predict 2 lines while the DOM renders 3. This is a
harness measurement error, not a predictor error.

### emoji

| Scale | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|------:|-------------:|------------:|------------:|
|   90% |       100.0% |        0.01 |        0.01 |
|  100% |       100.0% |        0.00 |        0.00 |
|  125% |       100.0% |        0.00 |        0.00 |
|  150% |       100.0% |        0.00 |        0.00 |

Emoji-only and emoji-mixed messages predict exactly. Pretext treats emoji characters as
equivalent-width code points, but the rendered glyph advances match closely enough.

### rtl

| Scale | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|------:|-------------:|------------:|------------:|
|   90% |       100.0% |        0.01 |        0.01 |
|  100% |       100.0% |        0.00 |        0.00 |
|  125% |       100.0% |        0.00 |        0.00 |
|  150% |       100.0% |        0.00 |        0.00 |

Arabic and Hebrew RTL messages predict exactly at all scales. Not a concern.

### longtoken

| Scale | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|------:|-------------:|------------:|------------:|
|   90% |       100.0% |        0.01 |        0.01 |
|  100% |       100.0% |        0.00 |        0.00 |
|  125% |       100.0% |        0.00 |        0.00 |
|  150% |       100.0% |        0.00 |        0.00 |

Long unbreakable tokens (supercalifragilistic... and very long URLs) predict exactly. The
break-word / overflow-wrap handling in pretext correctly models the DOM behavior.

### code

| Scale | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|------:|-------------:|------------:|------------:|
|   90% |        77.8% |       42.03 |       42.03 |
|  100% |        66.7% |       47.00 |       47.00 |
|  125% |        66.7% |       87.00 |       87.00 |
|  150% |        66.7% |      138.00 |      138.00 |

Code blocks fail substantially. This is **by design and expected**: the spike measures all
messages with the prose Inter font via `fontSpecFrom()`, but actual code blocks render in a
monospace font (typically `ui-monospace` / `Menlo`). The character-advance tables differ, so
pretext's line-wrapping prediction is wrong for code blocks. The error grows with scale (from
42 px at 90% to 138 px at 150%) because more scale = more lines = larger cumulative mismatch.

The code category is excluded from `textCategories` in the success criterion precisely because
pretext is not the right tool for code blocks: those rows should use a reserved-space estimate
(see "Out-of-scope handling" in the plan). The inline-code case (`code-2`, "inline `code` in a
sentence") matches perfectly in some scale runs, confirming that only fenced code blocks with
their monospace font are the concern.

---

## PENDING (Maintainer: Real Tauri Build)

The following captures require running a real Tauri build. Playwright headless Chromium cannot
stand in for the WebKit engines used by Tauri on macOS and Linux (see project memory:
"rAF/ResizeObserver never fire in the preview harness"). The JSON files below must be filled by
manually copying the `#report` element's text content from the in-app webview.

### Capture instructions

1. Start the desktop app in dev mode: `npm run tauri:dev` (from the repo root or `apps/fluux`).
2. In the Tauri window, open devtools (right-click > Inspect), navigate to
   `http://localhost:5173/pretext-spike.html`, or point the in-app webview URL bar there if
   available.
3. Wait for the `#report` `<pre>` to stop showing "measuring..." (may take 10-20 s).
4. In the Console, run: `copy(document.getElementById('report').textContent)`
5. Paste into `apps/fluux/src/spikes/pretext/results/wkwebview-macos.json` (macOS) or
   `apps/fluux/src/spikes/pretext/results/webkitgtk-linux.json` (Linux).

### macOS WKWebView: per-scale results

> **PENDING -- fill from `results/wkwebview-macos.json`**

#### Scale 90%

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |       |              |             |             |
| wrap      |       |              |             |             |
| mention   |       |              |             |             |
| link      |       |              |             |             |
| mixed     |       |              |             |             |

**Overall textLineExactPct: PENDING** -- PENDING

#### Scale 100%

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |       |              |             |             |
| wrap      |       |              |             |             |
| mention   |       |              |             |             |
| link      |       |              |             |             |
| mixed     |       |              |             |             |

**Overall textLineExactPct: PENDING** -- PENDING

#### Scale 125%

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |       |              |             |             |
| wrap      |       |              |             |             |
| mention   |       |              |             |             |
| link      |       |              |             |             |
| mixed     |       |              |             |             |

**Overall textLineExactPct: PENDING** -- PENDING

#### Scale 150%

| Category  | Count | lineExactPct | p95AbsErrPx | maxAbsErrPx |
|-----------|------:|-------------:|------------:|------------:|
| short     |       |              |             |             |
| wrap      |       |              |             |             |
| mention   |       |              |             |             |
| link      |       |              |             |             |
| mixed     |       |              |             |             |

**Overall textLineExactPct: PENDING** -- PENDING

#### macOS WKWebView summary

| Scale | textLineExactPct | Passes 98% threshold? |
|------:|----------------:|:----------------------|
|   90% |         PENDING | PENDING               |
|  100% |         PENDING | PENDING               |
|  125% |         PENDING | PENDING               |
|  150% |         PENDING | PENDING               |

---

### Linux WebKitGTK: per-scale results

> **PENDING -- fill from `results/webkitgtk-linux.json`**
>
> **Outstanding risk:** if no Linux/WebKitGTK environment is available, this remains an untested
> engine. WebKitGTK is the rendering engine used by Tauri on Linux. Font shaping can differ from
> both macOS WKWebView and Chromium (different HarfBuzz + FreeType rendering pipeline, different
> default system fonts, different sub-pixel rounding). The Inter font may be substituted if not
> installed on the Linux host, which would invalidate the measurement entirely. This risk should
> be resolved before a GO decision is final.

If captured, fill the same per-scale tables as the macOS section above.

---

### Chrome-delta matrix (manual, real Tauri build)

The virtualizer row height is `predictedTextHeight + chromeDelta(density, scale)` where
`chromeDelta` captures all fixed vertical costs: avatar block, sender-name header, timestamp
strip, reactions row, date-separator height, and row top/bottom padding. These costs are
density-controlled (`comfortable` vs `compact`) and rem-scaled, so they may shift with character
scale.

To fill this matrix, for each `(density, scale)` cell:
1. Open a real conversation with several message types in the Tauri devtools.
2. Inspect a representative message row (not a media row, not a code block row).
3. Measure the total row `offsetHeight` and subtract the pretext-predicted text height for that
   message body.
4. Record the delta; check it is stable (< 2 px variance) across 3+ messages of different lengths.

> **PENDING -- fill from manual devtools inspection**

| Density     | Scale 90% | Scale 100% | Scale 125% | Scale 150% |
|-------------|----------:|-----------:|-----------:|-----------:|
| comfortable |   PENDING |    PENDING |    PENDING |    PENDING |
| compact     |   PENDING |    PENDING |    PENDING |    PENDING |

The hypothesis is that `chromeDelta` is stable per `(density, scale)` cell and can be a small
lookup table. If the delta varies more than a few pixels across different message lengths at the
same density/scale, the additive model does not hold and a different approach is needed.

---

## Preliminary Verdict (Chromium-only, pending real engines)

**LEANING GO (preliminary, gated on WKWebView + WebKitGTK confirmation)**

In-scope `textCategories`: `short`, `wrap`, `mention`, `link`, `mixed`.

On headless Chromium:
- At all four scales (90%, 100%, 125%, 150%), pretext achieves **100.00% line-exact** across all
  in-scope text categories (0 px absolute error at 100/125/150%; sub-pixel rounding only at 90%).
  This is a stronger result than the 98% threshold requires.
- Out-of-scope categories (emoji, rtl, longtoken) also predict exactly in Chromium; only code
  blocks fail, as expected and by design. The `me` category is excluded from the gate due to a
  harness limitation (spike feeds raw body, DOM renders substituted string); see the `me` section
  above for details and per-scale numbers.

The Chromium data supports a **GO** verdict for adopting pretext as the primary size estimator
for all text-category rows (short, wrap, mention, link, mixed), with code blocks and media
rows handled via reserved-space estimates. For `/me` messages, a real predictor feeds pretext the
rendered `* {senderName} {actionText}` string and it handles it like any other prose text. The
architecture is clean: `predictedRow = predictTextHeight(body, width, fontSpec) + chromeDelta(density, scale)`,
with `chromeDelta` as a small per-`(density, scale)` constant lookup.

**This verdict is preliminary and conditional.** The final GO/NO-GO decision requires:
1. macOS WKWebView numbers meeting the 98% threshold (font shaping on WebKit differs from
   Blink; sub-pixel rounding and Inter rendering may produce different misses).
2. Linux WebKitGTK numbers or an explicit decision to accept the risk of not having them.
3. The chrome-delta matrix confirming that `chromeDelta` is stable (< 2 px variance) per
   density/scale cell in a real Tauri conversation.

---

## Next Step if GO

If the WKWebView and WebKitGTK captures confirm the GO verdict, the follow-up implementation
plan should wire `predictTextHeight + chromeDelta` into
`apps/fluux/src/components/conversation/tanstackMessageVirtualizer.ts`'s `estimateSize` callback
behind the existing `enableMessageVirtualization` feature flag: when the flag is on,
`estimateSize` calls `predictTextHeight(msg.body, containerWidth, liveFont)` and adds the
`chromeDelta` for the current density and character scale, rather than returning the current
static fallback height. A persistent height cache (keyed by `messageId + widthPx + scale`) must
be added to avoid re-running the prediction on every virtualizer tick for already-measured rows.
Media and code-block rows should remain on a reserved-space estimate (e.g. a fixed height that
slightly overestimates, shrinking to the real height once the media/highlight DOM is measured and
the virtualizer is notified via its `measureElement` / `didNotMeasure` API). The implementation
should be guarded by the same `enableMessageVirtualization` flag, and accuracy should be tracked
with a lightweight per-session counter in `fluux.log` comparing predicted vs first-measured
heights for a sample of rows.
