import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import '@/index.css'
import { MessageBody } from '@/components/conversation/MessageBody'
import { CORPUS } from './corpus'
import { predictTextHeight, type FontSpec, type Prediction } from './predictTextHeight'
import { buildReport, type Sample } from './compareHeights'

const WIDTHS = [320, 560, 760] // narrow / medium / wide content-column widths
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

function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const [json, setJson] = useState('measuring...')

  useEffect(() => {
    let cancelled = false
    void document.fonts.ready.then(() => {
      // one extra frame so layout settles after fonts swap
      requestAnimationFrame(() => {
        if (cancelled || !containerRef.current) return
        const root = containerRef.current
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
          textCategories: ['short', 'wrap', 'mention', 'link', 'me', 'mixed'],
        })
        const out = {
          engine: navigator.userAgent,
          widths: WIDTHS,
          report,
          samples,
        }
        if (!cancelled) setJson(JSON.stringify(out, null, 2))
      })
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ fontFamily: 'Inter, sans-serif', padding: 16 }}>
      <h1 style={{ fontSize: 16 }}>Pretext height spike</h1>
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
