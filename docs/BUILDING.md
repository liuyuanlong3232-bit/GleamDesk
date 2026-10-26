# Build from source

## Windows requirements

- Windows 10/11, with WebView2 Runtime.
- Node.js 22 or later, npm and Git.
- Rust stable using the MSVC toolchain.
- Visual Studio Build Tools with **Desktop development with C++** and a Windows SDK.

The native integrations target Windows. macOS and Linux releases are not provided or verified.

## Get the source

```powershell
git clone https://github.com/liuyuanlong3232-bit/GleamDesk.git
cd GleamDesk
npm.cmd ci
```

## Develop

```powershell
npm.cmd run tauri -- dev
```

For a browser-only layout preview, run `npm.cmd run dev` and open `http://127.0.0.1:1420/dashboard.html`. Native hardware, credentials and service APIs do not work in a plain browser.

## Validate

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
$env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
cargo check --locked --manifest-path src-tauri/Cargo.toml
```

Native unit tests use `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib`. Some Windows test executables require a Common Controls v6 application manifest; if a test process exits with `0xc0000139`, diagnose the manifest before treating it as a failed business assertion. No system configuration change is required.

## Build the desktop executable

```powershell
$env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
npm.cmd run tauri -- build --debug --no-bundle
```

This produces a debug desktop executable under `src-tauri/target/debug`. Omit `--debug` for an optimized build. First-time dependency downloads require network access. `--offline --locked` can be passed to Cargo only after dependencies are cached.

Build outputs are unsigned. Do not include `node_modules`, `dist`, Cargo `target`, databases, credentials or logs in a source contribution. Rust debug libraries and incremental caches can use several GB; keep them in the development directory.
