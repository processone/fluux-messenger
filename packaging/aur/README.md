# Fluux Messenger AUR Package

This directory contains the PKGBUILD for the Arch User Repository (AUR).

## For Users

Install using an AUR helper:

```bash
yay -S fluux-messenger-bin
# or
paru -S fluux-messenger-bin
```

Or manually:

```bash
git clone https://aur.archlinux.org/fluux-messenger-bin.git
cd fluux-messenger-bin
makepkg -si
```

## For Maintainers

### Initial AUR Setup

1. Create an account on https://aur.archlinux.org
2. Add your SSH key to your AUR account
3. Clone the AUR repo:
   ```bash
   git clone ssh://aur@aur.archlinux.org/fluux-messenger-bin.git
   ```
4. Copy the PKGBUILD and .SRCINFO files to the cloned repo

### Updating the Package

After each release:

1. Update `pkgver` in PKGBUILD to the new version
2. Update the checksums:
   ```bash
   updpkgsums
   ```
3. Regenerate .SRCINFO:
   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```
4. Test the build:
   ```bash
   makepkg -si
   ```
5. Commit and push to AUR:
   ```bash
   git add PKGBUILD .SRCINFO
   git commit -m "Update to version X.Y.Z"
   git push
   ```

### Package Naming Convention

- `fluux-messenger-bin` - Binary package (downloads pre-built binary)
- `fluux-messenger` - Would be for building from source (not implemented)

## Dependencies

The package requires these Arch packages:

- `webkit2gtk-4.1` - WebView for rendering
- `gtk3` - GTK3 toolkit
- `libappindicator-gtk3` - System tray support
