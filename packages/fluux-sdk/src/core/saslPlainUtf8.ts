import type { Client, SaslMechanismEntry } from '@xmpp/client'
import { logError as logErr } from './logger'

/**
 * SASL PLAIN whose response reaches the wire as UTF-8.
 *
 * RFC 4616 §2 defines the PLAIN message as UTF-8 encoded Unicode. xmpp.js
 * base64s whatever a mechanism returns with `btoa()`, which serialises one
 * latin-1 byte per code unit, so a mechanism must hand back a binary string:
 * one code unit per byte. The mechanisms xmpp.js ships for SCRAM-SHA-1 and
 * HT-SHA-256 do exactly that; its PLAIN returns the raw password instead, so
 * `ô` (U+00F4) leaves as `f4` where the server expects `c3 b4`, and anything
 * above U+00FF makes `btoa()` throw outright.
 *
 * This is an interim local patch. The permanent home for it is `@xmpp/sasl-plain`
 * upstream, and this file goes away when that lands (#1219).
 */
class Utf8SaslPlain {
  readonly name = 'PLAIN'
  readonly clientFirst = true

  response(cred: { authzid?: string; username: string; password: string }): string {
    const bytes = new TextEncoder().encode(
      `${cred.authzid ?? ''}\0${cred.username}\0${cred.password}`
    )
    // btoa() maps code units 0-255 to the identical byte, so a binary string
    // survives base64 unchanged.
    return String.fromCharCode(...bytes)
  }

  challenge(): this {
    return this
  }
}

/**
 * Replace the PLAIN mechanism xmpp.js registered with the UTF-8 one above.
 *
 * Replacement rather than registration: `saslmechanisms`' factory returns the
 * first entry whose name matches, so an appended mechanism never wins. The
 * entry list is a private field of that package, which is why the loss of this
 * patch has to stay detectable — `saslPlainUtf8.test.ts` asserts the bytes the
 * client actually sends, so a dependency bump that moves the field fails there
 * rather than silently restoring the bug.
 *
 * A missing entry is reported and left alone: ASCII passwords keep working on
 * the stock mechanism, which is a better outcome than refusing every login.
 *
 * Call this before `start()`; the registry is read during stream negotiation.
 */
export function installUtf8SaslPlain(client: Client): void {
  const mechanisms: SaslMechanismEntry[] | undefined = client.saslFactory?._mechs
  const index = mechanisms?.findIndex((entry) => entry.name === 'PLAIN') ?? -1

  if (!mechanisms || index === -1) {
    logErr(
      'SASL PLAIN mechanism not found in the xmpp.js factory: passwords with non-ASCII characters will fail to authenticate'
    )
    return
  }

  mechanisms[index] = { name: 'PLAIN', mech: Utf8SaslPlain }
}
