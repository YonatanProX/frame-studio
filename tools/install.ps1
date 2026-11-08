<#
  Frame Studio - installer for Windows 10 / 11.  No administrator rights, no winget, nothing to install by hand.

  Normally started by the one-line installer (install.ps1 in the repository root, which first copies Frame Studio to
  %LOCALAPPDATA%\Programs\Frame Studio), or by double-clicking install.cmd in an extracted ZIP (installs in place).

  1. checks this computer: Node.js 24+, ffmpeg + ffprobe (with libx264), a browser (Google Chrome or Microsoft Edge)
  2. downloads PORTABLE copies of whatever is missing into <app>\runtime\ (Node.js from nodejs.org, ffmpeg from
     GitHub: gyan.dev's build, else BtbN; www.gyan.dev last) - checksums verified; nothing is installed system-wide
  3. settings (config.json) and your files folder: <your Documents folder>\Frame Studio (projects, Sounds) - the
     Documents folder Explorer shows, also when OneDrive or a policy moved it
  4. shortcuts: Desktop + Start Menu "Frame Studio", Start Menu "Frame Studio - my files" (opens the files folder) and
     "Uninstall Frame Studio", Apps & features entry
  5. the cutx command on PATH (user PATH, for new terminals)
  6. connects Frame Studio to Claude (asks once): Claude Desktop (MCP server) + Claude Code (skill + MCP server: claude mcp add, or .claude.json)
  7. final check, 8. starts Frame Studio
  Safe to run again at any time (it repairs / updates). Log: %LOCALAPPDATA%\Frame Studio\install.log

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1 [options]
    -DataDir <dir>             where projects + sounds live (default: <Documents>\Frame Studio; a git clone keeps them
                               in its own folder)
    -ForcePortable             use the portable Node.js / ffmpeg even if the computer already has them
    -NoShortcut                no Desktop / Start Menu shortcuts      -ShortcutDir <dir>  put the shortcuts there (tests)
    -NoPath                    do not add the folder to PATH          -NoRegistry  no Apps & features entry
    -NoClaude                  do not connect to Claude               -ClaudeDesktopConfig <file>  -ClaudeHome <dir>
                               -ClaudeJson <file> (Claude Code settings)  -ClaudeCli <claude.exe|none>   (tests)
    -NoStart                   do not open Frame Studio at the end    -Yes  no questions
    -DryRun                    only show what would be done           -NoPause  do not wait for Enter at the end
    -LogFile <file>            -AppDir <dir> (dry run only: report for that folder instead of this one)
  This file is saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew text correctly.
#>
[CmdletBinding()]
param(
  [string]$AppDir,
  [string]$DataDir,
  [switch]$ForcePortable,
  [switch]$NoShortcut,
  [string]$ShortcutDir,
  [switch]$NoPath,
  [switch]$NoRegistry,
  [string]$ClaudeDesktopConfig,
  [string]$ClaudeHome,
  [string]$ClaudeJson,
  [string]$ClaudeCli,
  [switch]$NoClaude,
  [switch]$NoStart,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$NoPause,
  [string]$LogFile,
  [switch]$Bootstrapped
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
if (-not $LogFile) { $LogFile = Join-Path $env:LOCALAPPDATA 'Frame Studio\install.log' }
. (Join-Path $PSScriptRoot 'setup-common.ps1')
$Steps = 8

$App = $Root
if ($AppDir) {
  $AppDir = [IO.Path]::GetFullPath($AppDir)
  if ((Normalize-Dir $AppDir) -ne (Normalize-Dir $Root)) {
    if (-not $DryRun) { Bad "-AppDir must be this folder ($Root) unless -DryRun is used." ; Finish 2 }
    $App = $AppDir
  }
}
$Runtime = Join-Path $App 'runtime'
$Summary = New-Object System.Collections.ArrayList
function Sum([string]$text) { [void]$Summary.Add($text) }
$Version = '?'
try { $Version = (Get-Content -LiteralPath (Join-Path $Root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { }
$IsGitClone = Test-Path -LiteralPath (Join-Path $App '.git')

Write-Log ''
Write-Log "=== Frame Studio $Version setup - $(Get-Date -Format s) - folder $App - args: $($PSBoundParameters.Keys -join ' ')"

Line ''
Line '  ==========================================================' 'White'
Line "   Frame Studio $Version - setup              התקנת Frame Studio" 'White'
Line '  ==========================================================' 'White'
Info "Program folder: $App" "תיקיית התוכנה: $App"
if ($DryRun) { Dry 'nothing will be downloaded, written or started · מצב בדיקה: שום דבר לא יורד, נכתב או מופעל' }
if (-not $Bootstrapped -and ($App -like "$env:TEMP*" -or $App -match '\\Temp\\')) {
  Warn 'This folder looks temporary. Extract the ZIP to a permanent folder (e.g. Documents) and run install.cmd there.' `
       'נראה שזו תיקייה זמנית. חלצו את ה-ZIP לתיקייה קבועה (למשל "מסמכים") והפעילו משם את install.cmd.'
}

# ── 1. check ──────────────────────────────────────────────────────────────────
Step 1 'Checking this computer' 'בודקים מה כבר יש במחשב'

$cfg = Read-Config
if (-not $cfg.Valid) {
  Warn "config.json is not valid JSON - settings will not be changed. Fix it or delete it, then run the installer again." `
       'הקובץ config.json פגום - ההגדרות לא ישתנו. תקנו או מחקו אותו והפעילו שוב את ההתקנה.'
}

function Test-X264([string]$exe) {
  if (-not (Test-File $exe)) { return $false }
  $enc = (& $exe -hide_banner -encoders 2>$null) -join "`n"
  return ($enc -match 'libx264')
}
function Get-FFVersion([string]$exe) {
  $v = @(& $exe -hide_banner -version 2>$null)[0]
  return ("$v" -replace '\s+Copyright.*$', '')
}

# ffmpeg / ffprobe the way the server finds them (env > config.json > PATH > runtime\ > the usual install folders)
function Find-FFTool([string]$name) {
  $exe = "$name.exe"
  $portable = Join-Path $Runtime "ffmpeg\bin\$exe"
  if ($ForcePortable) { if (Test-File $portable) { return $portable } else { return $null } }
  $envVal = [Environment]::GetEnvironmentVariable("FRAME_STUDIO_$($name.ToUpper())")
  $val = if ($envVal) { $envVal } else { Get-ConfigValue $cfg $name }
  if ($val -and $val -match '[\\/]') { $p = Resolve-ConfigPath $val; if (Test-File $p) { return $p } }
  elseif ($val -and $val -ne $name) { $p = Find-InPath ($val -replace '(\.exe)?$', '.exe') (Get-FreshPath); if ($p) { return $p } }
  $p = Find-InPath $exe (Get-FreshPath)
  if ($p) { return $p }
  if (Test-File $portable) { return $portable }
  foreach ($f in @("$env:LOCALAPPDATA\Microsoft\WinGet\Links\$exe", "$env:ProgramFiles\WinGet\Links\$exe",
      "$env:ProgramData\chocolatey\bin\$exe", "$HOME\scoop\shims\$exe", "C:\ffmpeg\bin\$exe", "$env:ProgramFiles\ffmpeg\bin\$exe")) {
    if (Test-File $f) { return $f }
  }
  $hits = @()
  foreach ($pk in @("$env:LOCALAPPDATA\Microsoft\WinGet\Packages", "$env:ProgramFiles\WinGet\Packages")) {
    if (-not (Test-Path -LiteralPath $pk)) { continue }
    foreach ($d in (Get-ChildItem -LiteralPath $pk -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'ffmpeg' })) {
      $dirs = @($d.FullName) + @(Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
      foreach ($x in $dirs) { $f = Join-Path $x "bin\$exe"; if (Test-File $f) { $hits += Get-Item -LiteralPath $f } }
    }
  }
  if ($hits.Count) { return ($hits | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
  return $null
}

$node = if ($ForcePortable) { Find-Node -PortableOnly -AppRoot $App } else { Find-Node -AppRoot $App }
$ffmpeg = Find-FFTool 'ffmpeg'
$ffprobe = Find-FFTool 'ffprobe'
$ffOk = $false
if ($ffmpeg -and $ffprobe) { $ffOk = Test-X264 $ffmpeg }
$browser = Find-Browser

if ($node.Ok) { Good "Node.js v$($node.Major)  $($node.Path)" }
elseif ($node.Path) { Info "Node.js v$($node.Major) is too old ($($node.Path)) - a portable Node.js $MinNode will be downloaded." "גרסת Node.js ישנה מדי - תורד גרסה ניידת $MinNode." }
elseif ($ForcePortable) { Info 'Node.js: the portable copy will be downloaded (-ForcePortable).' 'Node.js: תורד גרסה ניידת.' }
else { Info "Node.js $MinNode+ not found - a portable copy will be downloaded." "לא נמצא Node.js $MinNode ומעלה - תורד גרסה ניידת." }

if ($ffOk) { Good "ffmpeg   $ffmpeg"; Info (Get-FFVersion $ffmpeg); Good "ffprobe  $ffprobe" }
elseif ($ffmpeg -and $ffprobe) { Info "ffmpeg found but without the libx264 encoder ($ffmpeg) - a full portable build will be downloaded." 'נמצא ffmpeg בלי libx264 - תורד גרסה ניידת מלאה.' }
elseif ($ForcePortable) { Info 'ffmpeg: the portable copy will be downloaded (-ForcePortable).' 'ffmpeg: תורד גרסה ניידת.' }
else { Info 'ffmpeg not found - a portable copy will be downloaded.' 'לא נמצא ffmpeg - תורד גרסה ניידת.' }

if ($browser) {
  $bn = if ($browser -match 'msedge') { 'Microsoft Edge' } elseif ($browser -match 'Chromium') { 'Chromium' } else { 'Google Chrome' }
  Good "$bn  $browser"
} else {
  Bad 'No browser found: Frame Studio needs Google Chrome or Microsoft Edge (Edge comes with Windows - reinstall it from https://www.microsoft.com/edge).' `
      'לא נמצא דפדפן: Frame Studio צריך Google Chrome או Microsoft Edge (Edge מגיע עם Windows; אפשר להתקין מחדש מ-microsoft.com/edge).'
}

# ── 2. portable runtime ────────────────────────────────────────────────────────
Step 2 'Node.js and ffmpeg' 'Node.js ו-ffmpeg'

$DlDir = Join-Path $Runtime '.download'
function Assert-FreeSpace([long]$needMB) {
  try {
    $drive = New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($App))
    $free = [long]($drive.AvailableFreeSpace / 1MB)
    if ($free -lt $needMB) { Warn "Only $free MB free on $($drive.Name) - about $needMB MB are needed." "יש רק $free MB פנויים בכונן - צריך בערך $needMB MB." }
  } catch { }
}

function Install-PortableNode {
  $arch = 'x64'
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
  Info "Looking up the latest Node.js $MinNode LTS ($arch) on nodejs.org..." "מחפשים את Node.js $MinNode העדכני..."
  $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing -TimeoutSec 60
  $rel = @($index | Where-Object { $_.version -like "v$MinNode.*" -and (@($_.files) -contains "win-$arch-zip") })
  $pick = $rel | Where-Object { $_.lts } | Select-Object -First 1
  if (-not $pick) { $pick = $rel | Select-Object -First 1 }
  if (-not $pick) { throw "nodejs.org lists no Node.js $MinNode build for win-$arch" }
  $v = $pick.version
  $name = "node-$v-win-$arch.zip"
  $base = "https://nodejs.org/dist/$v"
  $zip = Join-Path $DlDir $name
  Save-Download "$base/$name" $zip "Node.js $v"
  $sums = [string](Invoke-RestMethod -Uri "$base/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 60)
  $want = $null
  foreach ($l in ($sums -split "`n")) { if ($l -match "^([0-9a-fA-F]{64})\s+$([regex]::Escape($name))\s*$") { $want = $Matches[1].ToLower() } }
  if (-not $want) { throw "SHASUMS256.txt has no checksum for $name" }
  $got = Get-Sha256 $zip
  if ($got -ne $want) { throw "checksum mismatch for $name (expected $want, got $got)" }
  Info "SHA-256 verified ($name)" 'בדיקת SHA-256 עברה'
  $x = Join-Path $DlDir 'node-x'
  if (Test-Path -LiteralPath $x) { Remove-Item -LiteralPath $x -Recurse -Force }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $x)
  $inner = Get-ChildItem -LiteralPath $x -Directory | Select-Object -First 1
  if (-not $inner -or -not (Test-File (Join-Path $inner.FullName 'node.exe'))) { throw "unexpected layout in $name" }
  $dest = Join-Path $Runtime 'node'
  if (Test-Path -LiteralPath $dest) {
    try { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop }
    catch { Rename-Item -LiteralPath $dest -NewName ("node.old-" + [DateTime]::Now.ToString('yyyyMMddHHmmss')) -ErrorAction Stop }
  }
  Move-Item -LiteralPath $inner.FullName -Destination $dest
  Remove-Item -LiteralPath $x -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  return (Join-Path $dest 'node.exe')
}

function Get-ExpectedHash([string]$shaUrl, [string]$fileName) {
  try { $txt = [string](Invoke-RestMethod -Uri $shaUrl -UseBasicParsing -TimeoutSec 60) } catch { return $null }
  foreach ($l in ($txt -split "`n")) {
    $l = $l.Trim()
    if (-not $l) { continue }
    if ($fileName) { if ($l -match "^([0-9a-fA-F]{64})\s+\*?(\./)?$([regex]::Escape($fileName))$") { return $Matches[1].ToLower() } }
    elseif ($l -match '^([0-9a-fA-F]{64})(\s|$)') { return $Matches[1].ToLower() }
  }
  return $null
}

# gyan.dev's release build as published on its GitHub mirror (GyanD/codexffmpeg): GitHub's CDN is fast everywhere,
# while www.gyan.dev itself is often throttled (~0.1 MB/s). The checksum comes from GitHub's asset digest, or from
# gyan.dev's .sha256 file (same zip) when the GitHub API cannot be asked (rate limit).
function Get-GyanGitHubSource {
  try {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/GyanD/codexffmpeg/releases/latest' -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'FrameStudio-Installer/1.0' }
    $a = @($rel.assets | Where-Object { $_.name -match '^ffmpeg-[\d.]+-essentials_build\.zip$' }) | Select-Object -First 1
    if ($a) {
      $h = $null
      if ("$($a.digest)" -match '^sha256:([0-9a-fA-F]{64})$') { $h = $Matches[1].ToLower() }
      return [pscustomobject]@{ Url = $a.browser_download_url; Hash = $h; Sha = $null; ShaName = $null }
    }
  } catch { Write-Log "        GitHub API (GyanD/codexffmpeg): $($_.Exception.Message)" }
  $v = "$(Invoke-RestMethod -Uri 'https://www.gyan.dev/ffmpeg/builds/release-version' -UseBasicParsing -TimeoutSec 30)".Trim()
  if ($v -notmatch '^[\d.]+$') { throw 'could not find the current ffmpeg version' }
  return [pscustomobject]@{ Url = "https://github.com/GyanD/codexffmpeg/releases/download/$v/ffmpeg-$v-essentials_build.zip"; Hash = $null
                            Sha = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256'; ShaName = $null }
}

function Install-PortableFFmpeg {
  # fastest first. Every source but the last is dropped when it is throttled (less than 3 MB in 20 s); the last one
  # always runs to the end, so a computer with a really slow connection still gets ffmpeg.
  $sources = @(
    [pscustomobject]@{ Name = 'GitHub (gyan.dev release essentials)'; Resolve = { Get-GyanGitHubSource } },
    [pscustomobject]@{ Name = 'GitHub (BtbN win64 gpl)'; Resolve = { [pscustomobject]@{
        Url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'; Hash = $null
        Sha = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256'; ShaName = 'ffmpeg-master-latest-win64-gpl.zip' } } },
    [pscustomobject]@{ Name = 'gyan.dev (release essentials)'; Resolve = { [pscustomobject]@{
        Url = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'; Hash = $null
        Sha = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256'; ShaName = $null } } }
  )
  # advanced / tests: FRAME_STUDIO_FFMPEG_SOURCES="3" or "1,3" picks and orders the sources above; an https:// (or
  # http://) entry is an extra zip to try at that place (a local mirror; no checksum - checked by running it)
  if ($env:FRAME_STUDIO_FFMPEG_SOURCES) {
    $pick = @(foreach ($e in ($env:FRAME_STUDIO_FFMPEG_SOURCES -split '[,\s]+')) {
      if ($e -match '^\d+$' -and [int]$e -ge 1 -and [int]$e -le $sources.Count) { $sources[[int]$e - 1] }
      elseif ($e -match '^https?://') {
        $u = $e
        [pscustomobject]@{ Name = $u; Resolve = { [pscustomobject]@{ Url = $u; Hash = $null; Sha = $null; ShaName = $null } }.GetNewClosure() }
      }
    })
    if ($pick.Count) { $sources = $pick }
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  for ($i = 0; $i -lt $sources.Count; $i++) {
    $s = $sources[$i]
    $isLast = ($i -eq $sources.Count - 1)
    $zip = Join-Path $DlDir 'ffmpeg.zip'
    try {
      $src = & $s.Resolve
      Info "Downloading ffmpeg from $($s.Name)..." "מורידים ffmpeg..."
      Write-Log "        ffmpeg source: $($src.Url)"
      $minBytes = if ($isLast) { 0 } else { 3MB }
      Save-Download $src.Url $zip 'ffmpeg' -MinBytesPerWindow $minBytes -WindowSec 20
      $want = if ($src.Hash) { $src.Hash } elseif ($src.Sha) { Get-ExpectedHash $src.Sha $src.ShaName } else { $null }
      if ($want) {
        $got = Get-Sha256 $zip
        if ($got -ne $want) { throw "checksum mismatch (expected $want, got $got)" }
        Info 'SHA-256 verified' 'בדיקת SHA-256 עברה'
      } else { Warn "No checksum published for this download - checked by running it instead." }
      $bin = Join-Path $DlDir 'ffmpeg-bin'
      if (Test-Path -LiteralPath $bin) { Remove-Item -LiteralPath $bin -Recurse -Force }
      New-Item -ItemType Directory -Force -Path $bin | Out-Null
      $za = [IO.Compression.ZipFile]::OpenRead($zip)
      try {
        $n = 0
        foreach ($e in $za.Entries) {
          if ($e.FullName -match '(^|/)bin/(ffmpeg|ffprobe)\.exe$') {
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $bin $e.Name), $true); $n++
          }
        }
      } finally { $za.Dispose() }
      if ($n -lt 2) { throw 'ffmpeg.exe / ffprobe.exe not found in the download' }
      if (-not (Test-X264 (Join-Path $bin 'ffmpeg.exe'))) { throw 'this ffmpeg build cannot run here or has no libx264' }
      $dest = Join-Path $Runtime 'ffmpeg\bin'
      if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction Stop }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
      Move-Item -LiteralPath $bin -Destination $dest
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      return (Join-Path $dest 'ffmpeg.exe')
    } catch {
      $msg = $_.Exception.Message
      Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
      if ($msg -like 'too slow*') {
        Warn "$($s.Name) is $msg - trying another server." 'השרת הזה איטי מדי - מנסים שרת אחר.'
      } elseif ($isLast) {
        Warn "ffmpeg from $($s.Name) failed: $msg"
      } else {
        Warn "ffmpeg from $($s.Name) failed: $msg - trying another server." 'ההורדה נכשלה - מנסים שרת אחר.'
      }
    }
  }
  throw 'ffmpeg could not be downloaded from any source'
}

$NodeSource = 'system'
$FFSource = 'system'
if (-not $node.Ok -or -not $ffOk) {
  if ($DryRun) {
    if (-not $node.Ok) { Dry "would download Node.js $MinNode (win zip, ~30 MB) from nodejs.org, verify SHA-256, unpack to $Runtime\node" }
    if (-not $ffOk) { Dry "would download ffmpeg (~110 MB) from GitHub (gyan.dev build; fallbacks: BtbN on GitHub, www.gyan.dev), verify SHA-256, keep ffmpeg.exe + ffprobe.exe in $Runtime\ffmpeg\bin" }
  } else {
    New-Item -ItemType Directory -Force -Path $DlDir | Out-Null
    Assert-FreeSpace 600
    if (-not $node.Ok) {
      try {
        $p = Install-PortableNode
        $node = [pscustomobject]@{ Path = $p; Major = (Get-NodeMajor $p); Ok = ((Get-NodeMajor $p) -ge $MinNode) }
        if ($node.Ok) { Good "Node.js v$($node.Major) (portable)  $p" 'Node.js נייד הותקן'; $NodeSource = 'portable' }
        else { Bad "The downloaded Node.js does not run: $p" }
      } catch { Bad "Node.js could not be downloaded: $($_.Exception.Message)" 'לא הצלחנו להוריד את Node.js (בדקו את החיבור לאינטרנט והפעילו שוב).' }
    }
    if (-not $ffOk) {
      try {
        $ffmpeg = Install-PortableFFmpeg
        $ffprobe = Join-Path (Split-Path -Parent $ffmpeg) 'ffprobe.exe'
        $ffOk = $true; $FFSource = 'portable'
        Good "ffmpeg (portable)  $ffmpeg" 'ffmpeg נייד הותקן'
        Info (Get-FFVersion $ffmpeg)
      } catch { Bad "ffmpeg could not be downloaded: $($_.Exception.Message)" 'לא הצלחנו להוריד את ffmpeg (בדקו את החיבור לאינטרנט והפעילו שוב).' }
    }
    Remove-Item -LiteralPath $DlDir -Recurse -Force -ErrorAction SilentlyContinue
  }
} else {
  Good 'Nothing to download - everything is already here.' 'אין מה להוריד - הכול כבר במחשב.'
}
if ($node.Ok -and (Normalize-Dir $node.Path).StartsWith((Normalize-Dir $Runtime))) { $NodeSource = 'portable' }
if ($ffOk -and $ffmpeg -and (Normalize-Dir $ffmpeg).StartsWith((Normalize-Dir $Runtime))) { $FFSource = 'portable' }

if (-not $node.Ok -and -not $DryRun) {
  Bad "Frame Studio cannot run without Node.js $MinNode+. Check the internet connection and run the installer again." `
      "Frame Studio לא יכול לפעול בלי Node.js $MinNode ומעלה. בדקו את החיבור לאינטרנט והפעילו שוב את ההתקנה."
  Finish 1
}
if ($node.Ok) {
  $nodeDir = Split-Path -Parent $node.Path
  $env:Path = "$nodeDir;$env:Path"
}

# ── 3. settings + your files ───────────────────────────────────────────────────
Step 3 'Settings and your files' 'הגדרות והתיקייה של הקבצים שלכם'

# where the user's projects + sounds live: "Frame Studio" in the Documents folder that Explorer shows. With OneDrive
# folder backup (the Windows 11 default) or a company policy that is NOT %USERPROFILE%\Documents, so ask Windows.
$DocsDir = [Environment]::GetFolderPath('MyDocuments')
if (-not $DocsDir) { $DocsDir = Join-Path $env:USERPROFILE 'Documents' }
$DefaultData = Join-Path $DocsDir 'Frame Studio'
function Get-ProjectCount([string]$dir) {
  return @(Get-ChildItem -LiteralPath (Join-Path $dir 'projects') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '.*' }).Count
}
$curData = Get-ConfigValue $cfg 'dataDir'
$DataReason = ''
$setData = $null
if ($DataDir) { $DataPath = [IO.Path]::GetFullPath($DataDir); $setData = $DataPath; $DataReason = '(-DataDir)' }
elseif ($curData) {
  $DataPath = Resolve-ConfigPath $curData; $DataReason = '(from config.json)'
  # earlier versions always wrote %USERPROFILE%\Documents\Frame Studio, a folder Explorer does not show when Documents
  # was moved; move the setting to the real Documents while nothing has been saved there yet
  $legacy = Join-Path $env:USERPROFILE 'Documents\Frame Studio'
  if ((Normalize-Dir $DataPath) -eq (Normalize-Dir $legacy) -and (Normalize-Dir $legacy) -ne (Normalize-Dir $DefaultData) -and (Get-ProjectCount $legacy) -eq 0) {
    $DataPath = $DefaultData; $setData = $DataPath; $DataReason = '(your Documents folder)'
  }
}
elseif ($IsGitClone) { $DataPath = $App; $DataReason = '(git clone: projects stay in this folder)' }
else {
  $old = Get-ProjectCount $App
  if ($old) { $DataPath = $App; $DataReason = "($old existing project(s) in this folder - kept here)" }
  else { $DataPath = $DefaultData; $setData = $DataPath }
}

$sets = @()
if ($setData) { $sets += "dataDir=$(To-JsonPath $setData)" }
if ($ffOk) {
  if ($FFSource -eq 'portable') {
    # relative to the program folder, so the setting survives when the folder is moved
    $sets += 'ffmpeg=runtime/ffmpeg/bin/ffmpeg.exe'; $sets += 'ffprobe=runtime/ffmpeg/bin/ffprobe.exe'
  } elseif (-not $env:FRAME_STUDIO_FFMPEG) {
    $cur = Get-ConfigValue $cfg 'ffmpeg'
    $onPath = Find-InPath 'ffmpeg.exe' (Get-FreshPath)
    $curOk = ($cur -and $cur -match '[\\/]' -and (Test-File (Resolve-ConfigPath $cur))) -or ((-not $cur -or $cur -eq 'ffmpeg') -and $onPath -and ((Normalize-Dir $onPath) -eq (Normalize-Dir $ffmpeg)))
    if (-not $curOk) { $sets += "ffmpeg=$(To-JsonPath $ffmpeg)"; $sets += "ffprobe=$(To-JsonPath $ffprobe)" }
  }
}

if (-not $cfg.Valid) {
  Warn 'Skipped: config.json is not valid JSON.' 'דילגנו: config.json פגום.'
} elseif ($node.Ok) {
  $cfgArgs = @()
  if ($DryRun) { $cfgArgs += '--dry-run' }
  $out = & $node.Path (Join-Path $Root 'tools\config-set.mjs') @cfgArgs @sets 2>&1
  $code = $LASTEXITCODE
  foreach ($l in $out) { if ($DryRun) { Dry "$l" } else { Info "$l" } }
  if ($code -ne 0) { Warn 'config.json could not be updated (see above).' 'לא הצלחנו לעדכן את config.json (פרטים למעלה).' }
} else {
  Dry "would write config.json: $($sets -join ', ')"
}

Info "Your files: $DataPath $DataReason" "הקבצים שלכם: $DataPath"
$SoundsPath = Join-Path $DataPath 'Sounds'
if ($DryRun) {
  Dry "would create $(Join-Path $DataPath 'projects') and $SoundsPath (with README.txt)"
} else {
  foreach ($d in @((Join-Path $DataPath 'projects'), $SoundsPath)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
  $readme = Join-Path $SoundsPath 'README.txt'
  if (-not (Test-File $readme)) {
    $txt = @(
      'Frame Studio - your sounds',
      '==========================',
      '',
      'Put sound effects and music here: copy whole folders (wav, mp3, flac, ogg, m4a ...) into this folder.',
      'Frame Studio finds them by itself - they show up in the Audio tab and Claude can search them.',
      'Sounds that are somewhere else (another drive, a big library)? In Frame Studio, the Audio tab has a button',
      'to add a sounds folder - nothing needs to be copied.',
      '',
      'Free, royalty-free sound effects: the Sonniss #GameAudioGDC bundles - https://sonniss.com/gameaudiogdc',
      '',
      '',
      'Frame Studio - הצלילים שלכם',
      '============================',
      '',
      'שימו כאן אפקטים קוליים ומוזיקה: מעתיקים לתיקייה הזו תיקיות שלמות (wav, mp3, flac, ogg, m4a ...).',
      'Frame Studio מוצא אותם לבד - הם מופיעים בלשונית האודיו וקלוד יכול לחפש בהם.',
      'הצלילים נמצאים במקום אחר (כונן אחר, ספרייה גדולה)? בלשונית האודיו ב-Frame Studio יש כפתור להוספת',
      'תיקיית צלילים - אין צורך להעתיק כלום.',
      '',
      'אפקטים קוליים בחינם וללא תמלוגים: חבילות Sonniss #GameAudioGDC - https://sonniss.com/gameaudiogdc'
    ) -join "`r`n"
    [IO.File]::WriteAllText($readme, $txt + "`r`n", (New-Object Text.UTF8Encoding $true))
  }
  Good "Projects: $(Join-Path $DataPath 'projects')  (finished videos: in each project's exports folder)" "הפרויקטים: $(Join-Path $DataPath 'projects') (הסרטונים המוכנים: בתיקייה exports של כל פרויקט)"
  Good "Sounds:   $SoundsPath  (drop sound folders here)" "צלילים: $SoundsPath (שימו כאן תיקיות צלילים)"
}
Sum "Your files: $DataPath"
Sum "הקבצים שלכם (פרויקטים, סרטונים מוכנים, צלילים): $DataPath"

# ── 4. shortcuts ──────────────────────────────────────────────────────────────
Step 4 'Shortcuts' 'קיצורי דרך'

# files from a downloaded ZIP carry a "from the internet" mark that makes Windows warn on every start; clear it
if (-not $DryRun) {
  Get-ChildItem -LiteralPath $App -Recurse -File -Include '*.cmd', '*.ps1' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike "$Runtime*" } | Unblock-File -ErrorAction SilentlyContinue
}

$icon = Join-Path $App 'app\icon.ico'
$startCmd = Join-Path $App 'start.cmd'
$uninst = Join-Path $App 'uninstall.ps1'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$uninstArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$uninst`""
# "Frame Studio - video editor that Claude edits live" (Hebrew)
$descHe = 'עורך וידאו שקלוד עורך בשידור חי'
if ($ShortcutDir) {
  $deskDir = Join-Path $ShortcutDir 'Desktop'
  $menuDir = Join-Path $ShortcutDir 'Start Menu'
} else {
  $deskDir = [Environment]::GetFolderPath('Desktop')
  if (-not $deskDir) { $deskDir = Join-Path $env:USERPROFILE 'Desktop' }
  $menuDir = [Environment]::GetFolderPath('Programs')
}
$links = @(
  [pscustomobject]@{ Path = (Join-Path $deskDir 'Frame Studio.lnk'); Target = $startCmd; Args = ''; Style = 7; Desc = "Frame Studio - $descHe" },
  [pscustomobject]@{ Path = (Join-Path $menuDir 'Frame Studio.lnk'); Target = $startCmd; Args = ''; Style = 7; Desc = "Frame Studio - $descHe" },
  [pscustomobject]@{ Path = (Join-Path $menuDir 'Uninstall Frame Studio.lnk'); Target = $psExe; Args = $uninstArgs; Style = 1; Desc = 'Uninstall Frame Studio' }
)
# Start Menu "Frame Studio - my files": opens the folder with the projects, the finished videos and the sounds
$filesLnk = Join-Path $menuDir 'Frame Studio - my files.lnk'
if ((Normalize-Dir $DataPath) -ne (Normalize-Dir $App)) {
  $links += [pscustomobject]@{ Path = $filesLnk; Target = $DataPath; Args = ''; Style = 1; Desc = 'Frame Studio - הקבצים שלי (פרויקטים, סרטונים מוכנים, צלילים)'; Folder = $true }
}
if ($NoShortcut) {
  Info 'Skipped (-NoShortcut).'
} elseif ($DryRun) {
  foreach ($l in $links) { Dry "would create $($l.Path) -> $($l.Target) $($l.Args)" }
} else {
  if (-not (Test-File $icon)) { & $node.Path (Join-Path $App 'tools\make-icon.mjs') $icon 2>&1 | Out-Null }
  $made = 0
  foreach ($l in $links) {
    try {
      if ($l.Folder) { New-Shortcut -Path $l.Path -Target $l.Target -Description $l.Desc }   # the usual folder icon
      else { New-Shortcut -Path $l.Path -Target $l.Target -Arguments $l.Args -WorkDir $App -Icon $icon -Description $l.Desc -WindowStyle $l.Style }
      $made++
    } catch { Warn "Shortcut not created: $($l.Path) ($($_.Exception.Message))" }
  }
  if ($made -eq $links.Count) {
    Good "Desktop: $(Join-Path $deskDir 'Frame Studio.lnk')" 'קיצור דרך "Frame Studio" בשולחן העבודה'
    Good "Start Menu: Frame Studio, Uninstall Frame Studio  ($menuDir)" 'בתפריט התחל: Frame Studio והסרת Frame Studio'
    if (@($links | Where-Object { $_.Folder }).Count) { Good 'Start Menu: "Frame Studio - my files" opens your projects, finished videos and sounds.' 'בתפריט התחל: "Frame Studio - my files" פותח את הפרויקטים, הסרטונים המוכנים והצלילים.' }
  }
  Sum 'Shortcuts: Desktop + Start Menu "Frame Studio"'
}

# Apps & features entry (Settings > Apps > Installed apps > Frame Studio > Uninstall)
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FrameStudio'
if ($NoRegistry -or $ShortcutDir) {
  Info 'Apps & features entry: skipped.'
} elseif ($DryRun) {
  Dry "would register Frame Studio in Apps & features ($regKey)"
} else {
  try {
    if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force | Out-Null }
    $sizeKB = 0
    try { $sizeKB = [int]((Get-ChildItem -LiteralPath $App -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB) } catch { }
    $vals = [ordered]@{
      DisplayName = 'Frame Studio'; DisplayVersion = "$Version"; Publisher = 'Frame Studio (open source)'
      DisplayIcon = $icon; InstallLocation = $App; URLInfoAbout = 'https://github.com/YonatanProX/frame-studio'
      UninstallString = "`"$psExe`" $uninstArgs"; QuietUninstallString = "`"$psExe`" $uninstArgs -Yes -NoPause"
      InstallDate = (Get-Date -Format 'yyyyMMdd')
    }
    foreach ($k in $vals.Keys) { New-ItemProperty -Path $regKey -Name $k -Value $vals[$k] -PropertyType String -Force | Out-Null }
    New-ItemProperty -Path $regKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $regKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null
    New-ItemProperty -Path $regKey -Name 'EstimatedSize' -Value $sizeKB -PropertyType DWord -Force | Out-Null
    Good 'Listed in Settings > Apps (uninstall from there or from the Start Menu).' 'רשום ב"הגדרות > אפליקציות" (אפשר להסיר משם או מתפריט התחל).'
  } catch { Warn "Apps & features entry not written: $($_.Exception.Message)" }
}

# ── 5. cutx on PATH ───────────────────────────────────────────────────────────
Step 5 'The cutx command' 'הפקודה cutx'
if ($NoPath) {
  Info "Skipped (-NoPath). Run it as `"$(Join-Path $App 'cutx.cmd')`"."
} elseif ($DryRun) {
  if (Test-UserPathHas $App) { Dry "PATH already has $App" } else { Dry "would add $App to your user PATH (new terminals can run: cutx)" }
} else {
  try {
    if (Add-UserPath $App) { Good "Added to your PATH: $App - new terminals can run: cutx help" "התיקייה נוספה ל-PATH - בטרמינל חדש אפשר להריץ: cutx help" }
    else { Good "Already on your PATH: cutx works in any new terminal." 'כבר ב-PATH: הפקודה cutx עובדת בכל טרמינל חדש.' }
    Sum 'cutx: on PATH (open a new terminal)'
  } catch { Warn "PATH not changed: $($_.Exception.Message)" }
}
$env:Path = "$App;$env:Path"

# ── 6. Claude ─────────────────────────────────────────────────────────────────
Step 6 'Connect to Claude' 'חיבור לקלוד'
$mcp = Join-Path $App 'mcp\server.mjs'
$ClaudeDone = @()
if ($NoClaude) {
  Info 'Skipped (-NoClaude).'
} elseif (-not $node.Ok) {
  Dry 'needs Node.js (skipped in this dry run)'
} elseif (Ask-YesNo 'Connect Frame Studio to Claude?' 'לחבר את Frame Studio לקלוד?' $true) {
  $connect = Join-Path $Root 'tools\claude-connect.mjs'
  $dryArg = @(); if ($DryRun) { $dryArg = @('--dry-run') }
  # (a) Claude Desktop (MCP server)
  if (-not (Test-File (Join-Path $Root 'mcp\server.mjs'))) {
    Warn 'This copy of Frame Studio has no mcp\server.mjs - Claude Desktop cannot be connected.' 'בעותק הזה אין mcp\server.mjs - אי אפשר לחבר את Claude Desktop.'
  } else {
    $configs = @()
    if ($ClaudeDesktopConfig) { $configs += [IO.Path]::GetFullPath($ClaudeDesktopConfig) }
    else {
      $configs += Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
      # Claude Desktop from the Microsoft Store may keep its settings in its package folder
      foreach ($pkg in @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue)) {
        $f = Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
        if (Test-File $f) { $configs += $f }
      }
    }
    foreach ($f in $configs) {
      $out = & $node.Path $connect desktop-add --config $f --node $node.Path --server $mcp @dryArg 2>&1
      $code = $LASTEXITCODE
      foreach ($l in $out) { if ($DryRun) { Dry "$l" } elseif ($code -eq 0) { Info "$l" } else { Warn "$l" } }
      if ($code -eq 0) { $ClaudeDone += 'Claude Desktop' }
    }
  }
  # (b) Claude Code: the skill, and the MCP server (user scope): "claude mcp add --scope user" with the claude command
  # (on PATH, or the copy that came with Claude Desktop in %APPDATA%\Claude\claude-code\<version>\...); without it, the
  # same entry is merged straight into %USERPROFILE%\.claude.json (see Connect-ClaudeCodeMcp in setup-common.ps1).
  # -ClaudeHome (tests) / CLAUDE_CONFIG_DIR: the skill goes to <dir>\skills, the settings file is <dir>\.claude.json;
  # -ClaudeJson <file> (tests): that settings file; -ClaudeCli <claude.exe|none> (tests): which claude command to use.
  $cHome = Get-ClaudeCodeHome $ClaudeHome
  $onPath = if ($NoPath) { '0' } else { '1' }
  $out = & $node.Path $connect skill-install --home $cHome --app $App --node $node.Path --on-path $onPath --source (Join-Path $Root '.claude\skills\frame-studio') @dryArg 2>&1
  $code = $LASTEXITCODE
  foreach ($l in $out) { if ($DryRun) { Dry "$l" } elseif ($code -eq 0) { Info "$l" } else { Warn "$l" } }
  if ($code -eq 0) { $ClaudeDone += 'Claude Code skill' }
  if (Test-File (Join-Path $Root 'mcp\server.mjs')) {
    $codeCfg = if ($ClaudeJson) { [IO.Path]::GetFullPath($ClaudeJson) } else { Get-ClaudeCodeConfig $ClaudeHome }
    $isTest = [bool]($ClaudeJson -or $ClaudeHome)
    if (Connect-ClaudeCodeMcp $node.Path $connect $mcp $codeCfg $isTest $ClaudeCli) { $ClaudeDone += 'Claude Code MCP' }
    else { Warn 'Claude Code: the Frame Studio tools were not added - Claude Code will use the skill and the cutx command.' 'Claude Code: הכלים של Frame Studio לא נוספו - Claude Code ישתמש בסקיל ובפקודה cutx.' }
  }
  if ($ClaudeDone.Count -and -not $DryRun) {
    Good 'Done. Restart Claude (quit it from the tray icon and open it again) to see Frame Studio.' 'בוצע. הפעילו מחדש את Claude (סגירה מלאה מסמל המגש ופתיחה מחדש) כדי לראות את Frame Studio.'
    Sum "Claude: connected ($($ClaudeDone -join ', ')) - restart Claude"
  }
} else {
  Info 'Not connected. Run the installer again any time to connect.' 'לא חובר. אפשר להפעיל שוב את ההתקנה בכל זמן כדי לחבר.'
  Sum 'Claude: not connected'
}

# ── 7. final check (the server's own view) ────────────────────────────────────
Step 7 'Final check' 'בדיקה אחרונה'
$ready = $false
if ($node.Ok) {
  if ($DryRun -and $sets.Count) { Dry 'the check below uses the current config.json (the changes above were not written)' }
  $out = & $node.Path (Join-Path $Root 'tools\check-setup.mjs') 2>&1
  $ready = ($LASTEXITCODE -eq 0)
  foreach ($l in $out) { Line "$l" }
}
if ($ready) {
  Good 'Frame Studio is ready.' 'Frame Studio מוכן לעבודה.'
} elseif (-not $DryRun) {
  Bad 'Something required is still missing (see above). Run the installer again.' 'עדיין חסר רכיב חיוני (פרטים למעלה). הפעילו שוב את ההתקנה.'
}

# ── 8. start ──────────────────────────────────────────────────────────────────
Step 8 'Starting Frame Studio' 'מפעילים את Frame Studio'
if (-not $ready) {
  Info 'Not started.' 'לא הופעל.'
} elseif ($NoStart) {
  Info 'Skipped (-NoStart). Open it from the "Frame Studio" shortcut on your desktop or in the Start Menu.' 'דילגנו. פותחים מקיצור הדרך "Frame Studio" בשולחן העבודה או בתפריט התחל.'
} elseif ($DryRun) {
  Dry "would start $startCmd"
} else {
  Start-Process -FilePath $startCmd -WorkingDirectory $App -WindowStyle Minimized
  Good 'Opening the editor...' 'העורך נפתח...'
}

# ── summary ───────────────────────────────────────────────────────────────────
Line ''
Line '  ----------------------------------------------------------' 'White'
if ($DryRun) { Line '   Dry run finished - nothing was changed.' 'Magenta' }
elseif ($ready) { Line "   Frame Studio $Version is installed.                  Frame Studio הותקן." 'Green' }
else { Line '   Setup did not finish - see the messages above.        ההתקנה לא הושלמה.' 'Red' }
Line "   Program: $App   (Node.js: $NodeSource, ffmpeg: $FFSource)"
foreach ($s in $Summary) { Line "   $s" }
Line "   Open it: the Frame Studio shortcut (Desktop / Start Menu).   פותחים: קיצור הדרך Frame Studio."
Line "   Log: $LogFile"
Line '  ----------------------------------------------------------' 'White'

if ($ready -or $DryRun) { Finish 0 } else { Finish 1 }
