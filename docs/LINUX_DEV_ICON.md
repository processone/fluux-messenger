# Linux Dev: Dock Icon Setup

When running `npm run tauri:dev` on Linux (GNOME, KDE, etc.), the app appears in the dock/taskbar without an icon. This is expected — during development there's no installed `.desktop` file, so the desktop environment can't match the window to an icon.

This only affects development. Installed packages (.deb, .rpm, Flatpak, AUR) include a proper `.desktop` file and icons.

## Fix

### 1. Find the WM_CLASS

Start the app with `npm run tauri:dev`, then in another terminal:

```bash
xprop WM_CLASS
```

Click the Fluux window. You'll see something like:

```
WM_CLASS(STRING) = "fluux", "fluux"
```

Note the value (likely `fluux`, the binary name from `Cargo.toml`).

### 2. Create a dev .desktop file

Create `~/.local/share/applications/fluux-messenger-dev.desktop`:

```ini
[Desktop Entry]
Name=Fluux Messenger (Dev)
Exec=/absolute/path/to/fluux-messenger/apps/fluux/src-tauri/target/debug/fluux
Icon=/absolute/path/to/fluux-messenger/apps/fluux/src-tauri/icons/128x128.png
Terminal=false
Type=Application
StartupWMClass=fluux
```

Replace `/absolute/path/to/fluux-messenger` with your actual checkout path, and adjust `StartupWMClass` to match the value from step 1.

### 3. Update the icon cache

```bash
update-desktop-database ~/.local/share/applications/
```

### 4. Verify

Restart `npm run tauri:dev` — the Fluux icon should now appear in the dock.

## Notes

- This file is local to your machine and not tracked in git.
- If you switch between debug and release builds, the `Exec` path doesn't matter for icon matching — only `StartupWMClass` needs to match.
- On Wayland, the app ID may come from the GTK application ID (`com.processone.fluux`) instead of `WM_CLASS`. If the icon still doesn't appear, try setting `StartupWMClass=com.processone.fluux`.
