# Changelog

## [Unreleased]

### 0.1.1 candidate

- Hide unconfigured API cards and the VPS polling interval from the first-use overview; configured account failures remain visible.
- Normalize transparent padding for all extracted Windows app icons, fall back from empty jumbo slots, refresh old automatic icons once, and preserve explicitly selected custom icons on re-drop.
- Ship the creator-authorized brand avatar as the theme-aware default; local avatar replacement remains available.

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
