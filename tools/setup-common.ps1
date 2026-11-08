# Frame Studio - helpers shared by tools\install.ps1, tools\install-transcription.ps1 and uninstall.ps1 (dot-sourced).
# Expects the caller to define $DryRun, $Yes, $NoPause (switches) and $Steps (number of steps shown); $LogFile is optional.
# Windows PowerShell 5.1 compatible. Saved as UTF-8 with BOM so PowerShell 5.1 reads the Hebrew text correctly.

$Root = Split-Path -Parent $PSScriptRoot
$MinNode = 24
$SessionPath = $env:Path
$ConfigFile = if ($env:FRAME_STUDIO_CONFIG) { [IO.Path]::GetFullPath($env:FRAME_STUDIO_CONFIG) } else { Join-Path $Root 'config.json' }
$script:OrigOutputEncoding = $null
try { $script:OrigOutputEncoding = [Console]::OutputEncoding; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
# TLS 1.2 for the downloads (older Windows 10 builds default to TLS 1.0 in Windows PowerShell 5.1)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

# ───────────────────────────── output + log ─────────────────────────────

function Write-Log([string]$text) {
  if (-not $LogFile) { return }
  try {
    $d = Split-Path -Parent $LogFile
    if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
    [IO.File]::AppendAllText($LogFile, "$text`r`n", [Text.Encoding]::UTF8)
  } catch { }
}
function Line([string]$text, [string]$color = 'Gray') { Write-Host $text -ForegroundColor $color; Write-Log $text }
function Step([int]$n, [string]$en, [string]$he) {
  Line ''
  Line "[$n/$Steps] $en" 'Cyan'
  if ($he) { Line "      $he" 'Cyan' }
}
function Good([string]$en, [string]$he) { Line "   OK   $en" 'Green'; if ($he) { Line "        $he" 'DarkGreen' } }
function Info([string]$en, [string]$he) { Line "        $en"; if ($he) { Line "        $he" 'DarkGray' } }
function Warn([string]$en, [string]$he) { Line "   !    $en" 'Yellow'; if ($he) { Line "        $he" 'Yellow' } }
function Bad([string]$en, [string]$he) { Line "   X    $en" 'Red'; if ($he) { Line "        $he" 'Red' } }
function Dry([string]$text) { Line "   (dry run) $text" 'Magenta' }

function Restore-Console {
  if ($script:OrigOutputEncoding) { try { [Console]::OutputEncoding = $script:OrigOutputEncoding } catch { } }
}

function Finish([int]$code) {
  Write-Log "--- finished with exit code $code ($(Get-Date -Format s))"
  if (-not $NoPause) {
    Line ''
    try { [void](Read-Host '  Press Enter to close · לחצו Enter כדי לסגור') } catch { }
  }
  Restore-Console
  exit $code
}

function Test-Interactive {
  try { return -not [Console]::IsInputRedirected } catch { return $true }
}

function Ask-YesNo([string]$en, [string]$he, [bool]$Default = $true) {
  if ($Yes) { Info "$en -> yes (-Yes)"; return $true }
  if (-not (Test-Interactive)) {
    $d = if ($Default) { 'yes' } else { 'no' }
    Info "$en -> $d (no keyboard input; default)"
    return $Default
  }
  Line ''
  $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
  Line "  $en $hint" 'White'
  if ($he) { Line "  $he" 'White' }
  while ($true) {
    $a = Read-Host "  $hint"
    if ($null -eq $a) { return $Default }
    $a = $a.Trim().ToLower()
    Write-Log "  answer: '$a'"
    if ($a -eq '') { return $Default }
    # Y / N typed on a Hebrew keyboard layout give ט / מ
    if ($a -in @('y', 'yes', 'ט', 'כ', 'כן')) { return $true }
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
    try { $f = Join-Path $d.Trim('"') $exe } catch { continue }
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

# Claude Code's folders, the way Claude Code itself finds them: the skills live in <home>\skills and the user settings
# (including user-scope MCP servers) in .claude.json. With CLAUDE_CONFIG_DIR set, both are inside that folder; otherwise
# home = %USERPROFILE%\.claude and the settings file is %USERPROFILE%\.claude.json. -ClaudeHome (tests) acts like
# CLAUDE_CONFIG_DIR, so a test never touches the real settings.
function Get-ClaudeCodeHome([string]$Override) {
  if ($Override) { return [IO.Path]::GetFullPath($Override) }
  if ($env:CLAUDE_CONFIG_DIR) { return [IO.Path]::GetFullPath($env:CLAUDE_CONFIG_DIR) }
  return (Join-Path $env:USERPROFILE '.claude')
}
function Get-ClaudeCodeConfig([string]$Override) {
  if ($Override) { return (Join-Path ([IO.Path]::GetFullPath($Override)) '.claude.json') }
  if ($env:CLAUDE_CONFIG_DIR) { return (Join-Path ([IO.Path]::GetFullPath($env:CLAUDE_CONFIG_DIR)) '.claude.json') }
  return (Join-Path $env:USERPROFILE '.claude.json')
}

# ── Claude Code's command line (claude) ──────────────────────────────────────
# Claude Code is often not on PATH: Claude Desktop brings its own copy in %APPDATA%\Claude\claude-code\<version>\...\claude.exe
# (the Microsoft Store build: in its package folder). Order: PATH, the native / npm / winget install folders, then the
# newest copy that came with Claude Desktop. Every candidate must answer "--version" with "Claude Code" (the Claude
# Desktop app itself is also called claude.exe - it is never used). -Override: a claude.exe to use, or 'none' (tests).
function ConvertTo-CmdArg([string]$a) {
  if ($a -eq '') { return '""' }
  if ($a -notmatch '[\s"]') { return $a }
  return '"' + (($a -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}
# Runs a program with a time limit, stdin closed, output captured. -ConfigDir sets CLAUDE_CONFIG_DIR for it only.
function Invoke-Program([string]$Exe, [string[]]$Arguments, [string]$ConfigDir, [int]$TimeoutSec = 60) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $argStr = (@($Arguments) | ForEach-Object { ConvertTo-CmdArg $_ }) -join ' '
  if ($Exe -match '\.(cmd|bat)$') { $psi.FileName = $env:ComSpec; $psi.Arguments = '/d /s /c "' + (ConvertTo-CmdArg $Exe) + ' ' + $argStr + '"' }
  else { $psi.FileName = $Exe; $psi.Arguments = $argStr }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  if ($ConfigDir) { $psi.EnvironmentVariables['CLAUDE_CONFIG_DIR'] = $ConfigDir }
  try { $p = [Diagnostics.Process]::Start($psi) } catch { return [pscustomobject]@{ Code = -1; Out = $_.Exception.Message } }
  try { $p.StandardInput.Close() } catch { }
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill() } catch { }
    return [pscustomobject]@{ Code = -1; Out = "no answer after $TimeoutSec s" }
  }
  $p.WaitForExit()
  return [pscustomobject]@{ Code = $p.ExitCode; Out = ("$($o.Result)`n$($e.Result)").Trim() }
}
function Test-ClaudeCli([string]$exe) {
  if (-not (Test-File $exe)) { return $false }
  if ($exe -match '\\(WindowsApps|AnthropicClaude)\\') { return $false }
  $r = Invoke-Program $exe @('--version') $null 30
  return ($r.Code -eq 0 -and $r.Out -match 'Claude Code')
}
function Get-BundledClaudeCli {
  $roots = @(Join-Path $env:APPDATA 'Claude\claude-code')
  foreach ($pkg in @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Packages') -Directory -Filter 'Claude_*' -ErrorAction SilentlyContinue)) {
    $roots += Join-Path $pkg.FullName 'LocalCache\Roaming\Claude\claude-code'
  }
  $found = @()
  foreach ($r in $roots) {
    if (-not (Test-Path -LiteralPath $r -PathType Container)) { continue }
    foreach ($f in @(Get-ChildItem -LiteralPath $r -Recurse -Depth 2 -Filter 'claude.exe' -File -ErrorAction SilentlyContinue)) {
      # <root>\<version>\[<build>\]claude.exe - newest version first
      $first = ($f.FullName.Substring($r.Length).TrimStart('\') -split '\\')[0]
      $ver = [version]'0.0'
      try { $ver = [version]$first } catch { }
      $found += [pscustomobject]@{ Path = $f.FullName; Ver = $ver; Time = $f.LastWriteTimeUtc }
    }
  }
  return @($found | Sort-Object -Property @{ Expression = 'Ver'; Descending = $true }, @{ Expression = 'Time'; Descending = $true } | ForEach-Object { $_.Path })
}
function Find-ClaudeCli([string]$Override) {
  if ($Override) {
    if ($Override -eq 'none') { return $null }
    $o = [IO.Path]::GetFullPath($Override)
    if (Test-ClaudeCli $o) { return $o }
    return $null
  }
  $cands = @()
  foreach ($pl in @($env:Path, (Get-FreshPath))) {
    foreach ($n in 'claude.exe', 'claude.cmd') { $f = Find-InPath $n $pl; if ($f) { $cands += $f } }
  }
  $cands += @((Join-Path $env:USERPROFILE '.local\bin\claude.exe'), (Join-Path $env:APPDATA 'npm\claude.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\claude.exe'))
  $cands += Get-BundledClaudeCli
  foreach ($c in ($cands | Where-Object { Test-File $_ } | Select-Object -Unique)) {
    if (Test-ClaudeCli $c) { return $c }
  }
  return $null
}

# Claude Code MCP entry (user scope). With the claude command: "claude mcp add --scope user" (Claude Code writes its own
# settings file). Without it, or when it fails: the same entry is merged straight into .claude.json by claude-connect.mjs
# (backup first, everything else kept, a missing file is created). $CodeCfg = the settings file; for a test file
# (-ClaudeJson / -ClaudeHome) the command is pointed at it through CLAUDE_CONFIG_DIR, or not used when the file is not
# named .claude.json. Returns $true when Claude Code ends up connected.
function Write-ConnectOutput($lines, [int]$code) {
  foreach ($l in @($lines)) { if ("$l".Trim()) { if ($DryRun) { Dry "$l" } elseif ($code -eq 0) { Info "$l" } else { Warn "$l" } } }
}
function Get-CliConfigDir([string]$CodeCfg, [bool]$IsTest) {
  if (-not $IsTest) { return '' }
  if ((Split-Path -Leaf $CodeCfg) -ieq '.claude.json') { return (Split-Path -Parent $CodeCfg) }
  return $null   # a test file with another name: the claude command cannot be pointed at it
}
function Connect-ClaudeCodeMcp([string]$NodeExe, [string]$Connect, [string]$Server, [string]$CodeCfg, [bool]$IsTest, [string]$CliOverride) {
  $state = @(& $NodeExe $Connect code-add --config $CodeCfg --node $NodeExe --server $Server --dry-run 2>&1)
  if ($LASTEXITCODE -ne 0) { Write-ConnectOutput $state 1; return $false }
  if (($state -join ' ') -match 'already connected') { Write-ConnectOutput $state 0; return $true }
  $cfgDir = Get-CliConfigDir $CodeCfg $IsTest
  $cli = if ($null -ne $cfgDir) { Find-ClaudeCli $CliOverride } else { $null }
  if ($cli) {
    if ($DryRun) { Dry "Claude Code: would run `"$cli`" mcp add --scope user frame-studio -- `"$NodeExe`" `"$Server`""; return $true }
    Info "Claude Code: using $cli"
    if (($state -join ' ') -match 'would update') {
      $null = Invoke-Program $cli @('mcp', 'remove', '--scope', 'user', 'frame-studio') $cfgDir
    }
    $r = Invoke-Program $cli @('mcp', 'add', '--scope', 'user', 'frame-studio', '--', $NodeExe, $Server) $cfgDir
    $check = @(& $NodeExe $Connect code-add --config $CodeCfg --node $NodeExe --server $Server --dry-run 2>&1)
    if ($r.Code -eq 0 -and ($check -join ' ') -match 'already connected') { Info "Claude Code: added `"frame-studio`" (claude mcp add --scope user)"; return $true }
    Warn "Claude Code: 'claude mcp add' did not work ($($r.Out -replace '\s+', ' ')) - writing $CodeCfg directly."
  } else {
    Info 'Claude Code: the claude command was not found - writing its settings file directly.' 'Claude Code: הפקודה claude לא נמצאה - כותבים ישירות לקובץ ההגדרות שלו.'
  }
  $dryArg = @(); if ($DryRun) { $dryArg = @('--dry-run') }
  $out = & $NodeExe $Connect code-add --config $CodeCfg --node $NodeExe --server $Server @dryArg 2>&1
  $code = $LASTEXITCODE
  Write-ConnectOutput $out $code
  return ($code -eq 0)
}
function Disconnect-ClaudeCodeMcp([string]$NodeExe, [string]$Connect, [string]$AppRoot, [string]$CodeCfg, [bool]$IsTest, [string]$CliOverride) {
  if (-not (Test-File $CodeCfg)) { Info "Claude Code: nothing to remove ($CodeCfg does not exist)"; return }
  $state = @(& $NodeExe $Connect code-remove --config $CodeCfg --app $AppRoot --dry-run 2>&1)
  if ($LASTEXITCODE -ne 0 -or -not (($state -join ' ') -match 'would remove')) { Write-ConnectOutput $state 0; return }
  $cfgDir = Get-CliConfigDir $CodeCfg $IsTest
  $cli = if ($null -ne $cfgDir) { Find-ClaudeCli $CliOverride } else { $null }
  if ($cli -and -not $DryRun) {
    $r = Invoke-Program $cli @('mcp', 'remove', '--scope', 'user', 'frame-studio') $cfgDir
    $left = @(& $NodeExe $Connect code-remove --config $CodeCfg --app $AppRoot --dry-run 2>&1)
    if (-not (($left -join ' ') -match 'would remove')) { Info "Claude Code: removed `"frame-studio`" (claude mcp remove --scope user, $cli)"; return }
    Warn "Claude Code: 'claude mcp remove' did not work ($($r.Out -replace '\s+', ' ')) - editing $CodeCfg directly."
  }
  $dryArg = @(); if ($DryRun) { $dryArg = @('--dry-run') }
  $out = & $NodeExe $Connect code-remove --config $CodeCfg --app $AppRoot @dryArg 2>&1
  Write-ConnectOutput $out 0
}

function Get-NodeMajor([string]$exe) {
  try { $v = @(& $exe --version 2>$null)[0] } catch { return -1 }
  if ("$v" -match '^v(\d+)\.') { return [int]$Matches[1] }
  return -1
}

# Node.js: the portable copy in runtime\node first, then PATH and the usual install folders.
# -PortableOnly: only runtime\node (used with -ForcePortable).
function Find-Node([switch]$PortableOnly, [string]$AppRoot = $Root) {
  $cands = @(Join-Path $AppRoot 'runtime\node\node.exe')
  if (-not $PortableOnly) {
    $cands += Find-InPath 'node.exe' $SessionPath
    $cands += Find-InPath 'node.exe' (Get-FreshPath)
    $cands += @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\node.exe",
      "$env:ProgramFiles\WinGet\Links\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")
  }
  $best = [pscustomobject]@{ Path = $null; Major = -1; Ok = $false }
  foreach ($c in ($cands | Where-Object { Test-File $_ } | Select-Object -Unique)) {
    $m = Get-NodeMajor $c
    if ($m -ge $MinNode) { return [pscustomobject]@{ Path = $c; Major = $m; Ok = $true } }
    if ($m -gt $best.Major) { $best = [pscustomobject]@{ Path = $c; Major = $m; Ok = $false } }
  }
  return $best
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

# Google Chrome -> Chromium -> Microsoft Edge (the same order as the server, server\config.mjs)
function Find-Browser {
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
  foreach ($sub in 'Google\Chrome\Application\chrome.exe', 'Chromium\Application\chrome.exe', 'Microsoft\Edge\Application\msedge.exe') {
    foreach ($r in $roots) { $f = Join-Path $r $sub; if (Test-File $f) { return $f } }
  }
  foreach ($k in 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
                 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') {
    try { $v = (Get-ItemProperty -LiteralPath $k -ErrorAction Stop).'(default)' } catch { continue }
    if ($v) { $v = $v.Trim('"') }
    if (Test-File $v) { return $v }
  }
  return $null
}

# ───────────────────────────── downloads ─────────────────────────────

function Format-MB([double]$bytes) { return ('{0:N1} MB' -f ($bytes / 1MB)) }

# Downloads $Url to $OutFile with a one-line progress display. Retries 3 times. Throws on failure.
#   -MinBytesPerWindow N  give up on this server (no retries) when fewer than N bytes arrive in any -WindowSec
#                         seconds - for callers that have another server to try (a throttled mirror is never
#                         abandoned otherwise). The thrown message starts with "too slow".
#   -IdleSec              give up the attempt when no data at all arrives for that long (then retry).
function Save-Download([string]$Url, [string]$OutFile, [string]$Label, [long]$MinBytesPerWindow = 0, [int]$WindowSec = 20, [int]$IdleSec = 60) {
  Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
  $last = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $client = $null; $resp = $null; $in = $null; $out = $null
    try {
      $handler = New-Object System.Net.Http.HttpClientHandler
      $handler.AllowAutoRedirect = $true
      $client = New-Object System.Net.Http.HttpClient($handler)
      # no overall limit (a slow but working connection must be able to finish); stalls are caught per read below
      $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
      $client.DefaultRequestHeaders.UserAgent.ParseAdd('FrameStudio-Installer/1.0')
      $get = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead)
      if (-not $get.Wait([TimeSpan]::FromSeconds([Math]::Max(30, $IdleSec)))) { $client.CancelPendingRequests(); throw "no answer from the server in $([Math]::Max(30, $IdleSec)) s" }
      $resp = $get.Result
      if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode) $($resp.ReasonPhrase)" }
      $total = $resp.Content.Headers.ContentLength
      $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $dir = Split-Path -Parent $OutFile
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
      $out = [IO.File]::Create($OutFile)
      $buf = New-Object byte[] (1MB)
      $done = 0L
      $sw = [Diagnostics.Stopwatch]::StartNew()
      $lastShow = -1000
      $winStartMs = 0L; $winStartBytes = 0L
      while ($true) {
        $read = $in.ReadAsync($buf, 0, $buf.Length)
        if (-not $read.Wait([TimeSpan]::FromSeconds($IdleSec))) { throw "no data for $IdleSec s" }
        $n = $read.Result
        if ($n -le 0) { break }
        $out.Write($buf, 0, $n)
        $done += $n
        if ($MinBytesPerWindow -gt 0 -and ($sw.ElapsedMilliseconds - $winStartMs) -ge ($WindowSec * 1000)) {
          $got = $done - $winStartBytes
          if ($got -lt $MinBytesPerWindow) {
            $kbs = [int]($got / 1KB / [Math]::Max(1, ($sw.ElapsedMilliseconds - $winStartMs) / 1000))
            throw "too slow ($kbs KB/s)"
          }
          $winStartMs = $sw.ElapsedMilliseconds; $winStartBytes = $done
        }
        if ($sw.ElapsedMilliseconds - $lastShow -ge 250) {
          $lastShow = $sw.ElapsedMilliseconds
          $pct = if ($total) { ' ({0}%)' -f [int](100 * $done / $total) } else { '' }
          $of = if ($total) { " / $(Format-MB $total)" } else { '' }
          Write-Host -NoNewline ("`r        $Label  $(Format-MB $done)$of$pct      ")
        }
      }
      $out.Close(); $out = $null
      $secs = [Math]::Max(0.1, $sw.Elapsed.TotalSeconds)
      Write-Host ("`r        $Label  $(Format-MB $done) - {0:N0}s ({1:N1} MB/s)            " -f $secs, ($done / 1MB / $secs))
      Write-Log "        downloaded $Url -> $OutFile ($done bytes, $([int]$secs)s)"
      if ($total -and $done -ne $total) { throw "incomplete download ($done of $total bytes)" }
      return
    } catch {
      $last = $_.Exception.Message
      if ($_.Exception.InnerException) { $last += " ($($_.Exception.InnerException.Message))" }
      Write-Host ''
      Write-Log "        download problem ($Url): $last"
      if ($last -like 'too slow*') { throw $last }       # the caller tries another server; retrying this one won't help
      Warn "Download failed (attempt $attempt of 3): $last"
      Start-Sleep -Seconds (2 * $attempt)
    } finally {
      if ($out) { $out.Dispose() }
      if ($in) { $in.Dispose() }
      if ($resp) { $resp.Dispose() }
      if ($client) { $client.Dispose() }
    }
  }
  throw "download failed: $Url ($last)"
}

function Get-Sha256([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower() }

# ───────────────────────────── shortcuts, PATH ─────────────────────────────

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments = '', [string]$WorkDir = '', [string]$Icon = '', [string]$Description = '', [int]$WindowStyle = 1) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  try {
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    if ($Arguments) { $lnk.Arguments = $Arguments }
    if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
    if ($Icon) { $lnk.IconLocation = "$Icon,0" }
    if ($Description) { $lnk.Description = $Description }
    $lnk.WindowStyle = $WindowStyle
    $lnk.Save()
  } finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

# Target + arguments of a .lnk file, or $null
function Get-ShortcutInfo([string]$Path) {
  if (-not (Test-File $Path)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  try { $l = $shell.CreateShortcut($Path); return [pscustomobject]@{ Target = $l.TargetPath; Arguments = $l.Arguments } }
  finally { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) }
}

function Normalize-Dir([string]$p) {
  if (-not $p) { return '' }
  try { $p = [IO.Path]::GetFullPath($p.Trim().Trim('"')) } catch { }
  return $p.TrimEnd('\', '/').ToLowerInvariant()
}

# The user PATH from the registry, raw (unexpanded %VARS% stay as they are), and its value kind
function Get-UserPathRaw {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $false)
  if (-not $key) { return [pscustomobject]@{ Value = ''; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString } }
  try {
    $v = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
    return [pscustomobject]@{ Value = [string]$v; Kind = $kind }
  } finally { $key.Close() }
}

function Set-UserPathRaw([string]$value, $kind) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try { $key.SetValue('Path', $value, $kind) } finally { $key.Close() }
  Send-EnvironmentChanged
}

# Tells Explorer (and so every program started from now on) that the environment changed
function Send-EnvironmentChanged {
  try {
    if (-not ('FrameStudio.NativeEnv' -as [type])) {
      Add-Type -Namespace FrameStudio -Name NativeEnv -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $r = [UIntPtr]::Zero
    [void][FrameStudio.NativeEnv]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 3000, [ref]$r)
  } catch { }
}

function Test-UserPathHas([string]$dir) {
  $want = Normalize-Dir $dir
  foreach ($p in ((Get-UserPathRaw).Value -split ';')) {
    if (-not $p.Trim()) { continue }
    if ((Normalize-Dir ([Environment]::ExpandEnvironmentVariables($p))) -eq $want) { return $true }
  }
  return $false
}

function Add-UserPath([string]$dir) {
  if (Test-UserPathHas $dir) { return $false }
  $cur = Get-UserPathRaw
  $v = $cur.Value.TrimEnd(';')
  $new = if ($v) { "$v;$dir" } else { $dir }
  Set-UserPathRaw $new $cur.Kind
  return $true
}

function Remove-UserPath([string]$dir) {
  $want = Normalize-Dir $dir
  $cur = Get-UserPathRaw
  $keep = @()
  $removed = $false
  foreach ($p in ($cur.Value -split ';')) {
    if (-not $p.Trim()) { continue }
    if ((Normalize-Dir ([Environment]::ExpandEnvironmentVariables($p))) -eq $want) { $removed = $true; continue }
    $keep += $p
  }
  if ($removed) { Set-UserPathRaw ($keep -join ';') $cur.Kind }
  return $removed
}

# ───────────────────────────── Frame Studio server ─────────────────────────────

# Stops a Frame Studio server that runs from $AppRoot (asks it to shut down). Returns $true if one was stopped.
function Stop-AppServer([string]$AppRoot, [int[]]$Ports = @(7788)) {
  $stopped = $false
  $want = Normalize-Dir $AppRoot
  foreach ($port in ($Ports | Select-Object -Unique)) {
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -UseBasicParsing } catch { continue }
    if (-not $h -or $h.app -ne 'frame-studio' -or (Normalize-Dir $h.root) -ne $want) { continue }
    try { [void](Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 5 -UseBasicParsing) } catch { }
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 250
      try { [void](Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1 -UseBasicParsing) } catch { break }
    }
    $stopped = $true
  }
  return $stopped
}

# Programs started from inside $AppRoot (its portable node.exe running the server or the Claude connection, ffmpeg)
function Get-AppProcesses([string]$AppRoot) {
  $want = (Normalize-Dir $AppRoot) + '\'
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $p = $null
      try { $p = $_.Path } catch { }
      $p -and ((Normalize-Dir $p) + '').StartsWith($want)
    })
}
