<#
  Frame Studio - installer for Windows 10 / 11.        Double-click install.cmd (it runs this file).

  1. checks for Node.js 24+, ffmpeg + ffprobe and Google Chrome (Edge can show the editor, but exports need Chrome)
  2. installs whatever is missing with winget, after one Y/N question
  3. writes the absolute paths it found into config.json when the current settings cannot find them
     (a PATH change made by an installer does not reach programs that are already running); existing working
     values are never touched; config.json is created from config.example.json when missing
  4. creates the desktop shortcut "Frame Studio" (tools\make-shortcut.ps1)
  5. checks everything again the way the server sees it (tools\check-setup.mjs) and starts Frame Studio

  Safe to run again at any time (it only repairs what is missing).

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install.ps1 [-DryRun] [-Yes] [-NoStart] [-NoShortcut] [-NoPause]
    -DryRun      only report what would be done: installs nothing, writes nothing, starts nothing
    -Yes         install missing programs without asking
    -NoStart     do not open Frame Studio at the end
    -NoShortcut  do not create / refresh the desktop shortcut
    -NoPause     do not wait for Enter before closing
    -SimulateMissing node,ffmpeg,chrome   (testing, only together with -DryRun) pretend these are not installed
  Env FRAME_STUDIO_CONFIG = another config file (same as the server).

  This file is saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew text correctly.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$NoStart,
  [switch]$NoShortcut,
  [switch]$NoPause,
  [string[]]$SimulateMissing = @()
)

$ErrorActionPreference = 'Continue'

. (Join-Path $PSScriptRoot 'setup-common.ps1')
$Steps = 6

# ffmpeg / ffprobe in the folders installers use (newest winget package folder wins)
function Find-FFTool([string]$name) {
  $exe = "$name.exe"
  $p = Find-InPath $exe (Get-FreshPath)
  if ($p) { return $p }
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

# How the server resolves a configured ffmpeg / ffprobe value with this session's PATH
function Test-ConfiguredExe([string]$value, [string]$name) {
  if (-not $value) { $value = $name }
  if ($value -match '[\\/]') {
    $p = Resolve-ConfigPath $value
    return [pscustomobject]@{ Ok = (Test-File $p); Path = $p }
  }
  $exe = if ($value -match '\.exe$') { $value } else { "$value.exe" }
  $p = Find-InPath $exe $SessionPath
  return [pscustomobject]@{ Ok = [bool]$p; Path = $p }
}

function Get-FFmpegInfo([string]$exe) {
  $v = @(& $exe -hide_banner -version 2>$null)[0]
  $enc = (& $exe -hide_banner -encoders 2>$null) -join "`n"
  return [pscustomobject]@{ Version = ("$v" -replace '\s+Copyright.*$', ''); X264 = ($enc -match 'libx264') }
}

function Find-Browser([switch]$Edge) {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  if ($Edge) {
    foreach ($r in $roots) { $f = Join-Path $r 'Microsoft\Edge\Application\msedge.exe'; if (Test-File $f) { return $f } }
    return $null
  }
  foreach ($sub in 'Google\Chrome\Application\chrome.exe', 'Chromium\Application\chrome.exe') {
    foreach ($r in $roots) { $f = Join-Path $r $sub; if (Test-File $f) { return [pscustomobject]@{ Path = $f; Standard = $true } } }
  }
  foreach ($k in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe') {
    try { $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)' } catch { continue }
    if ($v) { $v = $v.Trim('"') }
    if (Test-File $v) { return [pscustomobject]@{ Path = $v; Standard = $false } }
  }
  return $null
}


# ───────────────────────────── start ─────────────────────────────

if (-not $DryRun) { try { Start-Transcript -Path (Join-Path $Root 'install.log') -Append | Out-Null } catch { } }

Line ''
Line '  ==========================================================' 'White'
Line '   Frame Studio - setup                    התקנת Frame Studio' 'White'
Line '  ==========================================================' 'White'
Info "Folder: $Root" "תיקייה: $Root"
if ($DryRun) { Dry 'nothing will be installed, written or started · מצב בדיקה: שום דבר לא יותקן, ייכתב או יופעל' }
if ($SimulateMissing) {
  if ($DryRun) { Dry "pretending these are missing: $($SimulateMissing -join ', ')" } else { Warn '-SimulateMissing only works with -DryRun - ignored.' }
}
if ($Root -like "$env:TEMP*" -or $Root -match '\\Temp\\') {
  Warn 'This folder looks temporary. Extract the ZIP to a permanent folder (e.g. Documents) and run install.cmd there.' `
       'נראה שזו תיקייה זמנית. חלצו את ה-ZIP לתיקייה קבועה (למשל "מסמכים") והפעילו משם את install.cmd.'
}

# ── 1. check ──────────────────────────────────────────────────────────────────
Step 1 'Checking this computer' 'בודקים מה כבר מותקן במחשב'

$cfg = Read-Config
if (-not $cfg.Valid) {
  Warn "config.json is not valid JSON - settings will not be changed. Fix it or delete it, then run install.cmd again." `
       'הקובץ config.json פגום - ההגדרות לא ישתנו. תקנו או מחקו אותו והפעילו שוב את install.cmd.'
}

function Get-State {
  $s = [ordered]@{}
  $s.Node = Find-Node

  $ffVal = if ($env:FRAME_STUDIO_FFMPEG) { $env:FRAME_STUDIO_FFMPEG } else { Get-ConfigValue $cfg 'ffmpeg' }
  $fpVal = if ($env:FRAME_STUDIO_FFPROBE) { $env:FRAME_STUDIO_FFPROBE } else { Get-ConfigValue $cfg 'ffprobe' }
  $s.FFmpegCfg = Test-ConfiguredExe $ffVal 'ffmpeg'
  $s.FFprobeCfg = Test-ConfiguredExe $fpVal 'ffprobe'
  # ffprobe next to a configured absolute ffmpeg counts as found (the server does the same)
  if (-not $s.FFprobeCfg.Ok -and $s.FFmpegCfg.Ok -and ("$ffVal" -match '[\\/]') -and (-not $fpVal -or $fpVal -eq 'ffprobe')) {
    $sib = Join-Path (Split-Path -Parent $s.FFmpegCfg.Path) 'ffprobe.exe'
    if (Test-File $sib) { $s.FFprobeCfg = [pscustomobject]@{ Ok = $true; Path = $sib } }
  }
  $s.FFmpegFound = if ($s.FFmpegCfg.Ok) { $s.FFmpegCfg.Path } else { Find-FFTool 'ffmpeg' }
  $s.FFprobeFound = if ($s.FFprobeCfg.Ok) { $s.FFprobeCfg.Path } else { Find-FFTool 'ffprobe' }

  $chVal = if ($env:FRAME_STUDIO_CHROME) { $env:FRAME_STUDIO_CHROME } else { Get-ConfigValue $cfg 'chrome' }
  $s.ChromeCfgValue = $chVal
  $s.ChromeCfgOk = $chVal -and (Test-File (Resolve-ConfigPath $chVal))
  $s.Chrome = Find-Browser
  $s.Edge = Find-Browser -Edge

  if ($DryRun -and $SimulateMissing) {
    $sim = ($SimulateMissing -join ',').ToLower() -split '[,\s]+'
    if ($sim -contains 'node') { $s.Node = [pscustomobject]@{ Path = $null; Major = -1; Ok = $false } }
    if ($sim -contains 'ffmpeg') {
      $s.FFmpegCfg = [pscustomobject]@{ Ok = $false; Path = $null }; $s.FFprobeCfg = $s.FFmpegCfg
      $s.FFmpegFound = $null; $s.FFprobeFound = $null
    }
    if ($sim -contains 'chrome') { $s.ChromeCfgOk = $false; $s.Chrome = $null }
  }
  return [pscustomobject]$s
}

function Show-State($s) {
  if ($s.Node.Ok) { Good "Node.js v$($s.Node.Major)  $($s.Node.Path)" }
  elseif ($s.Node.Path) { Bad "Node.js is too old (v$($s.Node.Major)); Frame Studio needs $MinNode or newer  $($s.Node.Path)" "גרסת Node.js ישנה מדי (v$($s.Node.Major)); צריך $MinNode ומעלה" }
  else { Bad "Node.js $MinNode+ not found" "לא נמצא Node.js (גרסה $MinNode ומעלה)" }

  if ($s.FFmpegFound) {
    Good "ffmpeg   $($s.FFmpegFound)"
    $fi = Get-FFmpegInfo $s.FFmpegFound
    if ($fi.Version) { Info $fi.Version }
    if (-not $fi.X264) { Warn 'This ffmpeg build has no libx264 encoder - MP4 export needs a full build (winget: Gyan.FFmpeg).' 'בגרסת ה-ffmpeg הזו אין libx264 - לייצוא MP4 צריך גרסה מלאה (winget: Gyan.FFmpeg).' }
  } else { Bad 'ffmpeg not found' 'לא נמצא ffmpeg' }
  if ($s.FFprobeFound) { Good "ffprobe  $($s.FFprobeFound)" } else { Bad 'ffprobe not found' 'לא נמצא ffprobe' }

  if ($s.ChromeCfgOk) { Good "Google Chrome  $(Resolve-ConfigPath $s.ChromeCfgValue)  (from settings)" }
  elseif ($s.Chrome) { Good "Google Chrome  $($s.Chrome.Path)" }
  elseif ($s.Edge) { Warn "Google Chrome not found (Edge found: it can show the editor, but export and snapshots need Chrome)" 'לא נמצא Google Chrome (נמצא Edge: הוא יכול להציג את העורך, אבל ייצוא וצילומי פריימים דורשים Chrome)' }
  else { Bad 'Google Chrome not found' 'לא נמצא Google Chrome' }
}

$state = Get-State
Show-State $state

# ── 2. install what is missing ──────────────────────────────────────────────
Step 2 'Installing what is missing' 'מתקינים את מה שחסר'

$todo = @()
if (-not $state.Node.Ok) { $todo += [pscustomobject]@{ Id = 'OpenJS.NodeJS.LTS'; Name = "Node.js $MinNode+"; Url = 'https://nodejs.org/en/download' } }
if (-not $state.FFmpegFound -or -not $state.FFprobeFound) { $todo += [pscustomobject]@{ Id = 'Gyan.FFmpeg'; Name = 'ffmpeg'; Url = 'https://www.gyan.dev/ffmpeg/builds/  (ffmpeg-release-full.7z -> extract so that C:\ffmpeg\bin\ffmpeg.exe exists)' } }
if (-not $state.ChromeCfgOk -and -not $state.Chrome) { $todo += [pscustomobject]@{ Id = 'Google.Chrome'; Name = 'Google Chrome'; Url = 'https://www.google.com/chrome/' } }

if (-not $todo.Count) {
  Good 'Nothing to install - everything is already here.' 'אין מה להתקין - הכול כבר מותקן.'
} else {
  $names = ($todo | ForEach-Object { $_.Name }) -join ', '
  $winget = Find-Winget
  if (-not $winget) {
    Bad "Missing: $names - and winget (the Windows package installer) is not available, so they cannot be installed automatically." `
        "חסר: $names - ואין במחשב winget (מתקין החבילות של Windows), לכן אי אפשר להתקין אוטומטית."
    Info 'Install winget ("App Installer") from the Microsoft Store: https://apps.microsoft.com/detail/9NBLGGH4NNS1' 'אפשר להתקין את winget ("App Installer") מ-Microsoft Store בקישור שלמעלה,'
    Info 'or install these yourself, then run install.cmd again:' 'או להתקין ידנית את התוכנות האלה ולהפעיל שוב את install.cmd:'
    foreach ($t in $todo) { Info "  - $($t.Name): $($t.Url)" }
  } elseif ($DryRun) {
    Dry "would ask once: Install $names now? [Y/n]"
    foreach ($t in $todo) { Dry "winget install --id $($t.Id) -e --source winget --accept-package-agreements --accept-source-agreements --silent" }
  } else {
    $ok = Ask-YesNo "Missing: $names. Install now with winget? (accepts the packages' license terms; Windows may ask for permission - click Yes)" `
                    "חסר: $names. להתקין עכשיו עם winget? (כולל הסכמה לתנאי הרישיון של החבילות; ייתכן ש-Windows יבקש אישור - לחצו כן)"
    if ($ok) {
      foreach ($t in $todo) {
        Line ''
        Line "   ->  winget install $($t.Id)   ($($t.Name))" 'White'
        & $winget install --id $t.Id -e --source winget --accept-package-agreements --accept-source-agreements --silent
        $code = $LASTEXITCODE
        if ($code -ne 0) { Warn "winget finished with code $code for $($t.Name) (checking again below)" "winget הסתיים עם קוד $code עבור $($t.Name) (נבדוק שוב למטה)" }
      }
      # programs installed just now are not on this window's PATH yet: use the fresh PATH from now on
      $env:Path = Get-FreshPath
      $state = Get-State
      Line ''
      Info 'After installing:' 'אחרי ההתקנה:'
      Show-State $state
    } else {
      Warn 'Skipped. Install them yourself, then run install.cmd again:' 'דילגנו. התקינו אותן בעצמכם והפעילו שוב את install.cmd:'
      foreach ($t in $todo) { Info "  - $($t.Name): $($t.Url)" }
    }
  }
}

$node = $state.Node
if (-not $node.Ok) {
  Bad "Frame Studio cannot run without Node.js $MinNode+." "Frame Studio לא יכול לפעול בלי Node.js $MinNode ומעלה."
  if (-not $DryRun) { Finish 1 }
}
if ($node.Ok) {
  # make node (and what it starts) reachable for the rest of this script and for the app started at the end
  $nodeDir = Split-Path -Parent $node.Path
  if (-not (Find-InPath 'node.exe' $env:Path)) { $env:Path = "$nodeDir;$env:Path" }
}

# ── 3. settings ─────────────────────────────────────────────────────────────
Step 3 'Saving settings (config.json)' 'שומרים הגדרות (config.json)'

$sets = @()
if ($cfg.Valid) {
  if (-not $env:FRAME_STUDIO_FFMPEG -and -not $state.FFmpegCfg.Ok -and $state.FFmpegFound) { $sets += "ffmpeg=$(To-JsonPath $state.FFmpegFound)" }
  if (-not $env:FRAME_STUDIO_FFPROBE -and -not $state.FFprobeCfg.Ok -and $state.FFprobeFound) { $sets += "ffprobe=$(To-JsonPath $state.FFprobeFound)" }
  if (-not $env:FRAME_STUDIO_CHROME -and -not $state.ChromeCfgOk -and $state.Chrome) {
    # null = the server finds Chrome by itself; only a non-standard location (or a broken setting) needs the full path
    if (-not $state.Chrome.Standard -or $state.ChromeCfgValue) { $sets += "chrome=$(To-JsonPath $state.Chrome.Path)" }
  }
  if (-not $node.Ok) {
    Dry 'config.json is written with Node.js - skipped here because Node.js is missing'
  } else {
    $cfgArgs = @()
    if ($DryRun) { $cfgArgs += '--dry-run' }
    $out = & $node.Path (Join-Path $Root 'tools\config-set.mjs') @cfgArgs @sets 2>&1
    $code = $LASTEXITCODE
    foreach ($l in $out) { if ($DryRun) { Dry "$l" } else { Info "$l" } }
    if ($code -ne 0) { Warn 'config.json could not be updated (see above).' 'לא הצלחנו לעדכן את config.json (פרטים למעלה).' }
    elseif (-not $sets.Count -and -not $DryRun) { Good 'Settings are fine - nothing to change.' 'ההגדרות תקינות - אין מה לשנות.' }
  }
} else {
  Warn 'Skipped: config.json is not valid JSON.' 'דילגנו: config.json פגום.'
}

# ── 4. app files + desktop shortcut ─────────────────────────────────────────
Step 4 'Desktop shortcut' 'קיצור דרך בשולחן העבודה'

# files from a downloaded ZIP carry a "from the internet" mark that makes Windows warn on every start; clear it on our launchers
$marked = @()
foreach ($f in @(Get-ChildItem -LiteralPath $Root -File -Filter '*.cmd' -ErrorAction SilentlyContinue) + @(Get-ChildItem -LiteralPath (Join-Path $Root 'tools') -File -ErrorAction SilentlyContinue | Where-Object { $_.Extension -in '.ps1', '.cmd' })) {
  if (Get-Item -LiteralPath $f.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) { $marked += $f }
}
if ($marked.Count) {
  if ($DryRun) { Dry "would remove the downloaded-file mark from $($marked.Count) launcher file(s)" }
  else { $marked | Unblock-File -ErrorAction SilentlyContinue; Info "Removed the downloaded-file warning from $($marked.Count) launcher file(s)." 'הוסרה אזהרת "קובץ מהאינטרנט" מקובצי ההפעלה.' }
}

$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Frame Studio.lnk'
if ($NoShortcut) {
  Info 'Skipped (-NoShortcut).'
} elseif ($DryRun) {
  Dry "would create / refresh $lnk -> $(Join-Path $Root 'start.cmd')"
} else {
  $nodeArg = if ($node.Ok) { $node.Path } else { 'node' }
  $r = ''
  try { $r = & (Join-Path $Root 'tools\make-shortcut.ps1') -Desktop $desktop -Node $nodeArg } catch { $r = $_.Exception.Message }
  if ("$r" -like 'OK:*' -and (Test-File $lnk)) { Good "Shortcut: $lnk" 'נוצר קיצור דרך "Frame Studio" בשולחן העבודה' }
  else { Warn "The shortcut could not be created: $r" 'לא הצלחנו ליצור קיצור דרך. אפשר תמיד להפעיל את start.cmd מתיקיית התוכנה.' }
}

# ── 5. final check (the server's own view) ──────────────────────────────────
Step 5 'Final check' 'בדיקה אחרונה'
$ready = $false
if ($node.Ok) {
  if ($DryRun -and $sets.Count) { Dry 'the check below uses the current config.json (the changes above were not written)' }
  & $node.Path (Join-Path $Root 'tools\check-setup.mjs')
  $ready = ($LASTEXITCODE -eq 0)
}
if ($ready) {
  Good 'Frame Studio is ready.' 'Frame Studio מוכן לעבודה.'
} else {
  Bad 'Something required is still missing (see above). Install it and run install.cmd again.' 'עדיין חסר רכיב חיוני (פרטים למעלה). התקינו אותו והפעילו שוב את install.cmd.'
}

# ── 6. start ────────────────────────────────────────────────────────────────
Step 6 'Starting Frame Studio' 'מפעילים את Frame Studio'
$start = Join-Path $Root 'start.cmd'
if (-not $ready) {
  Info 'Not started.' 'לא הופעל.'
} elseif ($NoStart) {
  Info 'Skipped (-NoStart). Double-click the "Frame Studio" shortcut on your desktop to open it.' 'דילגנו. פותחים בלחיצה כפולה על קיצור הדרך "Frame Studio" בשולחן העבודה.'
} elseif ($DryRun) {
  Dry "would start $start"
} else {
  Start-Process -FilePath $start -WorkingDirectory $Root -WindowStyle Minimized
  Good 'Opening the editor... From now on use the "Frame Studio" shortcut on your desktop.' 'העורך נפתח... מעכשיו פותחים אותו מקיצור הדרך "Frame Studio" בשולחן העבודה.'
  Info 'Free sound effects: see library\sounds\README.md' 'אפקטים קוליים בחינם: ראו library\sounds\README.md'
  Info 'Optional local transcription: double-click tools\install-transcription.cmd' 'תמלול מקומי (רשות): לחיצה כפולה על tools\install-transcription.cmd'
}

if ($ready) { Finish 0 } else { Finish 1 }
