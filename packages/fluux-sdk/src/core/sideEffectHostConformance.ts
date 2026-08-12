/**
 * Compile-time proof that {@link XMPPClient} still provides what the side
 * effects are written against.
 *
 * The side effects used to name the client directly, so the two could not
 * disagree. Now that they name {@link SideEffectHost} instead, this is where
 * the obligation lives: narrow or rename a member the host promises and this
 * stops compiling, instead of the mismatch surfacing at every call site.
 *
 * The reverse direction is deliberately NOT asserted. The client is free to
 * grow members the host does not mention — that is the point of the narrowing.
 *
 * This file is type-only. It emits no runtime code and is never imported.
 *
 * @packageDocumentation
 * @module Core
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectHost } from './sideEffectHost'
import type { SDKEventSource, ClientEventSource } from './types/eventSource'

/** Compiles only when `T` is `true`; otherwise reports the constraint failure. */
type Assert<T extends true> = T

/** Whether the client is usable wherever the contract is required. */
type Provides<Contract> = XMPPClient extends Contract ? true : false

// Each alias fails to compile — "Type 'false' does not satisfy the constraint
// 'true'" — when the client stops satisfying that contract. Compare the client
// against the interface named in the alias to find the member that drifted.
export type ClientProvidesSideEffectHost = Assert<Provides<SideEffectHost>>
export type ClientProvidesSDKEventSource = Assert<Provides<SDKEventSource>>
export type ClientProvidesClientEventSource = Assert<Provides<ClientEventSource>>
