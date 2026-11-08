# Frame Studio - one-line installer for Windows 10 / 11. No administrator rights, nothing to install by hand.
#
#   Open PowerShell (right-click the Start button -> Terminal) and paste:
#
#     irm https://raw.githubusercontent.com/YonatanProX/frame-studio/main/install.ps1 | iex
#
# It downloads the latest Frame Studio release from GitHub, puts it in %LOCALAPPDATA%\Programs\Frame Studio and runs
# tools\install.ps1 from there: portable Node.js + ffmpeg when the computer has none, your files in
# <your Documents folder>\Frame Studio, Desktop + Start Menu shortcuts, the cutx command, and (one question) the connection to Claude.
# Running it again updates Frame Studio: the program files are replaced, config.json and runtime\ are kept.
#
# Options (advanced / testing). With "irm | iex" set them first:  $env:FRAME_STUDIO_INSTALL_ARGS = '-NoStart -Yes'
# or run:  & ([scriptblock]::Create((irm <this url>))) -NoStart -Yes
#   -Source <zip | folder | https url>   install from there instead of the latest GitHub release
#   -AppDir <dir>        program folder (default %LOCALAPPDATA%\Programs\Frame Studio)
#   -DataDir <dir>       your projects + sounds (default: <your Documents folder>\Frame Studio)
#   -ForcePortable       use the portable Node.js / ffmpeg even if the computer has them
#   -NoShortcut  -ShortcutDir <dir>  -NoPath  -NoRegistry  -NoClaude  -ClaudeDesktopConfig <file>  -ClaudeHome <dir>
#   -NoStart  -Yes  -DryRun  -LogFile <file>
#   -Repo <owner/name>  -ApiBase <url>  -FallbackUrl <zip url>   (where releases come from; for forks and tests)
#
# This file is plain ASCII on purpose (it runs through Invoke-Expression); Hebrew text is written as \u escapes.
[CmdletBinding()]
param(
  [string]$Source,
  [string]$AppDir,
  [string]$DataDir,
  [switch]$ForcePortable,
  [switch]$NoShortcut,
  [string]$ShortcutDir,
  [switch]$NoPath,
  [switch]$NoRegistry,
  [string]$ClaudeDesktopConfig,
  [string]$ClaudeHome,
  [switch]$NoClaude,
  [switch]$NoStart,
  [switch]$Yes,
  [switch]$DryRun,
  [string]$LogFile,
  [string]$Repo,
  [string]$ApiBase,
  [string]$FallbackUrl
)

function Invoke-FrameStudioInstall {
  [CmdletBinding()]
  param(
    [string]$Source,
    [string]$AppDir,
    [string]$DataDir,
    [switch]$ForcePortable,
    [switch]$NoShortcut,
    [string]$ShortcutDir,
    [switch]$NoPath,
    [switch]$NoRegistry,
    [string]$ClaudeDesktopConfig,
    [string]$ClaudeHome,
    [switch]$NoClaude,
    [switch]$NoStart,
    [switch]$Yes,
    [switch]$DryRun,
    [string]$LogFile,
    [string]$Repo = 'YonatanProX/frame-studio',
    [string]$ApiBase = 'https://api.github.com',
    [string]$FallbackUrl
  )
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  if (-not $Repo) { $Repo = 'YonatanProX/frame-studio' }
  if (-not $ApiBase) { $ApiBase = 'https://api.github.com' }
  if (-not $FallbackUrl) { $FallbackUrl = "https://github.com/$Repo/archive/refs/heads/main.zip" }
  if (-not $AppDir) { $AppDir = Join-Path $env:LOCALAPPDATA 'Programs\Frame Studio' }
  if (-not $LogFile) { $LogFile = Join-Path $env:LOCALAPPDATA 'Frame Studio\install.log' }
  $AppDir = [IO.Path]::GetFullPath($AppDir).TrimEnd('\')
  $LogFile = [IO.Path]::GetFullPath($LogFile)

  function He([string]$s) { return [regex]::Unescape($s) }
  function Log([string]$t) {
    try {
      $d = Split-Path -Parent $LogFile
      if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
      [IO.File]::AppendAllText($LogFile, "$t`r`n", [Text.Encoding]::UTF8)
    } catch { }
  }
  function Say([string]$en, [string]$he = '', [string]$color = 'Gray') {
    Write-Host "  $en" -ForegroundColor $color; Log "  $en"
    if ($he) { $h = He $he; Write-Host "  $h" -ForegroundColor $color; Log "  $h" }
  }
  function Norm([string]$p) { if (-not $p) { return '' }; return ([IO.Path]::GetFullPath($p)).TrimEnd('\', '/').ToLowerInvariant() }

  function Get-File([string]$Url, [string]$OutFile, [string]$Label) {
    Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
    $last = ''
    for ($attempt = 1; $attempt -le 3; $attempt++) {
      $client = $null; $resp = $null; $in = $null; $out = $null
      try {
        $client = New-Object System.Net.Http.HttpClient
        $client.Timeout = [TimeSpan]::FromMinutes(20)
        $client.DefaultRequestHeaders.UserAgent.ParseAdd('FrameStudio-Installer/1.0')
        $resp = $client.GetAsync($Url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode) $($resp.ReasonPhrase)" }
        $total = $resp.Content.Headers.ContentLength
        $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $out = [IO.File]::Create($OutFile)
        $buf = New-Object byte[] (1MB)
        $done = 0L
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $shown = -1000
        while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
          $out.Write($buf, 0, $n); $done += $n
          if ($sw.ElapsedMilliseconds - $shown -ge 250) {
            $shown = $sw.ElapsedMilliseconds
            $of = if ($total) { ' / {0:N1} MB ({1}%)' -f ($total / 1MB), [int](100 * $done / $total) } else { '' }
            Write-Host -NoNewline ("`r  $Label  {0:N1} MB$of      " -f ($done / 1MB))
          }
        }
        $out.Close(); $out = $null
        Write-Host ("`r  $Label  {0:N1} MB - done                        " -f ($done / 1MB))
        Log "  downloaded $Url ($done bytes)"
        if ($total -and $done -ne $total) { throw "incomplete download ($done of $total bytes)" }
        return
      } catch {
        $last = $_.Exception.Message
        Write-Host ''
        Say "Download failed (attempt $attempt of 3): $last" '' 'Yellow'
        Start-Sleep -Seconds (2 * $attempt)
      } finally {
        if ($out) { $out.Dispose() }; if ($in) { $in.Dispose() }; if ($resp) { $resp.Dispose() }; if ($client) { $client.Dispose() }
      }
    }
    throw "could not download $Url ($last)"
  }

  # the folder (inside $dir, or $dir itself) that contains tools\install.ps1
  function Find-AppRoot([string]$dir) {
    if (Test-Path -LiteralPath (Join-Path $dir 'tools\install.ps1')) { return $dir }
    foreach ($d in @(Get-ChildItem -LiteralPath $dir -Directory -Force -ErrorAction SilentlyContinue)) {
      if (Test-Path -LiteralPath (Join-Path $d.FullName 'tools\install.ps1')) { return $d.FullName }
    }
    return $null
  }

  function Expand-Zip([string]$zip, [string]$to) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force }
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $to)
    $r = Find-AppRoot $to
    if (-not $r) { throw "this ZIP is not a Frame Studio download (no tools\install.ps1 inside): $zip" }
    return $r
  }

  # Stops a Frame Studio server that runs from the program folder, so its files can be replaced
  function Stop-OldServer([string]$dir) {
    $ports = @(7788)
    if ($env:FRAME_STUDIO_PORT -match '^\d+$') { $ports += [int]$env:FRAME_STUDIO_PORT }
    foreach ($port in $ports) {
      try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2 -UseBasicParsing } catch { continue }
      if (-not $h -or $h.app -ne 'frame-studio' -or (Norm $h.root) -ne (Norm $dir)) { continue }
      Say 'Closing the Frame Studio that is running now...' '\u05e1\u05d5\u05d2\u05e8\u05d9\u05dd \u05d0\u05ea Frame Studio \u05e9\u05e4\u05d5\u05e2\u05dc \u05e2\u05db\u05e9\u05d9\u05d5'
      try { [void](Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$port/api/shutdown" -TimeoutSec 5 -UseBasicParsing) } catch { }
      for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 250
        try { [void](Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1 -UseBasicParsing) } catch { break }
      }
    }
  }

  $work = Join-Path ([IO.Path]::GetTempPath()) ('frame-studio-setup-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $code = 1
  try {
    if ($PSVersionTable.PSVersion.Major -lt 5) { throw 'Windows PowerShell 5.1 or newer is needed.' }
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    Log ''
    Log "=== Frame Studio online installer - $(Get-Date -Format s) - AppDir $AppDir"
    Write-Host ''
    Write-Host '  ==========================================================' -ForegroundColor White
    Write-Host "   Frame Studio - setup                 $(He '\u05d4\u05ea\u05e7\u05e0\u05ea Frame Studio')" -ForegroundColor White
    Write-Host '  ==========================================================' -ForegroundColor White

    # -- 1. get Frame Studio --
    $srcRoot = $null
    $label = ''
    if ($Source) {
      if ($Source -match '^https?://') {
        $zip = Join-Path $work 'frame-studio.zip'
        Say "Downloading $Source" '\u05de\u05d5\u05e8\u05d9\u05d3\u05d9\u05dd \u05d0\u05ea Frame Studio...'
        Get-File $Source $zip 'Frame Studio'
        $srcRoot = Expand-Zip $zip (Join-Path $work 'x')
      } elseif (Test-Path -LiteralPath $Source -PathType Container) {
        $srcRoot = Find-AppRoot ([IO.Path]::GetFullPath($Source))
        if (-not $srcRoot) { throw "not a Frame Studio folder (no tools\install.ps1): $Source" }
      } elseif (Test-Path -LiteralPath $Source -PathType Leaf) {
        $srcRoot = Expand-Zip ([IO.Path]::GetFullPath($Source)) (Join-Path $work 'x')
      } else { throw "-Source not found: $Source" }
      $label = $Source
    } else {
      $url = $null; $shaUrl = $null
      try {
        $rel = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest" -UseBasicParsing -TimeoutSec 30 `
          -Headers @{ 'User-Agent' = 'FrameStudio-Installer'; 'Accept' = 'application/vnd.github+json' }
        $asset = @($rel.assets) | Where-Object { $_.name -like 'frame-studio-*.zip' } | Select-Object -First 1
        if ($asset) {
          $url = $asset.browser_download_url
          $sha = @($rel.assets) | Where-Object { $_.name -eq "$($asset.name).sha256" } | Select-Object -First 1
          if ($sha) { $shaUrl = $sha.browser_download_url }
          $label = "release $($rel.tag_name) ($($asset.name))"
        }
      } catch { Log "  releases/latest: $($_.Exception.Message)" }
      if (-not $url) { $url = $FallbackUrl; $label = "$FallbackUrl (no release found)" }
      $zip = Join-Path $work 'frame-studio.zip'
      Say "Downloading Frame Studio: $label" '\u05de\u05d5\u05e8\u05d9\u05d3\u05d9\u05dd \u05d0\u05ea Frame Studio...'
      Get-File $url $zip 'Frame Studio'
      if ($shaUrl) {
        $want = $null
        try { $want = ([string](Invoke-RestMethod -Uri $shaUrl -UseBasicParsing -TimeoutSec 30 -Headers @{ 'User-Agent' = 'FrameStudio-Installer' })).Trim().Split(' ')[0].ToLower() } catch { }
        if ($want -match '^[0-9a-f]{64}$') {
          $got = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
          if ($got -ne $want) { throw "the download is damaged (SHA-256 $got, expected $want) - please try again" }
          Say 'SHA-256 verified.'
        }
      }
      $srcRoot = Expand-Zip $zip (Join-Path $work 'x')
      # a release made before this installer existed cannot be set up by it: take the current code instead
      if (-not (Test-Path -LiteralPath (Join-Path $srcRoot 'uninstall.ps1')) -and $url -ne $FallbackUrl) {
        Say "That release is older than this installer - downloading the current version instead ($FallbackUrl)" '' 'Yellow'
        $label = "$FallbackUrl (newest code)"
        $zip = Join-Path $work 'frame-studio-current.zip'
        Get-File $FallbackUrl $zip 'Frame Studio'
        $srcRoot = Expand-Zip $zip (Join-Path $work 'y')
      }
    }
    $version = '?'
    try { $version = (Get-Content -LiteralPath (Join-Path $srcRoot 'package.json') -Raw | ConvertFrom-Json).version } catch { }
    Say "Frame Studio $version  ($label)"

    # -- 2. copy it to the program folder --
    $installer = Join-Path $AppDir 'tools\install.ps1'
    if ($DryRun) {
      Say "(dry run) would install to $AppDir" '' 'Magenta'
      $installer = Join-Path $srcRoot 'tools\install.ps1'
    } elseif ((Norm $srcRoot) -ne (Norm $AppDir)) {
      $existing = @()
      if (Test-Path -LiteralPath $AppDir) { $existing = @(Get-ChildItem -LiteralPath $AppDir -Force) }
      if ($existing.Count) {
        $ours = Test-Path -LiteralPath (Join-Path $AppDir 'install-info.json')
        if (-not $ours) {
          try { $ours = ((Get-Content -LiteralPath (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).name -eq 'frame-studio') } catch { }
        }
        if (-not $ours) {
          Say "This folder is not empty and is not a Frame Studio installation: $AppDir" '\u05d4\u05ea\u05d9\u05e7\u05d9\u05d9\u05d4 \u05d4\u05d6\u05d5 \u05dc\u05d0 \u05e8\u05d9\u05e7\u05d4 \u05d5\u05d0\u05d9\u05e0\u05d4 \u05d4\u05ea\u05e7\u05e0\u05d4 \u05e9\u05dc Frame Studio - \u05d1\u05d7\u05e8\u05d5 \u05ea\u05d9\u05e7\u05d9\u05d9\u05d4 \u05d0\u05d7\u05e8\u05ea \u05e2\u05dd -AppDir' 'Red'
          throw 'refusing to overwrite a folder that is not Frame Studio'
        }
        Say "Updating the installation in $AppDir (your settings and files are kept)" '\u05de\u05e2\u05d3\u05db\u05e0\u05d9\u05dd \u05d4\u05ea\u05e7\u05e0\u05d4 \u05e7\u05d9\u05d9\u05de\u05ea (\u05d4\u05d4\u05d2\u05d3\u05e8\u05d5\u05ea \u05d5\u05d4\u05e7\u05d1\u05e6\u05d9\u05dd \u05e9\u05dc\u05db\u05dd \u05e0\u05e9\u05de\u05e8\u05d9\u05dd)'
        Stop-OldServer $AppDir
        # keep: settings, the portable runtime, logs, and user data that may live in the program folder
        $keep = @('config.json', 'config.json.bak', 'runtime', 'server.log', 'server.old.log', 'projects', 'sounds', 'sound-folders.json', 'library')
        foreach ($it in $existing) {
          if ($keep -contains $it.Name.ToLowerInvariant()) { continue }
          Remove-Item -LiteralPath $it.FullName -Recurse -Force
        }
        $lib = Join-Path $AppDir 'library'
        if (Test-Path -LiteralPath $lib) {
          foreach ($it in @(Get-ChildItem -LiteralPath $lib -Force)) { if ($it.Name -ne 'sounds') { Remove-Item -LiteralPath $it.FullName -Recurse -Force } }
        }
      }
      # (Say runs the Hebrew text through [regex]::Unescape, so a path is added escaped)
      Say "Copying the files to $AppDir" ('\u05de\u05e2\u05ea\u05d9\u05e7\u05d9\u05dd \u05d0\u05ea \u05d4\u05e7\u05d1\u05e6\u05d9\u05dd \u05d0\u05dc ' + [regex]::Escape($AppDir))
      New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
      $rc = Join-Path $env:SystemRoot 'System32\robocopy.exe'
      # never copy a developer's own state from a source folder (git data, settings, projects, the portable runtime)
      $xd = @('.git', 'node_modules', 'dist', 'runtime', 'projects', 'Sounds') | ForEach-Object { Join-Path $srcRoot $_ }
      $xf = @('config.json', 'config.json.bak', 'server.log', 'server.old.log', 'install-info.json', 'sound-folders.json') | ForEach-Object { Join-Path $srcRoot $_ }
      $null = & $rc $srcRoot $AppDir /E /R:2 /W:1 /NFL /NDL /NJH /NJS /NP /XD @xd /XF @xf
      if ($LASTEXITCODE -ge 8) { throw "copying the files failed (robocopy exit code $LASTEXITCODE)" }
      $info = [ordered]@{ app = 'frame-studio'; version = $version; installedAt = (Get-Date).ToString('s'); source = $label }
      [IO.File]::WriteAllText((Join-Path $AppDir 'install-info.json'), ($info | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    }
    if (-not (Test-Path -LiteralPath $installer)) { throw "missing $installer" }

    # -- 3. the rest is done by tools\install.ps1 from the program folder --
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-NoPause', '-Bootstrapped', '-LogFile', $LogFile)
    if ($DryRun) { $a += @('-DryRun', '-AppDir', $AppDir) }
    foreach ($p in @('DataDir', 'ShortcutDir', 'ClaudeDesktopConfig', 'ClaudeHome')) {
      $v = Get-Variable -Name $p -ValueOnly
      if ($v) { $a += @("-$p", ([IO.Path]::GetFullPath($v)).TrimEnd('\')) }
    }
    foreach ($s in @('ForcePortable', 'NoShortcut', 'NoPath', 'NoRegistry', 'NoClaude', 'NoStart', 'Yes')) {
      if ((Get-Variable -Name $s -ValueOnly).IsPresent) { $a += "-$s" }
    }
    Log "  running: $installer $($a[5..($a.Count - 1)] -join ' ')"
    # same console window (keeps the colors and the keyboard for the one question); wait for it, but not for the
    # editor it starts at the end
    $argLine = ($a | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '') + '"' } else { $_ } }) -join ' '
    $proc = Start-Process -FilePath $ps -ArgumentList $argLine -NoNewWindow -PassThru
    $null = $proc.Handle
    $proc.WaitForExit()
    $code = $proc.ExitCode
  } catch {
    Write-Host ''
    Say "Setup failed: $($_.Exception.Message)" ('\u05d4\u05d4\u05ea\u05e7\u05e0\u05d4 \u05e0\u05db\u05e9\u05dc\u05d4: ' + [regex]::Escape($_.Exception.Message)) 'Red'
    Say 'Check the internet connection and try again. Details are in the log:' '\u05d1\u05d3\u05e7\u05d5 \u05d0\u05ea \u05d4\u05d7\u05d9\u05d1\u05d5\u05e8 \u05dc\u05d0\u05d9\u05e0\u05d8\u05e8\u05e0\u05d8 \u05d5\u05e0\u05e1\u05d5 \u05e9\u05d5\u05d1' 'Red'
    Say $LogFile '' 'Red'
    Log "  ERROR: $($_.Exception.Message)"
    $code = 1
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
  return $code
}

# With "irm | iex" no parameters can be given: take them from $env:FRAME_STUDIO_INSTALL_ARGS (if set).
if ($PSBoundParameters.Count -eq 0 -and $env:FRAME_STUDIO_INSTALL_ARGS) {
  $FrameStudioInstallExit = & ([scriptblock]::Create("Invoke-FrameStudioInstall $env:FRAME_STUDIO_INSTALL_ARGS"))
} else {
  $FrameStudioInstallExit = Invoke-FrameStudioInstall @PSBoundParameters
}
# run as a file (powershell -File install.ps1): exit with the result. Through iex - also inside someone else's script,
# where $MyInvocation names THAT script - never exit: it would close the user's window or stop their script.
$FrameStudioSelf = $MyInvocation.MyCommand.Path
if ($FrameStudioSelf -and (Select-String -LiteralPath $FrameStudioSelf -SimpleMatch 'function Invoke-FrameStudioInstall' -Quiet)) { exit $FrameStudioInstallExit }
Remove-Variable -Name FrameStudioSelf -ErrorAction SilentlyContinue
$global:LASTEXITCODE = $FrameStudioInstallExit
Remove-Variable -Name FrameStudioInstallExit -ErrorAction SilentlyContinue
