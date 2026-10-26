$ErrorActionPreference='Stop'
$out=@(foreach($p in @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'")){
 if(!$p.ExecutablePath -or $p.ExecutablePath -notmatch '\\antigravity\\resources\\bin\\language_server\.exe$'){continue}
 $token=''
 if($p.CommandLine -match '--csrf_token(?:=|\s+)["'']?([^\s"'']+)'){$token=$matches[1]}
 if(!$token){continue}
 $ports=@(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Where-Object {$_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::')} | Select-Object -ExpandProperty LocalPort -Unique)
 @{pid=$p.ProcessId;token=$token;ports=$ports}
})
ConvertTo-Json -InputObject @{candidates=$out} -Compress -Depth 4
