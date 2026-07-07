import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { splitNickForDisplay } from '@fluux/sdk'

/**
 * Renders a MUC occupant nick, revealing impersonation vectors that HTML would
 * otherwise hide: leading/trailing whitespace is shown as a marked gap, and
 * invisible / bidi-control characters are flagged with a warning badge. A clean
 * nick renders verbatim (no wrapper, no cost).
 *
 * Emits inline content only — drop it in wherever a raw `{nick}` is rendered and
 * let the surrounding element keep owning color/truncation/layout.
 *
 * Never mutates the nick: trimming a remote nick for display would *complete* an
 * impersonation (`"admin "` and `"admin"` both collapse to `"admin"`). See
 * docs/superpowers/specs/2026-07-07-muc-nick-whitespace-impersonation-design.md.
 */
export function NickText({ nick }: { nick: string }) {
  const { t } = useTranslation()
  const { leading, core, trailing, hasHiddenChars } = splitNickForDisplay(nick)

  if (!leading && !trailing && !hasHiddenChars) {
    return <>{nick}</>
  }

  return (
    <>
      {leading && <WhitespaceMarker run={leading} label={t('rooms.nickEdgeWhitespace')} />}
      {core}
      {trailing && <WhitespaceMarker run={trailing} label={t('rooms.nickEdgeWhitespace')} />}
      {hasHiddenChars && (
        <span
          data-testid="nick-hidden-chars"
          role="img"
          aria-label={t('rooms.nickHiddenChars')}
          title={t('rooms.nickHiddenChars')}
          className="inline-flex items-center align-baseline shrink-0 mx-0.5"
        >
          <AlertTriangle className="size-3 text-amber-500" aria-hidden />
        </span>
      )}
    </>
  )
}

// A private-use character that will not occur in a translation or a nick, used
// to mark where {{nick}} lands so we can splice a live <NickText> into an
// otherwise-translated sentence without restructuring 33 locale files.
const NICK_SLOT = ''

/**
 * Renders a translated sentence that interpolates a single `{{nick}}`, with the
 * nick shown through {@link NickText} so its whitespace / hidden characters are
 * revealed in-context (e.g. the whisper-thread header "Private with {{nick}}").
 *
 * The nick is placed wherever the translation puts it — right for RTL and for
 * locales that lead with the name — because we split on the interpolated slot
 * rather than assuming a position.
 */
export function NickSentence({ i18nKey, nick }: { i18nKey: string; nick: string | undefined }) {
  const { t } = useTranslation()
  const segments = t(i18nKey, { nick: NICK_SLOT }).split(NICK_SLOT)
  return (
    <>
      {segments.map((segment, i) => (
        <Fragment key={i}>
          {segment}
          {i < segments.length - 1 && <NickText nick={nick ?? ''} />}
        </Fragment>
      ))}
    </>
  )
}

/**
 * A run of edge whitespace rendered as visible NBSP cells on a faint amber
 * ground so the padding is noticeable rather than an easy-to-miss gap. NBSP
 * keeps the browser from collapsing it; one cell per source character signals
 * presence (exact width is not important).
 */
function WhitespaceMarker({ run, label }: { run: string; label: string }) {
  return (
    <span
      data-testid="nick-ws-marker"
      title={label}
      aria-label={label}
      className="rounded-[2px] bg-amber-400/40 ring-1 ring-inset ring-amber-500/40 whitespace-pre"
    >
      {' '.repeat(run.length)}
    </span>
  )
}
