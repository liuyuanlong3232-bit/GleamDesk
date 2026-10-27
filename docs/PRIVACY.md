# Privacy and local data

GleamDesk does not require an author-hosted server. The source distribution contains no author runtime configuration, account database, private avatar uploads, service credential or historical development commits.

The default illustrated avatar is intentionally distributed as the creator-authorized public brand logo. It is a bundled visual asset, not a connected user account; users can replace it locally.

## What stays on the computer

Preferences, selected instruments, layouts, avatar media, message/history data and configured connections are stored locally. Supported secret values use Windows Credential Manager. Normal source publication does not export these runtime stores or erase an existing user's installation.

GleamDesk credentials use their own `GleamDesk.*` names. Legacy AgentRoom credentials are not used automatically. If detected, Settings → API balances and costs offers an explicit local import. Import copies supported API, chat, mail and VPS credentials without deleting the originals or replacing existing GleamDesk accounts. It does not test connections or enable automatic paid recommendations. Normal updates retain GleamDesk credentials, preferences, watchlists and history; the first transition to the separate credential store turns off automatic paid recommendations once, requiring renewed consent. No old application-data folders or browser profiles are imported by this action.

Some optional local-agent integrations inspect local application status and usage sources. Enable and use only integrations you want. Do not share those local source files in issues.

## Network requests

Enabled data providers contact their listed public sources directly. Those services can see normal request metadata, including the connecting IP address and requested instrument. Optional model, mail, SSH and service connections contact endpoints selected by the user. Their operators' terms and privacy policies apply.

AI prompts or attachments sent through configured models are transmitted to those providers. A free data source does not make a configured AI model free. Simulation mode is separate from live data.

The app does not promise anonymity, universal offline operation or availability on every network. It does not silently route traffic through the author's VPS or change system proxy settings.

## Public screenshots and bug reports

Repository screenshots use a separate clean browser-preview profile. Demonstration values, if shown, are identified as such. They do not contain the author's configured servers, accounts, watchlist or chats.

Never upload a full app-data folder, browser profile, SSH configuration, credential export, raw API response or database. Redact usernames, emails, server addresses, tokens and private conversations before attaching logs or screenshots. GitHub publishes the repository owner's public username and ordinary contribution metadata.
