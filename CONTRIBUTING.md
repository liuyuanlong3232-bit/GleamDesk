# Contributing to GleamDesk

Thanks for helping improve 栖光桌面. Small fixes and clear bug reports are welcome.

## Before you start

Search existing issues first. For a large feature, discuss the user problem before implementing it. Keep changes focused and reuse the existing components and providers. Do not add a dependency when the platform or current code already provides the feature.

## Development

See [Building](docs/BUILDING.md). Use a branch for your change, then run:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Run the desktop app for changes involving windows, HUD, Dock, WebView, credentials or system integration. Browser previews cannot verify those behaviors. Describe what you actually tested, including failed or unavailable checks.

## Pull requests

- Explain the problem, resulting behavior and relevant validation.
- Include before/after screenshots for visible changes, with private information removed.
- Preserve source dates, units and missing-data states. Do not replace failed data with invented values.
- Never submit tokens, passwords, cookies, SSH keys, databases, user settings, real account responses, logs or build caches.
- Keep optional connections disabled unless the user explicitly enables them. Never silently change proxy, firewall or remote-server settings.

AI assistance is welcome. Review generated code, identify the tools used when useful, and verify claims and tests. Do not claim an AI provider officially maintains or endorses the project.

By contributing, you agree that your original contributions are available under the project's MIT license. Preserve existing third-party notices.
