# Changelog

## [Unreleased]

## [0.1.7] - 2026-11-06

- Add optional read-only email reminders and verification-code copying for QQ, 163, Gmail and Outlook. Keep authorization in a separate Windows credential namespace; keep message summaries and codes in memory.
- Show mailbox icons, connection states and recent messages in the HUD. Move the account with the newest message to the top with a short animation. Old messages do not trigger arrival notifications.
- Open the corresponding webmail site in the default browser by clicking a message; keep code copying independent. Browser login may still be required.
- Use the mailbox width for all click-expanded HUD panels and adapt their width, position and scroll limits to available screen space.
- QQ and 163 connection/list display and a 163 browser-open action were verified locally; Gmail/Outlook real-account flows and new-message arrival/copy remain only partially verified.

## [0.1.6] - 2026-11-05

- Redesign click-expanded HUD details while retaining the compact icon bar; center details beneath it and simplify enabled API account balances.
- Keep DeepSeek currencies separate and preserve Claude model-specific quota names and Antigravity groups.
- Read Doubao official quotas using the desktop client's active profile. With permission, keep a profile-bound Windows-encrypted login cache for up to seven days so quota queries work while the client holds its database open. Include reported subscription and incentive quotas without inventing missing values.
- Add Kimi Code quota reading for current and legacy response formats. Parser tests pass; real-subscription compatibility has not been verified locally.

## [0.1.5] - 2026-11-01

- Add GitHub, Skills, Hugging Face Spaces and Show HN daily recommendations with animated arrow paging; reopen on GitHub and retain source ranks, timestamps and cached results.
- Translate English recommendation text and selected news locally with the bundled offline model; retain original text. No paid translation API is used. Machine translations can misinterpret names and technical terms.
- Use standard Windows workbench controls for minimize, maximize, restore and edge resizing.
- Remove the mail module and local development-task execution; retain Agent Room conversations and existing local account data.
- Keep the application identity, current-user installation and version-bound updater signatures. This release has no trusted Windows publisher signature.

## [0.1.4] - 2026-10-28

- Add confirmed, current-user Windows login startup through a GleamDesk shortcut, with working-directory validation, legacy-entry migration, failure recovery and targeted uninstall cleanup.
- Add Windows desktop icon visibility controls with independent status reporting; simulation mode does not read or change these Windows settings.
- Accept full English month names in USDA export-inspection publication dates while preserving strict date validation.
- The 0.1.4 package passed local runtime, current-user installation and independently checked startup registration; the user then reported successful launch after a real reboot. The official SDK verified its version-bound update signature and rejected tampered content and a substituted version. This does not establish a complete registered-old-version upgrade or clean-Windows acceptance.

## [0.1.3] - 2026-10-27

- Add optional startup update notifications and a Version & Updates settings page. Downloads and installation require explicit confirmation; portable builds retain manual downloads.
- Verify version-bound update signatures before the official Tauri NSIS upgrade flow; preserve the existing application identity and local data paths.
- Document third-party data and asset rights, and require consent before local AI tools read selected application data.
- Validate the installer upgrade using a separate synthetic product: official SDK signature verification, NSIS 0.1.2 to 0.1.3 upgrade, automatic relaunch and unchanged settings/avatar/watchlist/history/WebView-style files. This does not establish clean-Windows or full-business-application upgrade acceptance.

## [0.1.2] - 2026-10-27

- Isolate GleamDesk credentials from legacy AgentRoom accounts. Offer explicit local import only when supported legacy credentials are detected; preserve originals and existing GleamDesk accounts.
- Preserve GleamDesk preferences, watchlists and history on update. Disable automatic paid recommendations once during the credential-store transition; retain renewed consent on subsequent updates.
- Document maintainer and AI-assistance roles and use the maintainer's GitHub noreply identity for new commits.

- Hide unconfigured API cards and the VPS polling interval from the first-use overview; configured account failures remain visible.
- Normalize transparent padding for all extracted Windows app icons, fall back from empty jumbo slots, refresh old automatic icons once, and preserve explicitly selected custom icons on re-drop.
- Ship the creator-authorized brand avatar as the theme-aware default; local avatar replacement remains available.
- Launch normal Dock apps, shortcuts and URLs through the native Windows Shell instead of an encoded PowerShell helper.
- Match the Dock drop highlight to its rounded surface and clear the hint after cancellation or completion.
- Add unsigned Windows x64 package builds in GitHub Actions, with portable ZIP, NSIS installer, SHA-256 checksums and source metadata.
- Use locale-independent evidence ordering so Chinese and English Windows installations produce the same analysis batch digest.

## [0.1.0] - 2026-10-26

### Added

- Public source release under the name **GleamDesk · 栖光桌面**.
- Windows HUD, Dock, workbench, local resource views and Agent Room.
- Direct public news, reference market prices, exchange rates and agricultural data providers.
- Market watchlist entry for A-shares, US stocks, Hong Kong stocks and supported futures codes.
- Editable display name and local avatar selection.
- Optional read-only Beszel, 3x-ui, sing-box and Tailscale connections.
- Optional startup of an already-installed local Beszel Hub using its existing database.
- Bilingual README, user/developer documentation and clean UI preview screenshots.
- Windows x64 portable ZIP and current-user NSIS installer, with SHA-256 checksums.
- Dedicated Dock and HUD previews, interaction guides and feature descriptions.

### Fixed

- Windows closed-port probe timing for local Hub startup.
- Various text alignment, theme contrast and HUD exit confirmation issues from the development version.

### Release status

Initial public Windows release. Both binaries are unsigned; no publisher-signature or SmartScreen reputation claim is made. Portable startup and current-user installation/startup/uninstall were checked on the development computer; clean-machine, WebView2 first-install and upgrade testing remain unverified. Historical development commits and author-specific runtime data are excluded.
