# Privacy and local data

GleamDesk does not require an author-hosted server. The source distribution contains no author runtime configuration, account database, private avatar uploads, service credential or historical development commits.

The default illustrated avatar is intentionally distributed as the creator-authorized public brand logo. It is a bundled visual asset, not a connected user account; users can replace it locally.

## What stays on the computer

Preferences, selected instruments, layouts, avatar media, message/history data and configured connections are stored locally. Supported secret values use Windows Credential Manager. Normal source publication does not export these runtime stores or erase an existing user's installation.

GleamDesk credentials use their own `GleamDesk.*` names. Legacy AgentRoom credentials are not used automatically. If detected, Settings → API balances and costs offers an explicit local import. Import copies supported API, chat, mail and VPS credentials without deleting the originals or replacing existing GleamDesk accounts. It does not test connections or enable automatic paid recommendations. Normal updates retain GleamDesk credentials, preferences, watchlists and history; the first transition to the separate credential store turns off automatic paid recommendations once, requiring renewed consent. No old application-data folders or browser profiles are imported by this action.

## Local AI clients: opt in before account and usage reads

Settings → AI connections provides **“允许读取本机 AI 账号与用量”**. It defaults to **off**, including an existing profile that has not recorded this choice. This is separate from ordinary installed/running application detection, which remains available for the Dock and HUD. Running-process detection can inspect executable names and command lines to distinguish clients; it returns derived client IDs and counts, not their command lines.

With this choice off, GleamDesk does not start its local AI account/quota reader or Codex task-event reader. The native commands also reject calls that omit explicit consent. Existing client accounts, credentials, messages and quota-history files are not erased.

When enabled, the supported integrations may invoke installed official CLIs, inspect client configuration/cache metadata and local authentication sources, communicate with a running local language server, and contact the client's official usage service using its existing login. The returned information includes login/plan metadata, usage windows and reset times. Quota changes can be recorded in GleamDesk's local history. This is an account/usage query, not a model prompt request. It may still generate normal service access logs.

Codex task detection reads bounded portions of recent local session-event files. Those files can contain conversation text in memory while parsed; GleamDesk derives task state/counts from event metadata and does not return transcript text, paths or tokens through that command. This is **not** a promise that transcript files are never opened.

Turning the choice off stops subsequent polling and clears the current account/task display. An already-started CLI or network read may briefly finish, including a derived quota-history write; disabling does not delete earlier local history or cancel work already started. Its late result is not restored to the current account/task display. User-opened client/login windows remain open. Manual website login and supported membership reading use the respective official site; the account/usage switch is also required for the settings-page membership read.

Do not share local client source files in issues. This preference controls normal app behavior, not access by other software running as your Windows user.

## Network requests

Enabled data providers contact their listed public sources directly. Those services can see normal request metadata, including the connecting IP address and requested instrument. Optional model, mail, SSH and service connections contact endpoints selected by the user. Their operators' terms and privacy policies apply.

AI prompts or attachments sent through configured models are transmitted to those providers. A free data source does not make a configured AI model free. Simulation mode is separate from live data.

Embedded websites maintain cookies, sessions and site storage in the local WebView profile and make normal requests to those sites. Public news links open their publisher's website. A website's own collection policy is separate from GleamDesk's local storage. Optional automatic model recommendations can send the selected context when explicitly enabled; keep them disabled if you do not want those requests.

Public-source access is not a blanket data license. See the [data and asset rights record](DATA_AND_ASSET_RIGHTS.md) for confirmed conditions and unresolved items. In particular, the free Open-Meteo API is for non-commercial use, and FRED includes series-specific and AI-related restrictions.

The app does not promise anonymity, universal offline operation or availability on every network. It does not silently route traffic through the author's VPS or change system proxy settings.

## Public screenshots and bug reports

Repository screenshots use a separate clean browser-preview profile. Demonstration values, if shown, are identified as such. They do not contain the author's configured servers, accounts, watchlist or chats.

Never upload a full app-data folder, browser profile, SSH configuration, credential export, raw API response or database. Redact usernames, emails, server addresses, tokens and private conversations before attaching logs or screenshots. GitHub publishes the repository owner's public username and ordinary contribution metadata.

## Finding and removing local data

The retained application identity is `org.agentroom.desktop`. Windows app data normally lives under `%APPDATA%\org.agentroom.desktop`; WebView data normally lives under `%LOCALAPPDATA%\org.agentroom.desktop\EBWebView`. A development or isolated preview may use another explicitly configured profile. Local WebView storage contains settings and other browser-side state; app-data files include supported history and connection data. Recent application diagnostic events are stored locally (up to 200 entries); console or native logs may also be visible during development. Review any exported diagnostics before sharing.

To remove a connection, use its settings page. For full removal, first exit GleamDesk and back up what you want to retain; only then remove the corresponding app/profile data yourself. Windows Credential Manager entries named `GleamDesk.*` are separate from these folders and from old `CodexDesktop.*` entries. Uninstalling or changing this permission does not guarantee removal of credentials, WebView login sessions or files saved elsewhere. This change does not perform any deletion or credential migration.

Last reviewed against the local implementation: 2026-10-27. This document describes app behavior, not a guarantee about third-party websites or services.
