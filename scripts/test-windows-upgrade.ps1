[CmdletBinding()]
param([ValidateSet('Prepare','InstallOld','Verify','Cleanup')][string]$Stage='Prepare')
$ErrorActionPreference='Stop'
$project=Split-Path $PSScriptRoot -Parent
$root=Join-Path $project 'node_modules/.cache/upgrade-acceptance'
$product='GleamDesk Upgrade Acceptance'
$identifier='org.gleamdesk.upgrade-acceptance'
$installed=Join-Path $root 'installed'
$roaming=Join-Path ([Environment]::GetFolderPath('ApplicationData')) $identifier
$local=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $identifier
$reg="HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$product"
$manufacturer="HKCU:\Software\$product\$product"
$utf8=[Text.UTF8Encoding]::new($false)
function WriteJson($path,$value) { [IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 8),$utf8) }
function FileHashes { @($script:synthetic | ForEach-Object { [ordered]@{path=$_;sha256=(Get-FileHash -LiteralPath $_).Hash} }) }
function ProductionMetadata {
    # Binary/installation metadata only; never open any personal AppData or credential store.
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GleamDesk'
    $entry=if(Test-Path $key){Get-ItemProperty -LiteralPath $key}else{$null}
    $exe=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'GleamDesk/GleamDesk.exe'
    [ordered]@{version=$entry.DisplayVersion;location=$entry.InstallLocation;binaryHash=$(if(Test-Path -LiteralPath $exe){(Get-FileHash -LiteralPath $exe).Hash}else{$null})}
}
if($Stage -eq 'Prepare') {
    $owner=Join-Path $root 'owned-test.marker'
    $resume=(Test-Path -LiteralPath $owner) -and ([IO.File]::ReadAllText($owner) -eq $identifier)
    foreach($path in @($reg,$manufacturer,(Join-Path $root 'prepared.json'),(Join-Path $root 'fixture.key'))) { if(Test-Path -LiteralPath $path){throw "Pre-existing fixture state; refusing to overwrite: $path"} }
    if(-not $resume){foreach($path in @($root,$roaming,$local)) { if(Test-Path -LiteralPath $path){throw "Pre-existing fixture path; refusing to overwrite: $path"} }}
    $target=if($env:CARGO_TARGET_DIR){$env:CARGO_TARGET_DIR}else{Join-Path $project 'src-tauri/target'}
    $templateDir=Join-Path $target 'release/nsis/x64'
    $template=[IO.File]::ReadAllText((Join-Path $templateDir 'installer.nsi'))
    if($template -notmatch '(?m)^!define VERSION "0.1.3"\r?$' -or $template -notmatch '!define INSTALLMODE "currentUser"'){throw 'Build the current-user 0.1.3 NSIS installer first.'}
    New-Item -ItemType Directory -Path $root,$roaming,(Join-Path $local 'EBWebView/Default') -Force | Out-Null
    [IO.File]::WriteAllText($owner,$identifier,$utf8)
    foreach($name in @('utils.nsh','FileAssociation.nsh')) { Copy-Item -LiteralPath (Join-Path $templateDir $name) -Destination $root }
    $csc=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    $makensis=Join-Path $env:LOCALAPPDATA 'tauri/NSIS/makensis.exe'
    $source=[IO.File]::ReadAllText((Join-Path $project 'src-tauri/tests/fixtures/upgrade-gui.cs'))
    foreach($version in @('0.1.2','0.1.3')) {
        $folder=Join-Path $root $version;New-Item -ItemType Directory -Path $folder -Force|Out-Null
        $cs=Join-Path $folder 'fixture.cs';$exe=Join-Path $folder 'GleamDeskUpgradeFixture.exe'
        [IO.File]::WriteAllText($cs,$source.Replace('FIXTURE_VERSION',$version),$utf8)
        & $csc /nologo /target:winexe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll "/out:$exe" $cs
        if($LASTEXITCODE -ne 0){throw 'Fixture compile failed'}
        $defines=[ordered]@{MANUFACTURER=$product;PRODUCTNAME=$product;VERSION=$version;VERSIONWITHBUILD="$version.0";MAINBINARYNAME='GleamDeskUpgradeFixture';MAINBINARYSRCPATH=$exe;BUNDLEID=$identifier;OUTFILE=(Join-Path $root "fixture-$version-setup.exe");DISPLAYLANGUAGESELECTOR='false';INSTALLWEBVIEW2MODE='skip'}
        $nsi=$template
        foreach($name in $defines.Keys){
            $pattern='(?m)^!define '+[regex]::Escape($name)+' "[^"\r\n]*"\r?$'
            if([regex]::Matches($nsi,$pattern).Count -ne 1){throw "Unexpected NSIS define: $name"}
            $replacement='!define '+$name+' "'+$defines[$name]+'"'
            $nsi=[regex]::Replace($nsi,$pattern,[Text.RegularExpressions.MatchEvaluator]{param($m) $replacement})
        }
        $script=Join-Path $root "fixture-$version.nsi";[IO.File]::WriteAllText($script,$nsi,[Text.UTF8Encoding]::new($true))
        Push-Location $root
        try{ & $makensis /V2 $script *> (Join-Path $root "nsis-$version.log");if($LASTEXITCODE -ne 0){throw "NSIS compile failed; inspect nsis-$version.log"} }finally{Pop-Location}
    }
    $cli=Join-Path $project 'node_modules/.bin/tauri.cmd'
    # Disposable test trust only. Never sign synthetic executable code with production trust.
    $generated=& $cli signer generate --ci --write-keys (Join-Path $root 'fixture.key') 2>&1
    if($LASTEXITCODE -ne 0){throw 'Disposable test key generation failed'}
    $savedPath=$env:TAURI_SIGNING_PRIVATE_KEY_PATH;$savedKey=$env:TAURI_SIGNING_PRIVATE_KEY
    try{
        $env:TAURI_SIGNING_PRIVATE_KEY_PATH=Join-Path $root 'fixture.key';$env:TAURI_SIGNING_PRIVATE_KEY=$null
        $signed=& $cli signer sign --app-version 0.1.3 (Join-Path $root 'fixture-0.1.3-setup.exe') 2>&1
        if($LASTEXITCODE -ne 0){throw 'Fixture signing failed'}
    }finally{$env:TAURI_SIGNING_PRIVATE_KEY_PATH=$savedPath;$env:TAURI_SIGNING_PRIVATE_KEY=$savedKey}
    $signature=([IO.File]::ReadAllText((Join-Path $root 'fixture-0.1.3-setup.exe.sig'))).Trim()
    WriteJson (Join-Path $root 'latest.json') @{version='0.1.3';platforms=@{'windows-x86_64'=@{signature=$signature;url='https://example.invalid/upgrade-fixture.exe'}}}
    [IO.File]::WriteAllText((Join-Path $roaming 'synthetic-only.marker'),'Synthetic acceptance files only.',$utf8)
    [IO.File]::WriteAllText((Join-Path $roaming 'settings.json'),'{"name":"Synthetic User","theme":"light","automaticPaidCalls":false}',$utf8)
    [IO.File]::WriteAllText((Join-Path $roaming 'watchlist.json'),'["AAPL","600000.SH","0700.HK"]',$utf8)
    [IO.File]::WriteAllText((Join-Path $roaming 'history.json'),'[{"id":"synthetic-1","text":"offline fixture"}]',$utf8)
    [IO.File]::WriteAllBytes((Join-Path $roaming 'avatar.png'),[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII='))
    [IO.File]::WriteAllText((Join-Path $local 'EBWebView/Default/Preferences'),'{"synthetic":true,"locale":"zh-CN"}',$utf8)
    $script:synthetic=@('settings.json','watchlist.json','history.json','avatar.png')|ForEach-Object{Join-Path $roaming $_}
    $script:synthetic+=Join-Path $local 'EBWebView/Default/Preferences'
    WriteJson (Join-Path $root 'prepared.json') @{product=$product;identifier=$identifier;installDirectory=$installed;synthetic=FileHashes;production=ProductionMetadata;templateHash=(Get-FileHash -LiteralPath (Join-Path $templateDir 'installer.nsi')).Hash}
    Write-Output 'Prepared two isolated NSIS fixtures and synthetic data. No installation yet.'
    exit
}
$prepared=Get-Content -LiteralPath (Join-Path $root 'prepared.json') -Raw|ConvertFrom-Json
if($prepared.product -ne $product -or $prepared.identifier -ne $identifier -or $prepared.installDirectory -ne $installed){throw 'Fixture identity mismatch'}
if($Stage -eq 'InstallOld'){
    if((Test-Path -LiteralPath $reg) -or (Test-Path -LiteralPath $installed)){throw 'Already installed; refusing to overwrite'}
    $process=Start-Process -FilePath (Join-Path $root 'fixture-0.1.2-setup.exe') -ArgumentList "/S /NS /D=$installed" -Wait -PassThru
    if($process.ExitCode -ne 0){throw 'Old fixture install failed'}
    $entry=Get-ItemProperty -LiteralPath $reg
    if($entry.DisplayVersion -ne '0.1.2' -or $entry.InstallLocation.Trim('"') -ne $installed){throw 'Old fixture registration mismatch'}
    Write-Output 'Independent old fixture installed: 0.1.2. Ready for SDK update test.'
    exit
}
$results=@($prepared.synthetic|ForEach-Object{[ordered]@{file=(Split-Path $_.path -Leaf);retained=((Get-FileHash -LiteralPath $_.path).Hash -eq $_.sha256)}})
if(@($results|Where-Object{-not $_.retained}).Count){throw 'Synthetic data changed'}
if((ProductionMetadata|ConvertTo-Json -Compress) -ne ($prepared.production|ConvertTo-Json -Compress)){throw 'Production install metadata changed'}
if($Stage -eq 'Verify'){
    $entry=Get-ItemProperty -LiteralPath $reg
    $exe=Join-Path $installed 'GleamDeskUpgradeFixture.exe'
    if($entry.DisplayVersion -ne '0.1.3' -or $entry.InstallLocation.Trim('"') -ne $installed){throw 'New fixture registration mismatch'}
    if((Get-FileHash -LiteralPath $exe).Hash -ne (Get-FileHash -LiteralPath (Join-Path $root '0.1.3/GleamDeskUpgradeFixture.exe')).Hash){throw 'Installed payload differs'}
    if(-not(Test-Path -LiteralPath (Join-Path $roaming 'started-0.1.3.txt'))){throw 'Updated GUI did not start'}
    $sdk=Get-Content -LiteralPath (Join-Path $root 'sdk-verified.json') -Raw|ConvertFrom-Json
    WriteJson (Join-Path $root 'result.json') @{from='0.1.2';to='0.1.3';sdk=$sdk;registeredVersion=$entry.DisplayVersion;installedPayloadMatches=$true;restartedGui=$true;syntheticData=$results;productionInstallUnchanged=$true;cleanWindows=$false;realBusinessAppTested=$false;credentialsAccessed=$false}
    Write-Output 'SDK upgrade, payload, registry, restarted GUI and all five synthetic files verified.'
    exit
}
if($Stage -eq 'Cleanup'){
    $entry=Get-ItemProperty -LiteralPath $reg
    if($entry.InstallLocation.Trim('"') -ne $installed){throw 'Refusing to uninstall an unexpected directory'}
    $expected=[IO.Path]::GetFullPath((Join-Path $project 'node_modules/.cache/upgrade-acceptance/installed'))
    if([IO.Path]::GetFullPath($installed) -ne $expected){throw 'Uninstall target is outside fixture workspace'}
    if(Get-Process -Name GleamDeskUpgradeFixture -ErrorAction SilentlyContinue){throw 'Fixture window must exit before cleanup'}
    $process=Start-Process -FilePath (Join-Path $installed 'uninstall.exe') -ArgumentList '/S' -Wait -PassThru
    if($process.ExitCode -ne 0){throw 'Fixture uninstall failed'}
    for($attempt=0;$attempt -lt 20 -and ((Test-Path -LiteralPath $reg) -or (Test-Path -LiteralPath (Join-Path $installed 'GleamDeskUpgradeFixture.exe')));$attempt++){Start-Sleep -Milliseconds 250}
    if((Test-Path -LiteralPath $reg) -or (Test-Path -LiteralPath (Join-Path $installed 'GleamDeskUpgradeFixture.exe'))){throw 'Fixture uninstall has not completed'}
    foreach($file in $prepared.synthetic){if((Get-FileHash -LiteralPath $file.path).Hash -ne $file.sha256){throw 'Uninstall changed synthetic data'}}
    if((ProductionMetadata|ConvertTo-Json -Compress) -ne ($prepared.production|ConvertTo-Json -Compress)){throw 'Production metadata changed during test cleanup'}
    WriteJson (Join-Path $root 'cleanup-result.json') @{uninstallEntryRemoved=$true;testExecutableRemoved=$true;syntheticDataRetained=$true;productionInstallUnchanged=$true}
    Write-Output 'Independent fixture uninstalled. Synthetic files and evidence retained; no manual recursive deletion.'
}
