/**
 * Web entry of @fluux/openpgp-plugin (`@fluux/openpgp-plugin/web`).
 *
 * The openpgp.js-backed plugin lives on its own entry so an app can load it on
 * demand with a dynamic import and keep it out of its main chunk. The desktop
 * plugin and the shared helpers stay on the main entry.
 */
export * from './WebOpenPGPPlugin'
