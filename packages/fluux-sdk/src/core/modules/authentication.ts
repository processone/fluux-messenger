import type { Element } from '@xmpp/client'
import type { ConnectionEvents } from '../types/sdk-events'

type Authentication = NonNullable<ConnectionEvents['connection:authenticated']['authentication']>
type Attempt = { method: Authentication['method'] | null; mechanism: string }

const SASL = 'urn:ietf:params:xml:ns:xmpp-sasl'
const SASL2 = 'urn:xmpp:sasl:2'
const FAST = 'urn:xmpp:fast:0'
const STREAM = 'http://etherx.jabber.org/streams'
const CONDITIONS = [
  'not-authorized', 'credentials-expired', 'account-disabled', 'invalid-authzid',
  'invalid-mechanism', 'mechanism-too-weak', 'temporary-auth-failure',
  'malformed-request', 'incorrect-encoding', 'aborted', 'encryption-required',
] as const

/** Tracks wire attempts separately from the credentials offered to xmpp.js. */
export class AuthenticationTracker {
  private refused = false
  private attempt: Attempt | null = null
  private authenticated: Authentication | null = null
  private pending: Promise<Authentication | null> | null = null
  private finish: ((result: Authentication | null) => void) | null = null

  constructor(
    private readonly report: (message: string, category: 'connection' | 'error') => void,
    private readonly onAttempt: (authentication: Attempt) => void,
  ) {}

  begin(): void {
    this.refused = false
    this.attempt = null
    this.authenticated = null
    this.pending = new Promise(resolve => { this.finish = resolve })
  }

  sent(element: Element): void {
    if (!element.is('auth', SASL) && !element.is('authenticate', SASL2)) return
    this.refused = false
    const mechanism = element.attrs.mechanism
    this.attempt = {
      method: element.getChild('fast', FAST) ? 'fast-token'
        : mechanism === 'PLAIN' || mechanism.startsWith('SCRAM-SHA-') ? 'password' : null,
      mechanism,
    }
    this.authenticated = null
    this.onAttempt(this.attempt)
    this.report(`Auth: ${this.label()} (SASL: ${this.attempt.mechanism})`, 'connection')
  }

  received(element: Element): void {
    const source = element.is('failure', SASL2) ? 'SASL2'
      : element.is('failure', SASL) ? 'SASL'
        : element.is('error', STREAM) ? 'stream' : null
    if (!source) return
    // Only protocol condition names are diagnostic data; never include server text or payloads.
    const condition = CONDITIONS.find(name => element.getChild(name)) ?? 'unknown'
    if (source !== 'stream' || condition !== 'unknown') this.refused = true
    if (source === 'stream') {
      if (condition !== 'unknown') this.report(`Auth refusal (source: stream, condition: ${condition})`, 'error')
      return
    }
    this.report(`Auth refused: ${this.label()} (SASL: ${this.attempt?.mechanism ?? 'unknown'}, source: ${source}, condition: ${condition})`, 'error')
  }

  /** Call only after xmpp.js has also verified any final SCRAM challenge. */
  succeeded(): void {
    this.refused = false
    this.authenticated = this.attempt?.method
      ? { method: this.attempt.method, mechanism: this.attempt.mechanism } : null
    if (this.authenticated) {
      this.report(`Auth succeeded: ${this.label()} (SASL: ${this.authenticated.mechanism})`, 'connection')
    }
    this.finish?.(this.authenticated)
    this.finish = null
    this.pending = null
  }

  failed(): void {
    this.authenticated = null
    this.finish?.(null)
    this.finish = null
    this.pending = null
  }

  pendingResult(): Promise<Authentication | null> | null {
    return this.pending
  }

  wasRefused(): boolean {
    return this.refused
  }

  result(): Authentication | null {
    return this.authenticated
  }

  private label(): string {
    return this.attempt?.method === 'fast-token' ? 'FAST token'
      : this.attempt?.method === 'password' ? 'password' : 'unknown'
  }
}
