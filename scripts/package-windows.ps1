[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or $package.version -ne $version) {
    throw 'Package and Tauri versions must match and use a valid release version.'
}
$targetDirectory = if ($env:CARGO_TARGET_DIR) { [IO.Path]::GetFullPath($env:CARGO_TARGET_DIR) } else { Join-Path $projectRoot 'src-tauri/target' }
$executable = Join-Path $targetDirectory 'release/GleamDesk.exe'
$installer = Join-Path $targetDirectory "release/bundle/nsis/GleamDesk_${version}_x64-setup.exe"
foreach ($file in @($executable, $installer)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing build output: $file" }
}
foreach ($file in @($executable, $installer)) {
    if ((Get-Item -LiteralPath $file).VersionInfo.ProductVersion -ne $version) {
        throw 'The executable and installer product versions must match the source version. Build both again before packaging.'
    }
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
if ((Test-Path -LiteralPath $output) -and @(Get-ChildItem -LiteralPath $output -Force).Count -gt 0) {
    throw 'Use an empty output directory; existing packages will not be overwritten.'
}
$portable = Join-Path $output 'GleamDesk-portable'
New-Item -ItemType Directory -Path $portable -Force | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $portable 'GleamDesk.exe')
# Only the executable and the public resources listed in Tauri's bundle configuration belong in the portable package.
foreach ($resource in $config.bundle.resources.PSObject.Properties) {
    $source = [IO.Path]::GetFullPath((Join-Path (Join-Path $projectRoot 'src-tauri') $resource.Name))
    $destination = Join-Path $portable $resource.Value
    New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $destination -Recurse
}
$guide = @"
GleamDesk $version - Windows x64, unsigned build
Extract the complete ZIP, then run GleamDesk.exe. Microsoft Edge WebView2 Runtime is required.
Portable means installation-free. Settings and history still use the local AppData profile; credentials use Windows Credential Manager.
Exit the whole app from the top HUD context menu. Closing the workbench only hides it.
This build has no trusted publisher signature. SHA-256 checksums verify file integrity, not publisher identity.
The default illustrated avatar is the creator-authorized brand logo and can be changed locally.
Source and documentation: https://github.com/liuyuanlong3232-bit/GleamDesk
Third-party notices are included in LICENSE and licenses.
"@
[IO.File]::WriteAllText((Join-Path $portable 'README.txt'), $guide, [Text.UTF8Encoding]::new($false))
$zip = Join-Path $output "GleamDesk_${version}_windows_x64_portable.zip"
Compress-Archive -LiteralPath $portable -DestinationPath $zip
$setup = Join-Path $output (Split-Path $installer -Leaf)
Copy-Item -LiteralPath $installer -Destination $setup
$checksums = @($zip, $setup) | ForEach-Object {
    '{0}  {1}' -f (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant(), (Split-Path $_ -Leaf)
}
[IO.File]::WriteAllLines((Join-Path $output 'SHA256SUMS.txt'), $checksums, [Text.Encoding]::ASCII)
$revision = git -C $projectRoot rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
$metadata = [ordered]@{
    product = 'GleamDesk'; version = $version; sourceCommit = [string]$revision
    githubRunId = $env:GITHUB_RUN_ID; platform = 'windows-x64'
    builtAtUtc = [DateTime]::UtcNow.ToString('o'); signing = 'unsigned'
    checksums = $checksums
}
[IO.File]::WriteAllText((Join-Path $output 'BUILD-METADATA.json'), ($metadata | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Get-ChildItem -LiteralPath $output -File | Select-Object Name, Length
