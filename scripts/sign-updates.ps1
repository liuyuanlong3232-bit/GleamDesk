[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$output = [IO.Path]::GetFullPath($OutputDirectory)
$metadataPath = Join-Path $output 'BUILD-METADATA.json'
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$config = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$version = [string]$config.version
if ($metadata.version -ne $version -or $version -notmatch '^\d+\.\d+\.\d+$') { throw 'Source and package versions must match a stable release.' }
if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) { throw 'No updater signing key supplied. Existing unsigned packages remain unchanged.' }
foreach ($line in Get-Content -LiteralPath (Join-Path $output 'SHA256SUMS.txt')) {
    if ($line -notmatch '^([0-9a-f]{64})  (GleamDesk_[0-9A-Za-z._-]+)$') { throw 'Invalid package checksum entry.' }
    $expected = $Matches[1]; $file = Join-Path $output $Matches[2]
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Package checksum mismatch; signing stopped.' }
}
$setupName = "GleamDesk_${version}_x64-setup.exe"
$setup = Join-Path $output $setupName
$signaturePath = $setup + '.sig'
$manifestPath = Join-Path $output 'latest.json'
if ((Test-Path -LiteralPath $signaturePath) -or (Test-Path -LiteralPath $manifestPath)) { throw 'Existing update metadata will not be overwritten.' }
$cli = Join-Path $projectRoot 'node_modules/.bin/tauri.cmd'
# Secrets are passed through the environment, never command arguments or output.
$signOutput = & $cli signer sign --app-version $version $setup 2>&1
if ($LASTEXITCODE -ne 0) { throw 'Updater signing failed. No update manifest was created.' }
$signature = (Get-Content -LiteralPath $signaturePath -Raw).Trim()
if ($signature.Length -lt 40 -or $signature.Length -gt 8192 -or $signature -notmatch '^[A-Za-z0-9+/=]+$') { throw 'Invalid updater signature output.' }
$manifest = [ordered]@{
    version = $version
    notes = "GleamDesk $version - see GitHub Release for changes."
    pub_date = [DateTime]::UtcNow.ToString('o')
    platforms = [ordered]@{
        'windows-x86_64' = [ordered]@{
            signature = $signature
            url = "https://github.com/liuyuanlong3232-bit/GleamDesk/releases/download/v$version/$setupName"
        }
    }
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
$packageFiles = @(Get-ChildItem -LiteralPath $output -File | Where-Object { $_.Name -match '^GleamDesk_[0-9A-Za-z._-]+\.(zip|exe|sig)$' -or $_.Name -eq 'latest.json' } | Sort-Object Name)
$checksums = @($packageFiles | ForEach-Object { '{0}  {1}' -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $_.Name })
[IO.File]::WriteAllLines((Join-Path $output 'SHA256SUMS.txt'), $checksums, [Text.Encoding]::ASCII)
$metadata | Add-Member -NotePropertyName updaterSigning -NotePropertyValue 'signed-with-version' -Force
$metadata.checksums = $checksums
[IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
Write-Output 'Updater signature and latest.json created. Windows publisher signature remains unchanged.'
