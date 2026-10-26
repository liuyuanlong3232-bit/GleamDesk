# Architecture at a glance

GleamDesk has a React/TypeScript interface and a Tauri/Rust Windows host.

| Area | Source | Responsibility |
| --- | --- | --- |
| Desktop surfaces | `src/App.tsx`, `src/components`, `src-tauri/src/lib.rs` | HUD, Dock, workbench and native window behavior |
| Data providers | `src/providers` | Provider selection, polling, cache and error state |
| Domain validation | `src/domain` | Source contracts, instrument identity, units, dates and freshness |
| Native sources | `src-tauri/src/public_sources.rs` and source modules | Bounded HTTP reads and source parsing |
| Optional services | `src-tauri/src/beszel.rs`, `vps_services.rs` | User-configured monitoring and read-only service snapshots |
| Agent Room | `src/components/AgentRoom.tsx`, `src-tauri/src/agent_room_workspace.rs` | Conversation UI, model configuration and guarded sends |
| Local persistence | `src/services`, native storage and credential modules | Settings, media, history and Windows secrets |

Public source adapters retain source dates and units. Failed reads remain unavailable or explicitly stale; simulation data is separate. Browser rendering verifies layout only. Native Windows behavior, authentication and actual connectivity need separate real-environment checks.
