/**
 * Minimal localized strings for service-worker notifications.
 *
 * The SW cannot run the app's i18next stack (bundle weight, no React), so the
 * one string it needs — the coalesced "N new messages" body — lives here for
 * every app locale, selected with Intl.PluralRules. The app notification path
 * (useDesktopNotifications) reuses this module with the app locale so both
 * paths render identical text. Keys are base languages (lowercase).
 */

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string }

const FORMS: Record<string, PluralForms> = {
  ar: {
    one: 'رسالة جديدة واحدة',
    two: 'رسالتان جديدتان',
    few: '{count} رسائل جديدة',
    many: '{count} رسالة جديدة',
    other: '{count} رسالة جديدة',
  },
  be: {
    one: '{count} новае паведамленне',
    few: '{count} новыя паведамленні',
    many: '{count} новых паведамленняў',
    other: '{count} новых паведамленняў',
  },
  bg: { one: '{count} ново съобщение', other: '{count} нови съобщения' },
  ca: { one: '{count} missatge nou', other: '{count} missatges nous' },
  cs: {
    one: '{count} nová zpráva',
    few: '{count} nové zprávy',
    other: '{count} nových zpráv',
  },
  da: { one: '{count} ny besked', other: '{count} nye beskeder' },
  de: { one: '{count} neue Nachricht', other: '{count} neue Nachrichten' },
  el: { one: '{count} νέο μήνυμα', other: '{count} νέα μηνύματα' },
  en: { one: '{count} new message', other: '{count} new messages' },
  es: {
    one: '{count} mensaje nuevo',
    many: '{count} mensajes nuevos',
    other: '{count} mensajes nuevos',
  },
  et: { one: '{count} uus sõnum', other: '{count} uut sõnumit' },
  fi: { one: '{count} uusi viesti', other: '{count} uutta viestiä' },
  fr: {
    one: '{count} nouveau message',
    many: '{count} nouveaux messages',
    other: '{count} nouveaux messages',
  },
  ga: {
    one: '{count} teachtaireacht nua',
    two: '{count} theachtaireacht nua',
    few: '{count} theachtaireacht nua',
    many: '{count} dteachtaireacht nua',
    other: '{count} teachtaireacht nua',
  },
  he: {
    one: 'הודעה חדשה אחת',
    two: '{count} הודעות חדשות',
    many: '{count} הודעות חדשות',
    other: '{count} הודעות חדשות',
  },
  hr: {
    one: '{count} nova poruka',
    few: '{count} nove poruke',
    other: '{count} novih poruka',
  },
  hu: { one: '{count} új üzenet', other: '{count} új üzenet' },
  is: { one: '{count} ný skilaboð', other: '{count} ný skilaboð' },
  it: {
    one: '{count} nuovo messaggio',
    many: '{count} nuovi messaggi',
    other: '{count} nuovi messaggi',
  },
  lt: {
    one: '{count} nauja žinutė',
    few: '{count} naujos žinutės',
    many: '{count} naujos žinutės',
    other: '{count} naujų žinučių',
  },
  lv: {
    zero: '{count} jaunu ziņu',
    one: '{count} jauna ziņa',
    other: '{count} jaunas ziņas',
  },
  mt: {
    one: '{count} messaġġ ġdid',
    few: '{count} messaġġi ġodda',
    many: '{count}-il messaġġ ġdid',
    other: '{count} messaġġ ġdid',
  },
  nb: { one: '{count} ny melding', other: '{count} nye meldinger' },
  nl: { one: '{count} nieuw bericht', other: '{count} nieuwe berichten' },
  pl: {
    one: '{count} nowa wiadomość',
    few: '{count} nowe wiadomości',
    many: '{count} nowych wiadomości',
    other: '{count} nowych wiadomości',
  },
  pt: {
    one: '{count} nova mensagem',
    many: '{count} novas mensagens',
    other: '{count} novas mensagens',
  },
  ro: {
    one: '{count} mesaj nou',
    few: '{count} mesaje noi',
    other: '{count} de mesaje noi',
  },
  ru: {
    one: '{count} новое сообщение',
    few: '{count} новых сообщения',
    many: '{count} новых сообщений',
    other: '{count} новых сообщений',
  },
  sk: {
    one: '{count} nová správa',
    few: '{count} nové správy',
    other: '{count} nových správ',
  },
  sl: {
    one: '{count} novo sporočilo',
    two: '{count} novi sporočili',
    few: '{count} nova sporočila',
    other: '{count} novih sporočil',
  },
  sv: { one: '{count} nytt meddelande', other: '{count} nya meddelanden' },
  uk: {
    one: '{count} нове повідомлення',
    few: '{count} нові повідомлення',
    many: '{count} нових повідомлень',
    other: '{count} нових повідомлень',
  },
  zh: { other: '{count}条新消息' },
}

/** Localized "N new messages" for a coalesced notification body. */
export function newMessagesText(locale: string, count: number): string {
  const base = locale.toLowerCase().split('-')[0]
  const forms = FORMS[base] ?? FORMS.en
  let rule: Intl.LDMLPluralRule = 'other'
  try {
    rule = new Intl.PluralRules(locale).select(count)
  } catch {
    // Invalid locale tag — keep 'other'.
  }
  const template = forms[rule] ?? forms.other
  return template.replace('{count}', String(count))
}
