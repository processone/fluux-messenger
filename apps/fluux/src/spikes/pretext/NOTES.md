# Pretext Spike Notes

Package: `@chenglou/pretext` v0.0.8  
Source of truth: `node_modules/@chenglou/pretext/dist/layout.d.ts`

## Confirmed pretext API

### Main entry (`@chenglou/pretext` → `dist/layout.js`)

#### `prepare(text, font, options?) → PreparedText`

```ts
export declare function prepare(text: string, font: string, options?: PrepareOptions): PreparedText;
```

- `text`: the string to measure
- `font`: CSS font shorthand string (e.g. `"14px Inter"`, `"bold 16px Arial"`). Internally parsed by `parseFontSize()` which extracts the pixel size via `/(\d+(?:\.\d+)?)\s*px/`. The full string is passed to `CanvasRenderingContext2D.font`.
- `options`: optional `PrepareOptions`

#### `PrepareOptions`

```ts
export type PrepareOptions = {
  whiteSpace?: WhiteSpaceMode;   // 'normal' | 'pre-wrap'  (default: 'normal')
  wordBreak?: WordBreakMode;     // 'normal' | 'keep-all'  (default: 'normal')
  letterSpacing?: number;        // in pixels (default: 0)
};
```

**Font parameters summary:**
- Family, size, weight, style: all encoded together in the CSS `font` string (e.g. `"italic bold 14px Inter"`)
- Letter-spacing: passed in `PrepareOptions.letterSpacing` (pixels, NOT the CSS string)
- Line-height: NOT passed to `prepare()` — it is passed later to `layout()`
- White-space mode: `PrepareOptions.whiteSpace` (`'normal'` collapses, `'pre-wrap'` preserves)
- Tab-size: NOT directly configurable in `PrepareOptions`; tabs are handled as `SegmentBreakKind = 'tab'` internally

#### `prepareWithSegments(text, font, options?) → PreparedTextWithSegments`

```ts
export declare function prepareWithSegments(text: string, font: string, options?: PrepareOptions): PreparedTextWithSegments;
```

Same as `prepare` but returns a richer object that includes `segments: string[]`, required for `layoutWithLines`, `walkLineRanges`, `measureLineStats`, etc.

#### `layout(prepared, maxWidth, lineHeight) → LayoutResult`

```ts
export declare function layout(prepared: PreparedText, maxWidth: number, lineHeight: number): LayoutResult;
```

- `maxWidth`: container width in pixels
- `lineHeight`: line height in pixels (passed here, NOT in `prepare`)
- Returns **both** pixel height AND line count:

```ts
export type LayoutResult = {
  lineCount: number;  // number of wrapped lines
  height: number;     // total pixel height = lineCount * lineHeight
};
```

#### `layoutWithLines(prepared, maxWidth, lineHeight) → LayoutLinesResult`

```ts
export declare function layoutWithLines(prepared: PreparedTextWithSegments, maxWidth: number, lineHeight: number): LayoutLinesResult;
```

Returns `LayoutResult & { lines: LayoutLine[] }` — same height/lineCount plus per-line text and width data.

#### Other exported functions from main entry

```ts
export declare function materializeLineRange(prepared: PreparedTextWithSegments, line: LayoutLineRange): LayoutLine;
export declare function walkLineRanges(prepared: PreparedTextWithSegments, maxWidth: number, onLine: (line: LayoutLineRange) => void): number;
export declare function measureLineStats(prepared: PreparedTextWithSegments, maxWidth: number): LineStats;
export declare function measureNaturalWidth(prepared: PreparedTextWithSegments): number;
export declare function layoutNextLine(prepared: PreparedTextWithSegments, start: LayoutCursor, maxWidth: number): LayoutLine | null;
export declare function layoutNextLineRange(prepared: PreparedTextWithSegments, start: LayoutCursor, maxWidth: number): LayoutLineRange | null;
export declare function clearCache(): void;
export declare function setLocale(locale?: string): void;
```

#### Key types

```ts
export type LayoutResult = {
  lineCount: number;
  height: number;
};

export type LineStats = {
  lineCount: number;
  maxLineWidth: number;
};

export type LayoutLine = {
  text: string;
  width: number;
  start: LayoutCursor;
  end: LayoutCursor;
};

export type LayoutCursor = {
  segmentIndex: number;
  graphemeIndex: number;
};
```

### Subpath entry (`@chenglou/pretext/rich-inline` → `dist/rich-inline.js`)

For mixed-font inline runs (bold/italic within a paragraph).

```ts
export declare function prepareRichInline(items: RichInlineItem[]): PreparedRichInline;
export declare function layoutNextRichInlineLineRange(prepared: PreparedRichInline, maxWidth: number, start?: RichInlineCursor): RichInlineLineRange | null;
export declare function materializeRichInlineLineRange(prepared: PreparedRichInline, line: RichInlineLineRange): RichInlineLine;
export declare function walkRichInlineLineRanges(prepared: PreparedRichInline, maxWidth: number, onLine: (line: RichInlineLineRange) => void): number;
export declare function measureRichInlineStats(prepared: PreparedRichInline, maxWidth: number): RichInlineStats;
```

```ts
export type RichInlineItem = {
  text: string;
  font: string;
  letterSpacing?: number;
  break?: 'normal' | 'never';
  extraWidth?: number;
};
```

## README vs Real API — Discrepancies

The README mentions `prepare`/`layout` and `prepareWithSegments`/`layoutWithLines` — these names match the real `.d.ts`. No discrepancy in function names.

Key details NOT obvious from README:
1. `letterSpacing` is in `PrepareOptions` (pixels), not in the font string.
2. `lineHeight` is a `layout()` argument, not a prepare-time option.
3. `font` is a CSS font shorthand string — family/size/weight/style all in one string.
4. `tab-size` is not a configurable option; tabs are handled by the internal segmenter.
5. `layout()` returns BOTH `height` (pixels) and `lineCount` — Task 3 can use either directly.
6. `WhiteSpaceMode` is `'normal' | 'pre-wrap'` (not `'nowrap'` or others).

## Implementation notes for Task 3

The typical usage pattern for height prediction:

```ts
import { prepare, layout } from '@chenglou/pretext'

// font = CSS font shorthand; letterSpacing in PrepareOptions (px); whiteSpace for pre-wrap
const prepared = prepare(text, '14px Inter', { letterSpacing: 0, whiteSpace: 'normal' })
const { height, lineCount } = layout(prepared, containerWidth, lineHeightPx)
// height = lineCount * lineHeightPx
```

Important: `prepare()` uses `CanvasRenderingContext2D.measureText` internally, which requires a browser or jsdom environment. It will NOT work in a plain Node.js vitest run without a canvas implementation (e.g. `jsdom` or `happy-dom` with canvas support, or `@vitest/browser`).
