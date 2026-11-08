<#
  Frame Studio - uninstaller for Windows 10 / 11.
  Start Menu > "Uninstall Frame Studio", or Settings > Apps > Installed apps > Frame Studio > Uninstall.

  Removes: the program folder (with its portable Node.js / ffmpeg), the Desktop and Start Menu shortcuts, the
  Apps & features entry, the PATH entry, the Claude connection (Claude Desktop MCP entry, Claude Code skill and MCP
  entry) and the cache in %LOCALAPPDATA%\Frame Studio.
  KEEPS your projects and sounds (<Documents>\Frame Studio) unless you add -RemoveData.
  Only removes what points to THIS Frame Studio folder. A git clone is never deleted (only unregistered).

  powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [options]
    -RemoveData      also delete your projects and sounds (asks again unless -Yes)
    -Yes             no questions                      -DryRun   only show what would be removed
    -NoPause         do not wait for Enter at the end  -LogFile <file>
    -AppDir <dir>    the Frame Studio folder (default: the folder of this file)
    -DataDir <dir>   your files folder (default: "dataDir" from config.json)
    -ShortcutDir <dir>  -NoRegistry  -NoPath  -ClaudeDesktopConfig <file>  -ClaudeHome <dir>  -ClaudeJson <file>
                        -ClaudeCli <claude.exe|none>  -CacheDir <dir>   (tests)
  This file is saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew text correctly.
#>
[CmdletBinding()]
param(
  [string]$AppDir,
  [string]$DataDir,
  [switch]$RemoveData,
  [string]$ShortcutDir,
  [switch]$NoRegistry,
  [switch]$NoPath,
  [string]$ClaudeDesktopConfig,
  [string]$ClaudeHome,
  [string]$ClaudeJson,
  [string]$ClaudeCli,
  [string]$CacheDir,
  [switch]$Yes,
  [switch]$DryRun,
  [switch]$NoPause,
  [string]$LogFile
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
if (-not $LogFile) { $LogFile = Join-Path ([IO.Path]::GetTempPath()) 'frame-studio-uninstall.log' }
. (Join-Path $PSScriptRoot 'tools\setup-common.ps1')
$Steps = 6
# tools\setup-common.ps1 sets $Root to the folder that contains tools\ (= this file's folder)
$App = if ($AppDir) { [IO.Path]::GetFullPath($AppDir).TrimEnd('\') } else { $Root }
if (-not $CacheDir) { $CacheDir = Join-Path $env:LOCALAPPDATA 'Frame Studio' }
$ConfigFile = Join-Path $App 'config.json'
$cfg = Read-Config
$IsGitClone = Test-Path -LiteralPath (Join-Path $App '.git')

$DataPath = $null
if ($DataDir) { $DataPath = [IO.Path]::GetFullPath($DataDir) }
else {
  $d = Get-ConfigValue $cfg 'dataDir'
  if ($d) { $DataPath = Resolve-ConfigPath $d }
}
$dataInApp = -not $DataPath -or (Normalize-Dir $DataPath) -eq (Normalize-Dir $App)

Write-Log ''
Write-Log "=== Frame Studio uninstall - $(Get-Date -Format s) - folder $App"
Line ''
Line '  ==========================================================' 'White'
Line '   Frame Studio - uninstall                   הסרת Frame Studio' 'White'
Line '  ==========================================================' 'White'
Info "Program folder: $App" "תיקיית התוכנה: $App"
if ($DataPath -and -not $dataInApp) { Info "Your files: $DataPath" "הקבצים שלכם: $DataPath" }
if ($DryRun) { Dry 'nothing will be removed · מצב בדיקה: שום דבר לא יוסר' }

if (-not (Test-Path -LiteralPath (Join-Path $App 'server\main.mjs'))) {
  Bad "This is not a Frame Studio folder: $App" "זו לא תיקייה של Frame Studio: $App"
  Finish 2
}

$keepNote = if ($RemoveData) { '' } else { ' Your projects and sounds are kept.' }
$keepNoteHe = if ($RemoveData) { '' } else { ' הפרויקטים והצלילים שלכם נשמרים.' }
if (-not $DryRun -and -not (Ask-YesNo "Remove Frame Studio from this computer?$keepNote" "להסיר את Frame Studio מהמחשב?$keepNoteHe" $true)) {
  Info 'Nothing was removed.' 'שום דבר לא הוסר.'
  Finish 0
}
$removeDataNow = $false
if ($RemoveData -and $DataPath -and -not $dataInApp) {
  if ($DryRun) { $removeDataNow = $true }
  else { $removeDataNow = Ask-YesNo "Also DELETE your projects and sounds in $DataPath ? This cannot be undone." "למחוק גם את הפרויקטים והצלילים שלכם ב-$DataPath ? אי אפשר לבטל את זה." $false }
}

# ── 1. stop it ────────────────────────────────────────────────────────────────
Step 1 'Closing Frame Studio' 'סוגרים את Frame Studio'
$ports = @(7788)
if ($env:FRAME_STUDIO_PORT -match '^\d+$') { $ports += [int]$env:FRAME_STUDIO_PORT }
if ($DryRun) { Dry 'would stop a Frame Studio server running from this folder' }
else {
  if (Stop-AppServer $App $ports) { Good 'The server was stopped.' 'השרת נסגר.' }
  $procs = Get-AppProcesses $App
  foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Info "stopped $($p.ProcessName) (pid $($p.Id))" } catch { } }
  if (-not $procs.Count) { Info 'Nothing was running.' 'שום דבר לא רץ.' }
}

# ── 2. shortcuts + Apps & features ────────────────────────────────────────────
Step 2 'Shortcuts' 'קיצורי דרך'
if ($ShortcutDir) { $lnkDirs = @((Join-Path $ShortcutDir 'Desktop'), (Join-Path $ShortcutDir 'Start Menu')) }
else { $lnkDirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs')) }
$appKey = Normalize-Dir $App
foreach ($dir in $lnkDirs) {
  foreach ($name in 'Frame Studio.lnk', 'Uninstall Frame Studio.lnk') {
    $f = Join-Path $dir $name
    $li = Get-ShortcutInfo $f
    if (-not $li) { continue }
    $ours = ((Normalize-Dir $li.Target).StartsWith($appKey + '\')) -or ("$($li.Arguments)".ToLowerInvariant().Contains($appKey + '\'))
    if (-not $ours) { Info "Left as it is (points elsewhere): $f"; continue }
    if ($DryRun) { Dry "would remove $f" } else { Remove-Item -LiteralPath $f -Force; Good "Removed $f" }
  }
  # "Frame Studio - my files" points at the files folder (which is kept); only the shortcut goes
  $f = Join-Path $dir 'Frame Studio - my files.lnk'
  $li = Get-ShortcutInfo $f
  if ($li) {
    $t = Normalize-Dir $li.Target
    $ours = if ($DataPath) { $t -eq (Normalize-Dir $DataPath) } else { (Split-Path -Leaf $t) -eq 'frame studio' }
    if (-not $ours) { Info "Left as it is (points elsewhere): $f" }
    elseif ($DryRun) { Dry "would remove $f" } else { Remove-Item -LiteralPath $f -Force; Good "Removed $f" }
  }
}
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FrameStudio'
if (-not $NoRegistry -and -not $ShortcutDir -and (Test-Path $regKey)) {
  $loc = (Get-ItemProperty -LiteralPath $regKey -ErrorAction SilentlyContinue).InstallLocation
  if ((Normalize-Dir $loc) -eq $appKey) {
    if ($DryRun) { Dry "would remove the Apps & features entry" } else { Remove-Item -LiteralPath $regKey -Recurse -Force; Good 'Removed from Settings > Apps.' 'הוסר מ"הגדרות > אפליקציות".' }
  }
}

# ── 3. PATH ───────────────────────────────────────────────────────────────────
Step 3 'The cutx command (PATH)' 'הפקודה cutx (PATH)'
if ($NoPath) { Info 'Skipped (-NoPath).' }
elseif (-not (Test-UserPathHas $App)) { Info 'Not on PATH.' 'לא ב-PATH.' }
elseif ($DryRun) { Dry "would remove $App from your user PATH" }
else { [void](Remove-UserPath $App); Good "Removed from PATH: $App" 'הוסר מ-PATH.' }

# ── 4. Claude ─────────────────────────────────────────────────────────────────
Step 4 'Disconnecting Claude' 'ניתוק מקלוד'
$node = Find-Node -AppRoot $App
$connect = Join-Path $App 'tools\claude-connect.mjs'
$dryArg = @(); if ($DryRun) { $dryArg = @('--dry-run') }
if (-not $node.Ok -or -not (Test-File $connect)) {
  Warn 'Node.js is not available - remove "frame-studio" from Claude Desktop settings by hand (Settings > Developer).' 'אין Node.js - הסירו את "frame-studio" מההגדרות של Claude Desktop ידנית (Settings > Developer).'
} else {
  $configs = @()
  if ($ClaudeDesktopConfig) { $configs += [IO.Path]::GetFullPath($ClaudeDesktopConfig) }
  else {
    $configs += Join-Path $env:APPDATA 'Claude\claude_desktop_config.json'
    foreach ($pkg in @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue)) {
      $f = Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude_desktop_config.json'
      if (Test-File $f) { $configs += $f }
    }
  }
  foreach ($f in $configs) {
    if (-not (Test-File $f)) { continue }
    $out = & $node.Path $connect desktop-remove --config $f --app $App @dryArg 2>&1
    foreach ($l in $out) { Info "$l" }
  }
  # Claude Code: the skill, and the user-scope MCP entry in .claude.json (added by the installer or by
  # "claude mcp add --scope user" - both live in the same file). Only an entry that points into THIS folder is removed:
  # with "claude mcp remove" when the claude command is found (also the copy inside Claude Desktop), else directly.
  $cHome = Get-ClaudeCodeHome $ClaudeHome
  $out = & $node.Path $connect skill-remove --home $cHome --app $App @dryArg 2>&1
  foreach ($l in $out) { Info "$l" }
  $codeCfg = if ($ClaudeJson) { [IO.Path]::GetFullPath($ClaudeJson) } else { Get-ClaudeCodeConfig $ClaudeHome }
  Disconnect-ClaudeCodeMcp $node.Path $connect $App $codeCfg ([bool]($ClaudeJson -or $ClaudeHome)) $ClaudeCli
}

# ── 5. files ──────────────────────────────────────────────────────────────────
Step 5 'Removing the program files' 'מוחקים את קובצי התוכנה'
Set-Location -LiteralPath ([IO.Path]::GetTempPath())
[Environment]::CurrentDirectory = [IO.Path]::GetTempPath()
$cacheIsOurs = (Test-Path -LiteralPath $CacheDir) -and ((Split-Path -Leaf $CacheDir) -eq 'Frame Studio')
if ($cacheIsOurs) {
  if ($DryRun) { Dry "would remove $CacheDir (cache, logs, transcription environment)" }
  else { Remove-Item -LiteralPath $CacheDir -Recurse -Force -ErrorAction SilentlyContinue; Good "Removed $CacheDir" }
}
if ($IsGitClone) {
  Warn "This folder is a git clone - it is not deleted. Delete it yourself if you want: $App" "זו תיקיית git - היא לא נמחקת. אפשר למחוק אותה ידנית: $App"
} elseif ($dataInApp -and @(Get-ChildItem -LiteralPath (Join-Path $App 'projects') -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '.*' }).Count -and -not $RemoveData) {
  # projects live inside the program folder: delete everything else, keep projects\ (and Sounds\ if present)
  $keep = @('projects', 'sounds', 'sound-folders.json')
  foreach ($it in @(Get-ChildItem -LiteralPath $App -Force)) {
    if ($keep -contains $it.Name.ToLowerInvariant()) { continue }
    if ($DryRun) { Dry "would remove $($it.FullName)" } else { Remove-Item -LiteralPath $it.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  }
  Warn "Your projects are inside the program folder, so they were kept: $(Join-Path $App 'projects')" "הפרויקטים שלכם נמצאים בתיקיית התוכנה ולכן נשמרו: $(Join-Path $App 'projects')"
} else {
  if ($DryRun) { Dry "would remove $App" }
  else {
    Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $App) {
      Start-Sleep -Seconds 1
      Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $App) { Warn "Some files could not be removed (in use?): $App - delete the folder after restarting Windows." "חלק מהקבצים לא נמחקו (בשימוש?): $App - מחקו את התיקייה אחרי הפעלה מחדש." }
    else { Good "Removed $App" "נמחק: $App" }
  }
}

# ── 6. your files ─────────────────────────────────────────────────────────────
Step 6 'Your projects and sounds' 'הפרויקטים והצלילים שלכם'
if ($removeDataNow) {
  if ($DryRun) { Dry "would DELETE $DataPath" }
  else { Remove-Item -LiteralPath $DataPath -Recurse -Force -ErrorAction SilentlyContinue; Good "Deleted $DataPath" "נמחק: $DataPath" }
} elseif ($DataPath -and -not $dataInApp) {
  Good "Kept: $DataPath" "נשמרו: $DataPath"
}

Line ''
if ($DryRun) { Line '   Dry run finished - nothing was removed.' 'Magenta' }
else { Line '   Frame Studio was removed. Restart Claude if it was connected.   Frame Studio הוסר. אם קלוד היה מחובר - הפעילו אותו מחדש.' 'Green' }
Finish 0
