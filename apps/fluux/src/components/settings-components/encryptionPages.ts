/** The screens behind Settings > Encryption: `/settings/encryption/<page>`. The bare path is the overview. */
export const ENCRYPTION_SUB_PAGES = ['openpgp', 'omemo'] as const

export type EncryptionSubPage = (typeof ENCRYPTION_SUB_PAGES)[number]

/** An unknown or absent sub-page falls back to the overview (null). */
export function resolveEncryptionSubPage(requested: string | null | undefined): EncryptionSubPage | null {
  return ENCRYPTION_SUB_PAGES.find((page) => page === requested) ?? null
}

export const ENCRYPTION_SUB_PAGE_LABEL_KEYS: Record<EncryptionSubPage, string> = {
  openpgp: 'settings.encryption.openpgpName',
  omemo: 'settings.encryption.omemoName',
}
