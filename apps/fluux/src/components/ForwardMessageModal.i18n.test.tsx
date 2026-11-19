import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { ForwardMessageModal } from './ForwardMessageModal'

// The Forward dialog through real i18next in every shipped language: what a person reads in
// each state must be that language's text, never the English copy the strings started as.
const fixture = vi.hoisted(() => ({ chatSend: vi.fn(), rooms: new Map() }))
vi.mock('@fluux/sdk', async () => ({
  E2EEEncryptionRequiredError: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).E2EEEncryptionRequiredError,
  isE2EEPluginError: () => false,
  matchNameOrJid: (await vi.importActual<typeof import('@fluux/sdk')>('@fluux/sdk')).matchNameOrJid,
  useRoster: () => ({ contacts: [{ jid: 'emma@fluux.chat', name: 'Emma' }] }),
  useChatActions: () => ({ sendMessage: fixture.chatSend }),
  useRoomActions: () => ({ sendMessage: vi.fn() }),
  roomStore: { getState: () => ({ rooms: fixture.rooms }) },
  chatStore: { getState: () => ({ conversations: new Map() }) },
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => selector({ conversations: new Map() }),
  useRoomStore: (selector: (state: unknown) => unknown) => selector({ rooms: fixture.rooms }),
  useConnectionStore: (selector: (state: unknown) => unknown) => selector({ status: 'online' }),
}))

type Locale = { chat: Record<string, string>; common: Record<string, string> }
const locales = Object.fromEntries(Object.entries(import.meta.glob<{ default: Locale }>('../i18n/locales/*.json', { eager: true }))
  .map(([path, module]) => [path.replace('../i18n/locales/', '').replace('.json', ''), module.default]))
const en = locales.en
const languages = Object.keys(locales).filter(code => code !== 'en').sort()

// A word that is the same in English and in the language itself, not a copied placeholder.
const SAME_AS_ENGLISH: Record<string, string[]> = { da: ['Send'], nb: ['Send'] }

const link = 'xmpp:design@conference.fluux.chat?join;msg=1731490000123456'
const roomJid = 'design@conference.fluux.chat'
const quote = { author: 'Emma', from: 'emma@fluux.chat', text: 'Ship it on Friday' }

let i18n: I18n
beforeEach(async () => {
  vi.clearAllMocks()
  fixture.rooms = new Map([[roomJid, { jid: roomJid, name: 'Design', joined: true }]])
  i18n = createInstance()
  await i18n.use(initReactI18next).init({
    resources: Object.fromEntries(Object.entries(locales).map(([code, translation]) => [code, { translation }])),
    lng: 'en', fallbackLng: 'en', interpolation: { escapeValue: false },
  })
})

const inLanguage = (node: React.ReactNode) => <I18nextProvider i18n={i18n}>{node}</I18nextProvider>

/** Every text a person reads in the dialog: its title, text, placeholders and button names. */
function readDialog() {
  const dialog = screen.getByRole('dialog')
  const texts: string[] = []
  const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) texts.push(text)
  }
  dialog.querySelectorAll('[placeholder]').forEach(element => texts.push(element.getAttribute('placeholder')!))
  return texts
}

/** The dialog's English strings that are still shown in English. */
function englishIn(texts: string[], code: string) {
  const english = new Set([...Object.entries(en.chat).filter(([key]) => /^forward/.test(key)).map(([, value]) => value), en.common.cancel])
  return texts.filter(text => english.has(text) && !SAME_AS_ENGLISH[code]?.includes(text))
}

function choose(query: string, L: Locale) {
  const picker = screen.getByLabelText(L.chat.forwardDestination)
  fireEvent.focus(picker)
  fireEvent.change(picker, { target: { value: query } })
  fireEvent.keyDown(picker, { key: 'Enter' })
}

describe.each(languages)('Forward dialog in %s', code => {
  const L = locales[code]

  it('shows its title, explanations, labels and buttons in the language', async () => {
    await i18n.changeLanguage(code)
    const { unmount } = render(inLanguage(<ForwardMessageModal link={link} quote={{ ...quote, fromEncrypted: true }} onClose={vi.fn()} />))
    const dialog = screen.getByRole('dialog', { name: L.chat.forwardMessageLink })
    expect(within(dialog).getByText(L.chat.forwardLinkOnly)).toBeInTheDocument()
    expect(within(dialog).getByText(L.chat.forwardEncryptedOnly)).toBeInTheDocument()
    expect(within(dialog).getByLabelText(L.chat.forwardDestination)).toHaveAttribute('placeholder', L.chat.forwardChoose)
    expect(within(dialog).getByLabelText(L.chat.forwardComment)).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: L.chat.forwardSend })).toBeDisabled()
    const linked = readDialog()
    unmount()

    render(inLanguage(<ForwardMessageModal quote={quote} onClose={vi.fn()} />))
    expect(screen.getByText(L.chat.forwardQuoteOnly)).toBeInTheDocument()
    expect(englishIn([...linked, ...readDialog()], code)).toEqual([])
  })

  it('shows sending, a failed send and an unavailable destination in the language', async () => {
    await i18n.changeLanguage(code)
    let fail!: (error: Error) => void
    fixture.chatSend.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    const props = { link, onClose: vi.fn() }
    const first = render(inLanguage(<ForwardMessageModal {...props} />))
    choose('emma', L)
    fireEvent.click(screen.getByRole('button', { name: L.chat.forwardSend }))
    expect(screen.getByRole('button', { name: L.chat.forwardSending })).toBeDisabled()
    const sending = readDialog()
    await act(async () => { fail(new Error('Disconnected')) })
    expect(screen.getByRole('alert')).toHaveTextContent(L.chat.forwardFailed)
    const failed = readDialog()
    first.unmount()

    // A room chosen and then left while the dialog is open.
    const { rerender } = render(inLanguage(<ForwardMessageModal {...props} />))
    choose('design', L)
    fixture.rooms = new Map([[roomJid, { jid: roomJid, joined: false }]])
    rerender(inLanguage(<ForwardMessageModal {...props} />))
    expect(screen.getByText(L.chat.forwardUnavailable)).toBeInTheDocument()
    expect(englishIn([...sending, ...failed, ...readDialog()], code)).toEqual([])
  })
})
