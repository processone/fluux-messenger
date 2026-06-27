import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import '@/index.css'
import { MessageBody } from '@/components/conversation/MessageBody'
import { CORPUS } from './corpus'
import { predictTextHeight, type FontSpec, type Prediction } from './predictTextHeight'
import { buildReport, type Sample } from './compareHeights'

const WIDTHS = [320, 560, 760] // narrow / medium / wide content-column widths (px)
const SCALES = [90, 100, 125, 150] // character scaling = document.documentElement root font-size %
const SENDER_COLOR = '#3b82f6'

function fontSpecFrom(el: HTMLElement): FontSpec {
  const cs = getComputedStyle(el)
  const fontSizePx = parseFloat(cs.fontSize)
  const lh = cs.lineHeight === 'normal' ? fontSizePx * 1.375 : parseFloat(cs.lineHeight)
  const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0
  return {
    fontFamily: cs.fontFamily,
    fontSizePx,
    fontWeight: Number(cs.fontWeight) || 400,
    fontStyle: cs.fontStyle || 'normal',
    lineHeightPx: lh,
    letterSpacingPx: ls,
    whiteSpace: 'pre-wrap',
  }
}

function countLineBoxes(el: HTMLElement, lineHeightPx: number): number {
  // robust line count = rendered height / line-height, rounded
  return Math.max(1, Math.round(el.getBoundingClientRect().height / lineHeightPx))
}

// Fallback copy for webviews where navigator.clipboard is unavailable: select
// the report node's text and execCommand('copy').
function selectAndCopy(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
  try { document.execCommand('copy') } catch { /* ignore */ }
}

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [json, setJson] = useState('measuring...')
  const [summary, setSummary] = useState('')
  const [copied, setCopied] = useState(false)

  function copyReport() {
    const el = document.getElementById('report')
    if (!el) return
    const text = el.textContent ?? ''
    const done = () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) }
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { selectAndCopy(el); done() })
    } else {
      selectAndCopy(el)
      done()
    }
  }

  useEffect(() => {
    let cancelled = false
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

    async function run() {
      await document.fonts.ready
      await nextFrame() // settle after font swap
      if (cancelled || !containerRef.current) return
      const root = containerRef.current
      const runs: Array<{ fontScalePct: number; report: ReturnType<typeof buildReport>; samples: Sample[] }> = []

      // Character scaling = root font-size %. The SAME DOM is re-measured at each
      // scale (changing root font-size reflows the rem-based message text); the
      // font spec is read live from getComputedStyle, so the predictor tracks the
      // scaled font. Density is intentionally NOT varied (it changes only chrome).
      for (const pct of SCALES) {
        document.documentElement.style.fontSize = `${pct}%`
        void document.documentElement.offsetHeight // force a synchronous style/layout flush at the new scale (WebKit may otherwise defer it past a single frame)
        await nextFrame() // then let a paint frame settle before measuring
        if (cancelled) return
        const samples: Sample[] = []
        for (const width of WIDTHS) {
          for (const item of CORPUS) {
            const bodyEl = root.querySelector<HTMLElement>(
              `[data-spike-body="${item.id}"][data-spike-width="${width}"] [dir="auto"]`,
            )
            if (!bodyEl) continue
            const font = fontSpecFrom(bodyEl)
            const measuredHeightPx = bodyEl.getBoundingClientRect().height
            const measuredLineCount = countLineBoxes(bodyEl, font.lineHeightPx)
            const predicted: Prediction = predictTextHeight(item.body, width, font)
            samples.push({ id: item.id, category: item.category, widthPx: width, predicted, measuredHeightPx, measuredLineCount })
          }
        }
        const report = buildReport(samples, {
          lineExactThresholdPct: 98,
          heightTolPx: 2,
          textCategories: ['short', 'wrap', 'mention', 'link', 'mixed'],
        })
        runs.push({ fontScalePct: pct, report, samples })
      }

      document.documentElement.style.fontSize = '' // restore default scale
      const out = { engine: navigator.userAgent, widths: WIDTHS, scales: SCALES, runs }
      const summaryLine = runs
        .map((r) => `${r.fontScalePct}%: ${r.report.overall.textLineExactPct.toFixed(2)}% ${r.report.overall.passesThreshold ? 'PASS' : 'FAIL'}`)
        .join('    ')
      // expose for manual capture from a webview (devtools or the Copy button)
      ;(window as Window & { __pretextReport?: unknown }).__pretextReport = out
      console.log('[pretext-spike] report ready. window.__pretextReport =', out)
      if (!cancelled) {
        setJson(JSON.stringify(out, null, 2))
        setSummary(summaryLine)
      }
    }

    void run()
    return () => { cancelled = true; document.documentElement.style.fontSize = '' }
  }, [])

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 16 }}>Pretext height spike</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '8px 0' }}>
        <button type="button" onClick={copyReport} style={{ fontSize: 13, padding: '4px 10px', cursor: 'pointer' }}>
          {copied ? 'Copied' : 'Copy JSON'}
        </button>
        <span style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{summary || 'measuring...'}</span>
      </div>
      <pre id="report" data-spike-report style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', border: '1px solid #ccc', padding: 8 }}>{json}</pre>
      <div ref={containerRef}>
        {WIDTHS.map((width) => (
          <div key={width}>
            {CORPUS.map((item) => (
              <div
                key={`${width}-${item.id}`}
                data-spike-body={item.id}
                data-spike-width={width}
                style={{ width, outline: '1px dashed rgba(0,0,0,0.1)', margin: '4px 0' }}
              >
                <MessageBody body={item.body} senderName="Tester" senderColor={SENDER_COLOR} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={i18n}>
    <App />
  </I18nextProvider>,
)
