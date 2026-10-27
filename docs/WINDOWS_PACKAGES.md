# Windows packages

GleamDesk targets 64-bit Windows 10/11. The Windows distribution has two forms:

| Package | Use |
| --- | --- |
| Portable ZIP | Extract to a writable folder and run `GleamDesk.exe`; no app installation required |
| `-setup.exe` | NSIS installer with English / Simplified Chinese, installed for the current user |

The portable ZIP includes the executable, project license, third-party notices and a short guide. **Portable means installation-free, not a self-contained user profile**: settings, history, avatars and credentials still use the normal local app-data and Windows credential stores.

Both forms require Microsoft Edge WebView2 Runtime. The installer checks for it and downloads Microsoft's bootstrapper if missing; this step requires Internet access. Portable users need to install the runtime separately if their system does not already have it.

## Build

Install the prerequisites from [Building](BUILDING.md), then:

```powershell
npm.cmd ci
$env:CARGO_TARGET_DIR = Join-Path $PWD 'src-tauri/target'
$flags = @(
  ('--remap-path-prefix=' + $PWD.Path + '=/gleamdesk'),
  ('--remap-path-prefix=' + $env:USERPROFILE + '=/developer')
)
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
npm.cmd run tauri -- build --bundles nsis -- --locked
```

The remapping prevents developer machine paths from being retained in Rust source-location strings. It does not replace checking the resulting package for private content. For a subsequent build with cached dependencies, `--offline --locked` can be used after the final `--`.

Outputs are `src-tauri/target/release/GleamDesk.exe` and the installer in `src-tauri/target/release/bundle/nsis`. Tauri can download its NSIS build tools on first use. Package the executable together with the project and third-party license files; do not copy app-data folders, credentials, development caches or configuration from your own installation.

Use the shared packaging script after a successful NSIS build:

```powershell
./scripts/package-windows.ps1 -OutputDirectory ./artifacts/windows-packages
```

Choose an empty output directory. The script includes only the executable and public Tauri bundle resources, creates a portable ZIP, copies the installer, and writes `SHA256SUMS.txt` and `BUILD-METADATA.json`. It requires matching product versions and does not overwrite existing packages. Always build both outputs from the intended source revision first; version equality alone does not prove they came from the same revision. CI uses a fresh checkout and builds both in the same job.

## GitHub Actions builds

The [Windows build workflow](../.github/workflows/windows-build.yml) runs on GitHub-hosted `windows-2022` machines for relevant pushes to `main` or `codex/**`, and can also be started manually from the repository's Actions tab. It installs Node.js 22 and Rust 1.98.1, uses both dependency lockfiles, runs frontend tests, and builds the native executable plus NSIS installer. Build caches remain under the checkout's `src-tauri/target`; only final packages, checksums and metadata are uploaded.

Each run stores a Windows x64 artifact without a Windows publisher signature for seven days. It does not publish a GitHub Release or connect to the maintainer's VPS. Optional updater signing uses a separately configured repository secret; it remains unconfigured when the maintainer signs locally. User downloads belong in GitHub Releases, where packages do not have this seven-day Actions retention limit. Download an Actions artifact only when testing a specific build, unzip the Actions archive, and then extract the portable ZIP before running the app. The source commit and workflow run are recorded in the metadata. Successful CI means the tests and packaging completed; it does not verify GUI interaction, installation, upgrade or uninstallation.

SignPath integration is not enabled. Its OSS GitHub integration requires GitHub-hosted build jobs and verified build artifacts; see [SignPath's GitHub documentation](https://docs.signpath.io/trusted-build-systems/github). A signing policy, account verification and Foundation approval are separate steps.

## Verify and run

For update checks, confirmed in-app installation and the first manual installation needed by older releases, see [Version and updates](UPDATES.md). Do not manually delete application data when replacing an older program version.

- Compare the downloaded package's SHA-256 with the distributed checksums.
- Extract the ZIP before running the portable executable.
- Start the workbench from the top HUD. Closing the workbench hides it; use the HUD menu to exit the entire app.
- Do not enable optional paid, SSH or service connections until you have configured your own account and endpoint.

Current packages have no Windows publisher signature; Windows may identify an unknown publisher. The separate updater signature is used by GleamDesk to verify future in-app upgrades, and does not establish a Windows publisher identity or reputation. Building a valid installer is separate from verifying installation, upgrade and removal on a clean Windows machine; release notes must state which checks were actually performed.

### 0.1.0 local verification

On 2026-10-26, the x64 portable executable started its Dock, HUD and workbench on a development Windows machine. The current-user installer was installed into a separate test directory, its installed executable matched the portable executable's SHA-256, and its Dock and HUD started successfully. Uninstall removed the test application, shortcuts and uninstall registration. A second installation/removal with the application stopped preserved all 306 existing profile files byte-for-byte. The original AgentRoom executable was unchanged.

This was not a clean virtual-machine test. First-time WebView2 installation, upgrades from earlier public packages, other Windows versions and signed-publisher behavior remain unverified. Downloads and release status are listed on [GitHub Releases](https://github.com/liuyuanlong3232-bit/GleamDesk/releases).
