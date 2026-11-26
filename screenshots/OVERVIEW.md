# Fluux Messenger Visual Overview

All screenshots are generated automatically from the [demo mode](../docs/DEMO_MODE.md) using Playwright. Run `npm run screenshots` to regenerate them.

---

## Release 0.18.0

| Desktop room read state | Native iPhone conversation | Native iPhone list |
| --- | --- | --- |
| <a href="./release-0.18.0-desktop-unread.png"><img src="./release-0.18.0-desktop-unread.png" width="400" alt="Desktop room-list crop showing an unread count on Design Review's avatar without mentions"/></a> | <a href="./release-0.18.0-ios-chat.png"><img src="./release-0.18.0-ios-chat.png" width="180" alt="Native iPhone conversation with an attachment, reply and unread divider"/></a> | <a href="./release-0.18.0-ios-list.png"><img src="./release-0.18.0-ios-list.png" width="180" alt="Native iPhone conversation list with avatars and unread badges"/></a> |

The iPhone images come from the unsigned isolated native demo in iOS Simulator,
not a mobile browser. iOS support is experimental. See the
[release media notes](../docs/blog/fluux-messenger-0.18.0-media.md) for reproduction
and the [blog thumbnail](./blog-hero-0.18.0.png).

## Core Experience

| 1:1 Chat                                                                                    | Group Chat with Members                                                                                   |
|---------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------|
| <a href="./01-chat-dark.png"><img src="./01-chat-dark.png" width="400" alt="1:1 Chat"/></a> | <a href="./02-group-chat-dark.png"><img src="./02-group-chat-dark.png" width="400" alt="Group Chat"/></a> |
| *Direct messages with reactions, replies, and file sharing*                                 | *Multi-user chat with roles, occupant panel, and moderation*                                              |

| Conversation List                                                                                                              | Contact Directory                                                                                            |
|--------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| <a href="./03-conversation-list-dark.png"><img src="./03-conversation-list-dark.png" width="400" alt="Conversation List"/></a> | <a href="./04-contacts-dark.png"><img src="./04-contacts-dark.png" width="400" alt="Contact Directory"/></a> |
| *Every conversation with its unread badge*                                                                                     | *User profiles with presence, devices, and timezone*                                                         |

## Polls, Code, and Emoji

| Polls                                                                                    | Code Blocks                                                                                                |
|------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| <a href="./05-poll-dark.png"><img src="./05-poll-dark.png" width="400" alt="Polls"/></a> | <a href="./06-code-block-dark.png"><img src="./06-code-block-dark.png" width="400" alt="Code Blocks"/></a> |
| *Emoji voting with single/multi-vote modes and live tallies*                             | *Syntax-highlighted code blocks with language detection*                                                   |

| Emoji Autocomplete                                                                                                                       |
|--------------------------------------------------------------------------------------------------------------------------------------------|
| <a href="./31-emoji-autocomplete-dark.png"><img src="./31-emoji-autocomplete-dark.png" width="400" alt="Emoji Autocomplete"/></a>        |
| *Type `:` and a keyword to complete emoji inline, with arrow-key navigation*                                                              |

## Read State

| Unread Badge and New-Message Divider                                                                                       |
|----------------------------------------------------------------------------------------------------------------------------|
| <a href="./32-read-state-dark.png"><img src="./32-read-state-dark.png" width="400" alt="Read State"/></a>                  |
| *One unread count per conversation, and a divider marking where reading stopped*                                           |

## Security & Privacy

| Encrypted Chat                                                                                                        | Encryption Settings                                                                                                                  |
|-----------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| <a href="./25-chat-encrypted-dark.png"><img src="./25-chat-encrypted-dark.png" width="400" alt="Encrypted Chat"/></a> | <a href="./26-settings-encryption-dark.png"><img src="./26-settings-encryption-dark.png" width="400" alt="Encryption Settings"/></a> |
| *OpenPGP end-to-end encryption with per-message trust badges*                                                          | *Key generation, fingerprint, server backup, and key export*                                                                         |

| Whisper (Private Room Message)                                                                       |
|------------------------------------------------------------------------------------------------------|
| <a href="./27-whisper-dark.png"><img src="./27-whisper-dark.png" width="400" alt="Whisper"/></a>     |
| *Private "whisper" messages to a single room occupant (XEP-0045 §7.5)*                                |

## Administration

| Server Overview                                                                                       |
|-------------------------------------------------------------------------------------------------------|
| <a href="./07-admin-dark.png"><img src="./07-admin-dark.png" width="400" alt="Server Overview"/></a>  |
| *Server status (uptime, version, users, rooms) plus user and room management*                         |

## Customization

| Settings & Themes                                                                                   |
|-----------------------------------------------------------------------------------------------------|
| <a href="./08-settings-dark.png"><img src="./08-settings-dark.png" width="400" alt="Settings"/></a> |
| *14 built-in themes, custom accent colors, font sizes, and CSS overrides*                           |

## Saved Messages

| Saved list and the message in context | Save from the More menu |
| --- | --- |
| <a href="./34-saved-dark.png"><img src="./34-saved-dark.png" width="400" alt="Saved messages list with five entries, beside the selected message highlighted in its conversation"/></a> | <a href="./35-save-message-dark.png"><img src="./35-save-message-dark.png" width="400" alt="The More menu of a message offering Save message"/></a> |
| *A private list kept on your account and shared by all your devices* | *Save any message from its More menu* |

## Forwarding

<a href="./showcase/08-forward-dark.png"><img src="./showcase/08-forward-dark.png" width="100%" alt="A direct chat with Olivia Park holding a comment and a forwarded card naming Liam, the Launch Crew room, the time and the original text"/></a>

*Forwarded from Liam in Launch Crew: the message names its source, and the card opens the original when it is available*

## Search & Navigation

| Search                                                                                        | Command Palette                                                                                                          |
|-----------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------|
| <a href="./09-search-dark.png"><img src="./09-search-dark.png" width="400" alt="Search for poster filtered to messages with an image, with the matching message previewed"/></a> | <a href="./10-command-palette-dark.png"><img src="./10-command-palette-dark.png" width="400" alt="Command Palette"/></a> |
| *Filters for sender, date and content, with a preview in context*                                      | *Keyboard-accessible launcher for conversations and actions*                                                             |

| Find in Conversation |
| --- |
| <a href="./36-find-in-conversation-dark.png"><img src="./36-find-in-conversation-dark.png" width="400" alt="Find in conversation with the match highlighted"/></a> |
| *Cmd+F searches the open conversation and highlights each match* |

## Light Mode

| 1:1 Chat (Light)                                                                                | Group Chat (Light)                                                                                                |
|-------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| <a href="./11-chat-light.png"><img src="./11-chat-light.png" width="400" alt="Chat Light"/></a> | <a href="./12-group-chat-light.png"><img src="./12-group-chat-light.png" width="400" alt="Group Chat Light"/></a> |

## Theme Showcase

| Nord                                                                                    | Dracula                                                                                          | Gruvbox                                                                                          |
|-----------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------|
| <a href="./13-chat-nord.png"><img src="./13-chat-nord.png" width="250" alt="Nord"/></a> | <a href="./14-chat-dracula.png"><img src="./14-chat-dracula.png" width="250" alt="Dracula"/></a> | <a href="./15-chat-gruvbox.png"><img src="./15-chat-gruvbox.png" width="250" alt="Gruvbox"/></a> |

| Catppuccin Mocha                                                                                                            | Rose Pine                                                                                              |
|-----------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------|
| <a href="./16-chat-catppuccin-mocha.png"><img src="./16-chat-catppuccin-mocha.png" width="250" alt="Catppuccin Mocha"/></a> | <a href="./17-chat-rose-pine.png"><img src="./17-chat-rose-pine.png" width="250" alt="Rose Pine"/></a> |

## Internationalization

| French                                                                                | Greek                                                                                |
|---------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------|
| <a href="./19-chat-fr.png"><img src="./19-chat-fr.png" width="400" alt="French"/></a> | <a href="./20-chat-el.png"><img src="./20-chat-el.png" width="400" alt="Greek"/></a> |
| *34 languages including all EU official languages and RTL languages*                  |                                                                                      |

| Arabic (RTL)                                                                          | Hebrew (RTL)                                                                          |
|---------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------|
| <a href="./21-chat-ar.png"><img src="./21-chat-ar.png" width="400" alt="Arabic"/></a> | <a href="./22-chat-he.png"><img src="./22-chat-he.png" width="400" alt="Hebrew"/></a> |
| *Full right-to-left layout support*                                                   |                                                                                       |

## Light & Dark Composite

<div align="center">
<a href="./23-chat-light-dark.png"><img src="./23-chat-light-dark.png" width="600" alt="Light and Dark themes"/></a>

*Diagonal split showing light and dark modes side by side*
</div>
