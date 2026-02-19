Name:           fluux-messenger
Version:        0.12.1
Release:        1%{?dist}
Summary:        Modern XMPP desktop client

License:        AGPL-3.0-or-later
URL:            https://github.com/processone/fluux-messenger
Source0:        fluux-messenger-%{version}.tar.gz

# Runtime dependencies
Requires:       webkit2gtk4.1
Requires:       gtk3
Requires:       libappindicator-gtk3

# Disable automatic dependency generation (we use pre-built binary)
AutoReqProv:    no

# Don't strip the binary (already optimized)
%global __os_install_post %{nil}
%global debug_package %{nil}

%description
Fluux Messenger is a modern, user-friendly XMPP chat client built with
Tauri and React. It provides a clean interface for real-time messaging
using the XMPP protocol.

Features include:
- One-to-one and group chat (MUC)
- Message reactions and replies
- File sharing via HTTP Upload
- Desktop notifications
- Cross-platform (Linux, macOS, Windows)

%prep
%setup -q

%install
# Install binary
install -Dm755 fluux-messenger %{buildroot}%{_bindir}/fluux-messenger

# Install desktop file
install -Dm644 fluux-messenger.desktop %{buildroot}%{_datadir}/applications/fluux-messenger.desktop

# Install icons
install -Dm644 icons/32x32.png %{buildroot}%{_datadir}/icons/hicolor/32x32/apps/fluux-messenger.png
install -Dm644 icons/64x64.png %{buildroot}%{_datadir}/icons/hicolor/64x64/apps/fluux-messenger.png
install -Dm644 icons/128x128.png %{buildroot}%{_datadir}/icons/hicolor/128x128/apps/fluux-messenger.png
install -Dm644 icons/256x256.png %{buildroot}%{_datadir}/icons/hicolor/256x256/apps/fluux-messenger.png

%files
%{_bindir}/fluux-messenger
%{_datadir}/applications/fluux-messenger.desktop
%{_datadir}/icons/hicolor/*/apps/fluux-messenger.png

%changelog
* Tue Feb 11 2025 ProcessOne <contact@process-one.net> - 0.12.1-1
- See https://github.com/processone/fluux-messenger/blob/main/CHANGELOG.md
