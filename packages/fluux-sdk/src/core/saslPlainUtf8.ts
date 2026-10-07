import type { SaslFactory } from '@xmpp/client'

/** RFC 4616 UTF-8 bytes, passed as a binary string to xmpp.js's base64 layer. */
class Utf8Plain {
  readonly name = 'PLAIN'
  readonly clientFirst = true

  response({ authzid = '', username, password }: { authzid?: string; username: string; password: string }): string {
    const bytes = new TextEncoder().encode(`${authzid}\0${username}\0${password}`)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return binary
  }

  challenge(): this { return this }
}

/**
 * SDK consumers install their own xmpp.js dependencies, without the repository
 * patch. Keep its mechanism selection, but provide PLAIN's byte encoder here.
 * Replacing the mechanism avoids double-encoding an already patched dependency.
 * The factory's public create method also leaves SCRAM and FAST untouched.
 */
export function installUtf8SaslPlain(factory: SaslFactory): void {
  const create = factory.create.bind(factory)
  factory.create = (mechanisms) => {
    const selected = create(mechanisms)
    return selected && typeof selected === 'object' && 'name' in selected && selected.name === 'PLAIN'
      ? new Utf8Plain() : selected
  }
}
