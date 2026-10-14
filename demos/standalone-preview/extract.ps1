param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$demoRoot=$PSScriptRoot
$repoRoot=[IO.Path]::GetFullPath((Join-Path $demoRoot '../..'))
$expected=[IO.Path]::GetFullPath((Join-Path $repoRoot 'dist/video-analysis-standalone-preview-20261014'))
if ([IO.Path]::GetFullPath($Target) -ne $expected -or (Test-Path -LiteralPath $expected)) { throw 'Unexpected or existing output; refusing overwrite.' }
[IO.Directory]::CreateDirectory($expected) | Out-Null
function Expand-Known([string]$Archive,[bool]$Tools) {
 $zip=[IO.Compression.ZipFile]::OpenRead($Archive)
 try {
  foreach($entry in $zip.Entries) {
   $name=$entry.FullName.Replace('\','/')
   if($name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..')) { throw 'Unsafe ZIP entry.' }
   if($name.EndsWith('/')) { continue }
   if($Tools) {
    if($name -match '/bin/(ffmpeg.exe|ffprobe.exe|[^/]+\.dll)$') { $relative='resources/tools/'+$Matches[1] }
    elseif($name -match '/LICENSE.txt$') { $relative='licenses/FFmpeg-LICENSE.txt' }
    else { continue }
   } else {
    if($name -eq 'resources/default_app.asar') { continue }
    $relative=if($name -eq 'electron.exe') {'VideoAnalysisPreview.exe'} else {$name}
   }
   $destination=[IO.Path]::GetFullPath((Join-Path $expected $relative))
   if(-not $destination.StartsWith($expected+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP boundary escape.' }
   $script:expanded+=$entry.Length
   if($script:expanded -gt 640MB) { throw 'Extraction budget exceeded.' }
   [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
   [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
  }
 } finally { $zip.Dispose() }
}
$script:expanded=0
Expand-Known (Join-Path $demoRoot 'work/electron-v44.7.2-win32-x64.zip') $false
Expand-Known (Join-Path $demoRoot 'work/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip') $true
Write-Output "Extracted $script:expanded bytes into the dedicated portable output."
