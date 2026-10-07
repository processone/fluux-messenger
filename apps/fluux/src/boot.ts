/**
 * Entry point. Stores read localStorage when their modules are imported, so
 * native storage has to be in place before the app is.
 */
import { platform } from './platform'
import { bootNativeLocalStorage } from './utils/nativeLocalStorage'

const ready = platform().nativeLocalStorage ? bootNativeLocalStorage() : Promise.resolve()
void ready.then(() => import('./main'))
