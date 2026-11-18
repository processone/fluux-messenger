/**
 * The host's file access, as the desktop OpenPGP plugin sees it.
 *
 * Exporting a key file and importing one go through native dialogs the plugin
 * cannot own. The host supplies them through this interface, so the plugin
 * imports no dialog or filesystem module.
 */
export interface OpenPGPFileIO {
  /**
   * Ask the user where to save `armored`, suggesting `defaultName`, and write
   * it there. Resolves `true` when the file was written and `false` when the
   * user dismissed the dialog without choosing a path.
   */
  saveFile(defaultName: string, armored: string): Promise<boolean>
  /**
   * Ask the user to pick a file and resolve with its text, or `null` when the
   * user cancels the picker.
   */
  pickFile(): Promise<string | null>
}
