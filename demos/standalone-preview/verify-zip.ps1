$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$repoRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$name='video-analysis-standalone-preview-20261014'
$zipPath=Join-Path $repoRoot "dist/$name.zip"
$zip=[IO.Compression.ZipFile]::OpenRead($zipPath)
try {
 $entries=@{}
 foreach($item in $zip.Entries) { $key=$item.FullName.Replace('\','/');if($entries.ContainsKey($key)) {throw 'Duplicate normalized ZIP entry.'};$entries[$key]=$item }
 $entry=$entries["$name/INTEGRITY.json"]
 if(-not $entry -or $entry.Length -gt 2MB) { throw 'Missing or oversized integrity manifest.' }
 $reader=[IO.StreamReader]::new($entry.Open())
 try { $manifest=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
 $files=@($zip.Entries | Where-Object {-not $_.FullName.Replace('\','/').EndsWith('/')})
 if($files.Count -ne $manifest.files.Count+1) { throw 'Unexpected ZIP file count.' }
 foreach($file in $manifest.files) {
  $entry=$entries["$name/$($file.path)"]
  if(-not $entry -or $entry.Length -ne $file.bytes) { throw "Missing/different entry $($file.path)" }
  $stream=$entry.Open();$sha=[Security.Cryptography.SHA256]::Create()
  try { $actual=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $stream.Dispose();$sha.Dispose() }
  if($actual -ne $file.sha256) { throw "ZIP content mismatch $($file.path)" }
 }
 $receipt=@{status='passed';kind='all-ZIP-file-hashes-versus-manifest';files=$files.Count;at=[DateTime]::UtcNow.ToString('o')}
 $json=$receipt | ConvertTo-Json
 $record=Join-Path $PSScriptRoot 'evidence/zip-audit.json'
 if(Test-Path -LiteralPath $record) { throw 'Existing audit preserved.' }
 [IO.File]::WriteAllText($record,$json)
 $json
} finally { $zip.Dispose() }
