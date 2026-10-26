# Screenshot provenance

These images capture the actual shipped React interface using an isolated browser origin/profile with no access to the author's native desktop app data.

- `overview.png`: white theme, built-in Developer Simulation; balances are synthetic and labeled.
- `agent-room.png`: empty Agent Room, no connected models, no messages or inference calls.
- `settings.png`: appearance settings, no configured credentials or server addresses.
- `hud.png`: the actual `App` main-screen HUD and its expanded quota details, using the built-in developer simulation in the burgundy theme. The crop contains synthetic quota values, not a connected account.
- `dock.png`: two instances of the actual `DockWindow` component, captured at collapsed and expanded sizes inside a presentation page. The native position request is mocked; all other native operations are rejected. The avatar and launcher entries are the public defaults. Captions and a neutral gradient backdrop are part of the capture page, not software controls.

External data requests were blocked during capture; only local assets were loaded. The images verify interface presentation only; they are not evidence of live provider connectivity, installed launcher applications, window transparency, screen-edge placement or other native Windows behavior. No author's personal avatar, watchlist, accounts or chats are included. Capture date: 2026-10-26.
