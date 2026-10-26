use std::{path::PathBuf, time::Duration};
use serde_json::Value;

const SCRIPT: &str = r#"
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class CodexFileIcons {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info {
  public IntPtr icon; public int index; public uint attributes;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string display;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=80)] public string type;
 }
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern IntPtr SHGetFileInfo(string path,uint attrs,out Info info,uint size,uint flags);
 [DllImport("shell32.dll",PreserveSig=true)] public static extern int SHGetImageList(int imageList,ref Guid iid,out IntPtr imageListPointer); [DllImport("comctl32.dll",EntryPoint="ImageList_GetIcon")] public static extern IntPtr ImageListGetIcon(IntPtr imageList,int index,uint flags);
 [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
 public static System.Drawing.Bitmap VisibleBitmap(System.Drawing.Bitmap image) {
  int left=image.Width,top=image.Height,right=-1,bottom=-1;
  for(int y=0;y<image.Height;y++) for(int x=0;x<image.Width;x++) {
   if(image.GetPixel(x,y).A<=12) continue;
   left=Math.Min(left,x);top=Math.Min(top,y);right=Math.Max(right,x);bottom=Math.Max(bottom,y);
  }
  // A jumbo image-list slot can be empty; let the caller try the fallback icon.
  if(right<left) return null;
  int width=right-left+1,height=bottom-top+1;
  if(width>=image.Width*.75 && height>=image.Height*.75) return image;
  int padding=Math.Max(1,(int)Math.Round(Math.Min(width,height)*.02));
  int cropX=Math.Max(0,left-padding),cropY=Math.Max(0,top-padding);
  var area=new System.Drawing.Rectangle(cropX,cropY,Math.Min(image.Width-cropX,width+padding*2),Math.Min(image.Height-cropY,height+padding*2));
  return image.Clone(area,System.Drawing.Imaging.PixelFormat.Format32bppArgb);
 }
}
'@
$encoded=[Console]::In.ReadToEnd().Trim()
$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded)) | ConvertFrom-Json
$shell=New-Object -ComObject WScript.Shell
$results=@(foreach($path in $paths){
 if(-not(Test-Path -LiteralPath $path)){continue}
 $file=Get-Item -LiteralPath $path
 $extension=$file.Extension.ToLowerInvariant()
 $name=$file.BaseName; if($file.PSIsContainer){$name=$file.Name}
 $kind=if($extension -eq '.lnk'){'shortcut'}elseif($extension -eq '.url'){'url'}else{'exe'}
 $target=$file.FullName; $arguments=$null; $processName=$null
 if($extension -eq '.lnk'){
  $link=$shell.CreateShortcut($file.FullName)
  $arguments=[string]$link.Arguments
  if($link.TargetPath){$processName=[IO.Path]::GetFileNameWithoutExtension([string]$link.TargetPath)}
 }
 if($extension -eq '.url'){
  $urlLine=Get-Content -LiteralPath $path | Where-Object {$_ -match '^URL='} | Select-Object -First 1
  if(-not $urlLine){continue}; $target=$urlLine.Substring(4).Trim()
  $uri=$null; if(-not[Uri]::TryCreate($target,[UriKind]::Absolute,[ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo){continue}
 }
 $icon=''; $iconPath=$file.FullName; $iconIndex=0
 if($extension -eq '.lnk'){
  $link=$shell.CreateShortcut($file.FullName)
  $location=[Environment]::ExpandEnvironmentVariables([string]$link.IconLocation).Trim()
  if($location -match '^(.*),\s*(-?\d+)$'){
   $candidate=$matches[1].Trim().Trim('"')
   if($candidate){$iconPath=$candidate;$iconIndex=[int]$matches[2]}
   elseif($link.TargetPath){$iconPath=[string]$link.TargetPath}
  }
  elseif($location){$iconPath=$location.Trim('"')}
  elseif($link.TargetPath){$iconPath=[string]$link.TargetPath}
 }
  $icon='';$fallbackPath=$file.FullName;if($iconPath -and (Test-Path -LiteralPath $iconPath)){$fallbackPath=$iconPath}
 $info=New-Object CodexFileIcons+Info
 # Resolve the shortcut itself so its IconLocation resource index is respected.
 $shellPath=if($extension -eq '.lnk'){$file.FullName}else{$fallbackPath}
 $systemList=[CodexFileIcons]::SHGetFileInfo($shellPath,0,[ref]$info,[Runtime.InteropServices.Marshal]::SizeOf($info),0x4000)
 $imageList=[IntPtr]::Zero;$iconHandle=[IntPtr]::Zero
 try {
  if($systemList -ne [IntPtr]::Zero -and $info.index -ge 0){
   $iid=[Guid]'46EB5926-582E-4017-9FDF-E8998DAA0950'
   $hr=[CodexFileIcons]::SHGetImageList(4,[ref]$iid,[ref]$imageList)
   if($hr -ge 0 -and $imageList -ne [IntPtr]::Zero){
    $iconHandle=[CodexFileIcons]::ImageListGetIcon($imageList,$info.index,0x20)
    if($iconHandle -ne [IntPtr]::Zero){
     $native=[System.Drawing.Icon]::FromHandle($iconHandle);$copy=$native.Clone()
     try {$bitmap=$copy.ToBitmap();$stream=New-Object IO.MemoryStream;$visible=$null
      try {$visible=[CodexFileIcons]::VisibleBitmap($bitmap);if($visible){$visible.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);$icon='data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray())}}finally{if($visible -and -not[Object]::ReferenceEquals($visible,$bitmap)){$visible.Dispose()};$stream.Dispose();$bitmap.Dispose()}
     } finally {$copy.Dispose()}
    }
   }
  }
 } catch {} finally {
  if($iconHandle -ne [IntPtr]::Zero){[void][CodexFileIcons]::DestroyIcon($iconHandle)}
  if($imageList -ne [IntPtr]::Zero){[void][Runtime.InteropServices.Marshal]::Release($imageList)}
 }
 if(-not $icon){
  $info=New-Object CodexFileIcons+Info;$iconHandle=[IntPtr]::Zero
  try {
   [void][CodexFileIcons]::SHGetFileInfo($shellPath,0,[ref]$info,[Runtime.InteropServices.Marshal]::SizeOf($info),0x100)
   if($info.icon -ne [IntPtr]::Zero){
    $iconHandle=$info.icon;$native=[System.Drawing.Icon]::FromHandle($iconHandle);$copy=$native.Clone()
    try {$bitmap=$copy.ToBitmap();$stream=New-Object IO.MemoryStream;$visible=$null
     try {$visible=[CodexFileIcons]::VisibleBitmap($bitmap);if($visible){$visible.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png);$icon='data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray())}}finally{if($visible -and -not[Object]::ReferenceEquals($visible,$bitmap)){$visible.Dispose()};$stream.Dispose();$bitmap.Dispose()}
    } finally {$copy.Dispose()}
   }
  } catch {} finally {if($iconHandle -ne [IntPtr]::Zero){[void][CodexFileIcons]::DestroyIcon($iconHandle)}}
 }
 @{name=$name;type=$kind;target=$target;sourcePath=$file.FullName;arguments=$arguments;processName=$processName;icon=$icon}
})
$json=ConvertTo-Json -InputObject $results -Depth 4 -Compress
[regex]::Replace($json,'[^\x00-\x7f]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
"#;

#[tauri::command]
pub async fn extract_original_app_icons(paths: Vec<String>) -> Result<Vec<Value>, String> {
    if paths.is_empty() || paths.len() > 16 || paths.iter().any(|path| path.len() > 2048 || path.contains('\0') || !PathBuf::from(path).is_absolute() || path.starts_with("\\\\")) {
        return Err("一次最多拖入16个本机文件或文件夹".into());
    }
    for path in &paths {
        let path = PathBuf::from(path);
        if !path.is_dir() && !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ["exe","lnk","url"].contains(&ext.to_ascii_lowercase().as_str())) {
            return Err("Dock 支持 EXE、LNK、文件夹和网址快捷方式".into());
        }
    }
    #[cfg(windows)] {
        tauri::async_runtime::spawn_blocking(move || {
            let system = std::env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\Windows"));
            let body = serde_json::to_vec(&paths).map_err(|_| "拖入信息无效")?;
            let encoded=crate::launcher::base64_encode(&body);
            let value = crate::cli_reader::read_cli_json_input(&system.join("System32/WindowsPowerShell/v1.0/powershell.exe"), &["-NoProfile","-NonInteractive","-Command",SCRIPT], Duration::from_secs(15), Some(encoded.as_bytes()))?;
            value.as_array().cloned().ok_or_else(|| "应用元数据读取失败".into())
        }).await.map_err(|_| "应用拖入任务失败".to_string())?
    }
    #[cfg(not(windows))] { Err("当前平台不能解析 Windows 文件".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test]
    fn jumbo_icons_crop_transparent_padding_and_reject_empty_slots() {
        let definition=SCRIPT.split_once("Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'\n").unwrap().1.split_once("\n'@").unwrap().0;
        let script=format!("Add-Type -AssemblyName System.Drawing\nAdd-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'\n{definition}\n'@\n{}",r#"
$small=New-Object Drawing.Bitmap(256,256)
$g=[Drawing.Graphics]::FromImage($small);$g.Clear([Drawing.Color]::Transparent);$g.FillRectangle([Drawing.Brushes]::Red,100,90,32,32);$g.Dispose()
$cropped=[CodexFileIcons]::VisibleBitmap($small)
$empty=New-Object Drawing.Bitmap(256,256)
$full=New-Object Drawing.Bitmap(48,48);$g=[Drawing.Graphics]::FromImage($full);$g.Clear([Drawing.Color]::Blue);$g.Dispose()
@{width=$cropped.Width;height=$cropped.Height;empty=($null -eq [CodexFileIcons]::VisibleBitmap($empty));unchanged=[Object]::ReferenceEquals($full,[CodexFileIcons]::VisibleBitmap($full))}|ConvertTo-Json -Compress
$cropped.Dispose();$small.Dispose();$empty.Dispose();$full.Dispose()
"#);
        let executable=PathBuf::from(std::env::var_os("WINDIR").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let result=crate::cli_reader::read_cli_json(&executable,&["-NoProfile","-NonInteractive","-Command",&script],Duration::from_secs(15)).unwrap();
        assert_eq!(result["width"],34);assert_eq!(result["height"],34);assert_eq!(result["empty"],true);assert_eq!(result["unchanged"],true);
    }
    #[test]
    #[ignore = "reads owned workspace fixtures without launching their targets"]
    fn inspect_owned_shortcut_url_and_folder_fixtures() {
        let workspace=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let directory=workspace.join("artifacts/phase3-ai-integration-2026-10-07/dock-fixtures");
        let paths=["Fixture Notepad.exe","Fixture Notepad.lnk","Fixture Website.url","Fixture Folder"].map(|name|directory.join(name).to_string_lossy().into_owned());
        let result=tauri::async_runtime::block_on(extract_original_app_icons(paths.to_vec())).unwrap();
        assert_eq!(result.len(),4);
        assert_eq!(result[0]["type"],"exe");
        assert_eq!(result[1]["type"],"shortcut");
        assert_eq!(result[1]["processName"],"notepad");
        assert_eq!(result[2]["type"],"url");
        assert_eq!(result[2]["target"],"https://example.com/");
        assert_eq!(result[3]["type"],"exe");
        for item in &result { assert!(item["icon"].as_str().unwrap().starts_with("data:image/png;base64,")); }
        println!("Owned EXE, LNK, URL and folder metadata/icons verified; targets not launched");
    }
    #[test]
    fn drop_ingress_rejects_commands_remote_paths_and_oversized_batches() {
        assert!(tauri::async_runtime::block_on(extract_original_app_icons(vec!["C:\\script.ps1".into()])).is_err());
        assert!(tauri::async_runtime::block_on(extract_original_app_icons(vec!["\\\\remote\\secret.exe".into()])).is_err());
        assert!(tauri::async_runtime::block_on(extract_original_app_icons(vec!["C:\\app.exe".into();17])).is_err());
    }
    #[test]
    #[ignore = "reads actual Windows executable/folder names and associated icon assets"]
    fn inspect_windows_original_icons_without_launching_targets() {
        let folder=std::env::current_dir().unwrap();
        let executable=std::env::var_os("WINDIR").map(PathBuf::from).unwrap().join("System32/notepad.exe");
        let result=tauri::async_runtime::block_on(extract_original_app_icons(vec![executable.to_string_lossy().into_owned(),folder.to_string_lossy().into_owned()])).unwrap();
        println!("{}",serde_json::json!({"entries":result.iter().map(|item|serde_json::json!({"name":item["name"],"targetIsString":item["target"].is_string()})).collect::<Vec<_>>()}));
        assert_eq!(result.len(),2);
        for item in &result { assert!(item["icon"].as_str().unwrap().starts_with("data:image/png;base64,")); }
        println!("{}",serde_json::json!({"count":result.len(),"icons":result.iter().map(|item|item["icon"].as_str().unwrap().len()).collect::<Vec<_>>(),"targetsLaunched":false}));
    }
}
