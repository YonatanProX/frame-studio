# Frame Studio - helpers shared by tools\install.ps1 and tools\install-transcription.ps1 (dot-sourced, not run directly).
# Expects the caller to define $DryRun, $Yes, $NoPause (switches) and $Steps (number of steps shown).
# Saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew text correctly.

$Root = Split-Path -Parent $PSScriptRoot
$MinNode = 24
$SessionPath = $env:Path
$ConfigFile = if ($env:FRAME_STUDIO_CONFIG) { [IO.Path]::GetFullPath($env:FRAME_STUDIO_CONFIG) } else { Join-Path $Root 'config.json' }
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ───────────────────────────── output ─────────────────────────────

function Line([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color }
function Step([int]$n, [string]$en, [string]$he) {
  Line ''
  Line "[$n/$Steps] $en" 'Cyan'
  Line "      $he" 'Cyan'
}
function Good([string]$en, [string]$he) { Line "   OK   $en" 'Green'; if ($he) { Line "        $he" 'DarkGreen' } }
function Info([string]$en, [string]$he) { Line "        $en"; if ($he) { Line "        $he" 'DarkGray' } }
function Warn([string]$en, [string]$he) { Line "   !    $en" 'Yellow'; if ($he) { Line "        $he" 'Yellow' } }
function Bad([string]$en, [string]$he) { Line "   X    $en" 'Red'; if ($he) { Line "        $he" 'Red' } }
function Dry([string]$text) { Line "   (dry run) $text" 'Magenta' }

function Finish([int]$code) {
  if (-not $DryRun) { try { Stop-Transcript | Out-Null } catch { } }
  if (-not $NoPause) {
    Line ''
    [void](Read-Host '  Press Enter to close · לחצו Enter כדי לסגור')
  }
  exit $code
}

function Ask-YesNo([string]$en, [string]$he) {
  if ($Yes) { Info "$en -> yes (-Yes)"; return $true }
  $redirected = $false
  try { $redirected = [Console]::IsInputRedirected } catch { }
  if ($redirected) { Info "$en -> no (no keyboard input; use -Yes to install unattended)"; return $false }
  Line ''
  Line "  $en" 'White'
  Line "  $he" 'White'
  while ($true) {
    $a = Read-Host '  [Y/n]'
    if ($null -eq $a) { return $false }
    $a = $a.Trim().ToLower()
    # Y / N on a Hebrew keyboard layout type ט / מ
    if ($a -eq '' -or $a -in @('y', 'yes', 'ט', 'כ', 'כן')) { return $true }
    if ($a -in @('n', 'no', 'מ', 'ל', 'לא')) { return $false }
    Line '  Please type Y or N · הקלידו Y או N' 'Yellow'
  }
}

# ───────────────────────────── finding programs ─────────────────────────────

function Test-File([string]$p) { return ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) }

# PATH as a newly started program would see it (registry Machine + User), plus this session's PATH
function Get-FreshPath {
  $parts = @()
  foreach ($scope in 'Machine', 'User') {
    $v = [Environment]::GetEnvironmentVariable('Path', $scope)
    if ($v) { $parts += $v -split ';' }
  }
  $parts += $env:Path -split ';'
  $seen = @{}
  $out = @()
  foreach ($p in $parts) {
    $q = $p.Trim().Trim('"')
    if ($q -and -not $seen.ContainsKey($q.ToLower())) { $seen[$q.ToLower()] = $true; $out += $q }
  }
  return ($out -join ';')
}

function Find-InPath([string]$exe, [string]$pathList) {
  foreach ($d in ($pathList -split ';')) {
    if (-not $d) { continue }
    try { $f = Join-Path $d $exe } catch { continue }
    if (Test-File $f) { return (Get-Item -LiteralPath $f).FullName }
  }
  return $null
}

function Resolve-ConfigPath([string]$p) {
  if (-not $p) { return $null }
  $p = $p.Trim()
  if ($p -eq '~' -or $p.StartsWith('~/') -or $p.StartsWith('~\')) { $p = Join-Path $HOME ($p.Substring(1).TrimStart('/', '\')) }
  if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $Root $p }
  try { return [IO.Path]::GetFullPath($p) } catch { return $p }
}

function To-JsonPath([string]$p) { return ($p -replace '\\', '/') }

function Get-NodeMajor([string]$exe) {
  try { $v = @(& $exe --version 2>$null)[0] } catch { return -1 }
  if ("$v" -match '^v(\d+)\.') { return [int]$Matches[1] }
  return -1
}

function Find-Node {
  $cands = @()
  $cands += Find-InPath 'node.exe' $SessionPath
  $cands += Find-InPath 'node.exe' (Get-FreshPath)
  $cands += @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\node.exe",
    "$env:ProgramFiles\WinGet\Links\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  $best = [pscustomobject]@{ Path = $null; Major = -1; Ok = $false }
  foreach ($c in ($cands | Where-Object { Test-File $_ } | Select-Object -Unique)) {
    $m = Get-NodeMajor $c
    if ($m -ge $MinNode) { return [pscustomobject]@{ Path = $c; Major = $m; Ok = $true } }
    if ($m -gt $best.Major) { $best = [pscustomobject]@{ Path = $c; Major = $m; Ok = $false } }
  }
  return $best
}

function Find-Winget {
  $c = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $f = "$env:LOCALAPPDATA\Microsoft\WindowsApps\winget.exe"
  if (Test-File $f) { return $f }
  return $null
}

function Read-Config {
  if (-not (Test-File $ConfigFile)) { return [pscustomobject]@{ Exists = $false; Valid = $true; Data = $null } }
  try {
    $data = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return [pscustomobject]@{ Exists = $true; Valid = $true; Data = $data }
  } catch {
    return [pscustomobject]@{ Exists = $true; Valid = $false; Data = $null }
  }
}
# Node.js 24+ (needed to write config.json with tools\config-set.mjs), or $null
function Get-NodeExe {
  $n = Find-Node
  if ($n.Ok) { return $n.Path }
  return $null
}

# value of "key" or "key.sub" from Read-Config, or $null
function Get-ConfigValue($cfg, [string]$key) {
  $o = $cfg.Data
  foreach ($k in ($key -split '\.')) {
    if ($null -eq $o -or $o -is [string] -or $o -is [ValueType]) { return $null }
    $p = $o.PSObject.Properties[$k]
    if (-not $p) { return $null }
    $o = $p.Value
  }
  return $o
}
