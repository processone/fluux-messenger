import type { ConnectOptions } from '@fluux/sdk'

/** Connection details resolved by the startup owner before it calls the SDK. */
type StartupConnectionDetails = Pick<
  ConnectOptions,
  'jid' | 'password' | 'server' | 'fallbackWebSocketUrl' | 'resource' | 'lang'
>

type StartupConnectionPolicy =
  | { kind: 'session'; hasNativeConnectionKeepalive: boolean; rememberSession: true | undefined }
  | { kind: 'keychain'; hasNativeConnectionKeepalive: boolean }
  | { kind: 'fast-token' | 'keychain-retry' }

/**
 * Builds SDK options without reading storage, credentials or platform globals.
 * The startup owner retains credential selection, cancellation and retry limits.
 */
export function buildStartupConnectionOptions(
  connection: StartupConnectionDetails,
  policy: StartupConnectionPolicy,
): ConnectOptions {
  switch (policy.kind) {
    case 'session':
      return {
        ...connection,
        disableSmKeepalive: policy.hasNativeConnectionKeepalive,
        // Reloads must retain the opt-in so rotated FAST tokens are persisted.
        rememberSession: policy.rememberSession,
        autoRetryOnTransientFailure: true,
        // The SDK restores room membership through its read-state storage.
        previouslyJoinedRooms: undefined,
      }
    case 'keychain':
      // Leave transient retry at the SDK default for the direct keychain attempt.
      return {
        ...connection,
        disableSmKeepalive: policy.hasNativeConnectionKeepalive,
        rememberSession: true,
      }
    case 'fast-token':
    case 'keychain-retry':
      return {
        ...connection,
        disableSmKeepalive: false,
        rememberSession: true,
        autoRetryOnTransientFailure: true,
      }
  }
}
