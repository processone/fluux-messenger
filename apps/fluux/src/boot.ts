/**
 * Entry point. Stores read localStorage when their modules are imported, so
 * native storage has to be in place before the app is.
 */
import { platform } from './platform'
import { bootNativeLocalStorage } from './utils/nativeLocalStorage'
import { startupAttempt } from './utils/startupRecovery'

// Capture native generation before importing the shell or touching storage.
void startupAttempt()

const ready = platform().nativeLocalStorage ? bootNativeLocalStorage() : Promise.resolve()
void ready.then(() => import('./main'))
