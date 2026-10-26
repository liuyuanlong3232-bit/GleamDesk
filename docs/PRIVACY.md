# Privacy and local data

GleamDesk does not require an author-hosted server. The source distribution contains no author runtime configuration, account database, personal avatar, service credential or historical development commits.

## What stays on the computer

Preferences, selected instruments, layouts, avatar media, message/history data and configured connections are stored locally. Supported secret values use Windows Credential Manager. Normal source publication does not export these runtime stores or erase an existing user's installation.

Some optional local-agent integrations inspect local application status and usage sources. Enable and use only integrations you want. Do not share those local source files in issues.

## Network requests

Enabled data providers contact their listed public sources directly. Those services can see normal request metadata, including the connecting IP address and requested instrument. Optional model, mail, SSH and service connections contact endpoints selected by the user. Their operators' terms and privacy policies apply.

AI prompts or attachments sent through configured models are transmitted to those providers. A free data source does not make a configured AI model free. Simulation mode is separate from live data.

The app does not promise anonymity, universal offline operation or availability on every network. It does not silently route traffic through the author's VPS or change system proxy settings.

## Public screenshots and bug reports

Repository screenshots use a separate clean browser-preview profile. Demonstration values, if shown, are identified as such. They do not contain the author's configured servers, accounts, watchlist or chats.

Never upload a full app-data folder, browser profile, SSH configuration, credential export, raw API response or database. Redact usernames, emails, server addresses, tokens and private conversations before attaching logs or screenshots. GitHub publishes the repository owner's public username and ordinary contribution metadata.
