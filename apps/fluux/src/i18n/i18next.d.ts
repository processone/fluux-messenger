import 'i18next'

declare module 'i18next' {
  interface CustomTypeOptions {
    // Locales load dynamically without typed resources. Keep the v26 contract
    // for string-key translation callbacks passed to shared UI helpers.
    strictInterpolationChecks: false
  }
}
