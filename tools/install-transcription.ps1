<#
  Frame Studio - optional local transcription (word timestamps -> captions), for Windows 10 / 11.
  Double-click tools\install-transcription.cmd (it runs this file). Install Frame Studio first.

  1. uses the Python that config.json already points to, if it has faster-whisper (nothing else to do)
  2. otherwise finds Python 3.10 - 3.13; if there is none it downloads Python 3.12 from python.org (after one Y/N
     question) and installs it for the current user only - no administrator rights, nothing added to PATH
  3. creates a private Python environment in %LOCALAPPDATA%Frame Studioasr and installs faster-whisper into it
  4. downloads the speech model once (asr.model in config.json, "small" by default: about 500 MB)
  5. writes "asr.python" into config.json (nothing else in the file changes)
  Everything runs on your computer (CPU); after the model download no internet is needed. Safe to run again.

  powershell -NoProfile -ExecutionPolicy Bypass -File tools\install-transcription.ps1 [-DryRun] [-Yes] [-Force] [-SkipModel] [-NoPause] [-Venv <folder>]
    -DryRun     only report what would be done
    -Yes        download / install Python without asking
    -Force      set up the private environment even if config.json already points to a working Python
    -SkipModel  do not download the speech model now (it is then downloaded on the first transcription)
    -Venv       where to create the environment (default %LOCALAPPDATA%\Frame Studio\asr)
    -LogFile    log file (default %LOCALAPPDATA%\Frame Studio\install-transcription.log)

  This file is saved as UTF-8 with BOM so Windows PowerShell 5.1 reads the Hebrew text correctly.
#>
[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Yes,
  [switch]$Force,
  [switch]$SkipModel,
  [switch]$NoPause,
  [string]$Venv = (Join-Path $env:LOCALAPPDATA 'Frame Studio\asr'),
  [string]$LogFile = (Join-Path $env:LOCALAPPDATA 'Frame Studio\install-transcription.log')
)

$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
$Steps = 5

function Get-PyVersion([string]$exe) {
  $v = @(& $exe -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null)[0]
  if ("$v" -match '^(\d+)\.(\d+)$') { return [version]"$v" }
  return $null
}
function Test-Whisper([string]$exe) {
  if (-not (Test-File $exe)) { return $null }
  # (collect all output first: cutting a native pipeline short leaves $LASTEXITCODE unreliable)
  $out = @(& $exe -c "import faster_whisper; print(faster_whisper.__version__)" 2>$null)
  if ($LASTEXITCODE -eq 0 -and $out.Count -and $out[-1]) { return "$($out[-1])".Trim() }
  return $null
}

# Python 3.10 - 3.13 (3.12 preferred). The Microsoft Store "python.exe" stub in WindowsApps is ignored.
function Find-Python {
  $cands = @()
  foreach ($base in @("$env:LOCALAPPDATA\Programs\Python", $env:ProgramFiles)) {
    if (Test-Path -LiteralPath $base) {
      $cands += Get-ChildItem -LiteralPath $base -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' }
    }
  }
  $py = Find-InPath 'py.exe' (Get-FreshPath)
  if (-not $py -and (Test-File "$env:LOCALAPPDATA\Programs\Python\Launcher\py.exe")) { $py = "$env:LOCALAPPDATA\Programs\Python\Launcher\py.exe" }
  if ($py) {
    foreach ($tag in '-3.12', '-3') {
      $exe = @(& $py $tag -c "import sys; print(sys.executable)" 2>$null)
      if ($LASTEXITCODE -eq 0 -and $exe.Count -and $exe[0]) { $cands += "$($exe[0])".Trim() }
    }
  }
  $cands += Find-InPath 'python.exe' (Get-FreshPath)
  $found = @()
  foreach ($c in ($cands | Where-Object { (Test-File $_) -and ($_ -notmatch '\\WindowsApps\\') } | Select-Object -Unique)) {
    $v = Get-PyVersion $c
    if ($v -and $v -ge [version]'3.10' -and $v -lt [version]'3.14') { $found += [pscustomobject]@{ Path = $c; Version = $v } }
  }
  if (-not $found.Count) { return $null }
  $pref = $found | Where-Object { $_.Version -eq [version]'3.12' } | Select-Object -First 1
  if ($pref) { return $pref }
  return ($found | Sort-Object Version -Descending | Select-Object -First 1)
}

function Test-ModelCached([string]$model) {
  $hub = if ($env:HF_HUB_CACHE) { $env:HF_HUB_CACHE } elseif ($env:HF_HOME) { Join-Path $env:HF_HOME 'hub' } else { Join-Path $HOME '.cache\huggingface\hub' }
  return (Test-Path -LiteralPath (Join-Path $hub "models--Systran--faster-whisper-$model"))
}

# ───────────────────────────── start ─────────────────────────────

Write-Log ''
Write-Log "=== Frame Studio local transcription setup - $(Get-Date -Format s)"

Line ''
Line '  ==========================================================' 'White'
Line '   Frame Studio - local transcription        תמלול מקומי' 'White'
Line '  ==========================================================' 'White'
if ($DryRun) { Dry 'nothing will be installed, written or downloaded · מצב בדיקה: שום דבר לא יותקן, ייכתב או יורד' }

$node = Get-NodeExe
$cfg = Read-Config
if (-not $cfg.Valid) {
  Bad 'config.json is not valid JSON. Fix it or delete it, then run this again.' 'הקובץ config.json פגום. תקנו או מחקו אותו והפעילו שוב.'
  Finish 1
}
$model = Get-ConfigValue $cfg 'asr.model'
if (-not $model) { $model = 'small' }
$vpy = Join-Path $Venv 'Scripts\python.exe'
$target = $null

# ── 1. current setting ─────────────────────────────────────────────────────
Step 1 'Checking the current setting' 'בודקים את ההגדרה הנוכחית'
$current = Get-ConfigValue $cfg 'asr.python'
if ($env:FRAME_STUDIO_ASR_PYTHON) { $current = $env:FRAME_STUDIO_ASR_PYTHON; Info 'FRAME_STUDIO_ASR_PYTHON is set and overrides config.json.' }
$curPath = Resolve-ConfigPath $current
$curVer = if ($curPath) { Test-Whisper $curPath } else { $null }
if ($curVer -and -not $Force) {
  Good "Already set up: $curPath (faster-whisper $curVer)" "כבר מוגדר: $curPath"
  $target = $curPath
} elseif ($curPath) {
  if ($curVer) { Info "Configured: $curPath (faster-whisper $curVer) - setting up a new environment anyway (-Force)." }
  else { Warn "config.json points to $curPath, but faster-whisper is not usable there - setting it up again." "ההגדרה מצביעה על $curPath, אבל faster-whisper לא זמין שם - מגדירים מחדש." }
} else {
  Info 'Transcription is not set up yet.' 'התמלול עוד לא מוגדר.'
}

# ── 2. Python ──────────────────────────────────────────────────────────────
Step 2 'Python' 'פייתון'
$python = $null
if ($target) {
  Info 'Not needed (already set up).' 'לא נדרש (כבר מוגדר).'
} elseif (Test-Whisper $vpy) {
  Good "The private environment already exists: $Venv" "הסביבה הפרטית כבר קיימת: $Venv"
} else {
  $python = Find-Python
  if ($python) {
    Good "Python $($python.Version)  $($python.Path)"
  } else {
    Warn 'Python 3.10 - 3.13 not found.' 'לא נמצא Python בגרסה 3.10 עד 3.13.'
    $pyVer = '3.12.10'
    $pyArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $pyUrl = "https://www.python.org/ftp/python/$pyVer/python-$pyVer-$pyArch.exe"
    $pyArgs = @('/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=0', 'Include_test=0', 'Include_doc=0', 'Shortcuts=0', 'AssociateFiles=0')
    if ($DryRun) {
      Dry "would ask once: Download Python $pyVer from python.org and install it for you only? [Y/n]"
      Dry "$pyUrl $($pyArgs -join ' ')   (no administrator rights; checked: signed by the Python Software Foundation)"
    } elseif (Ask-YesNo "Download Python $pyVer from python.org (about 27 MB) and install it for you only? (no administrator rights needed)" "להוריד את Python $pyVer מ-python.org (בערך 27MB) ולהתקין רק בשבילכם? (לא צריך הרשאות מנהל)") {
      $exe = Join-Path ([IO.Path]::GetTempPath()) "python-$pyVer-$pyArch.exe"
      try { Save-Download $pyUrl $exe "Python $pyVer" }
      catch { Bad "Python could not be downloaded: $($_.Exception.Message)" 'לא הצלחנו להוריד את Python - בדקו את החיבור לאינטרנט ונסו שוב.'; Finish 1 }
      $sig = Get-AuthenticodeSignature -LiteralPath $exe
      if ($sig.Status -ne 'Valid' -or "$($sig.SignerCertificate.Subject)" -notmatch 'Python Software Foundation') {
        Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
        Bad 'The downloaded Python installer is not signed by the Python Software Foundation - it was not run.' 'קובץ ההתקנה של Python שהורד אינו חתום - הוא לא הופעל.'
        Finish 1
      }
      Info "Installing Python $pyVer for this user (about a minute)..." "מתקינים Python $pyVer (בערך דקה)..."
      $p = Start-Process -FilePath $exe -ArgumentList $pyArgs -Wait -PassThru
      Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue
      if ($p.ExitCode -ne 0) { Warn "The Python installer finished with code $($p.ExitCode)." }
      $python = Find-Python
      if ($python) { Good "Python $($python.Version)  $($python.Path)" }
      else { Bad 'Python is still not found. Install Python 3.12 from https://www.python.org/downloads/ and run this again.' 'עדיין לא נמצא Python. התקינו Python 3.12 מ-python.org והפעילו שוב.'; Finish 1 }
    } else {
      Warn 'Skipped. Nothing was changed.' 'דילגנו. שום דבר לא השתנה.'
      Finish 1
    }
  }
}

# ── 3. private environment + faster-whisper ────────────────────────────────
Step 3 'Installing faster-whisper' 'מתקינים את faster-whisper'
if ($target) {
  Info 'Not needed (already set up).' 'לא נדרש (כבר מוגדר).'
} elseif (Test-Whisper $vpy) {
  Good "faster-whisper $(Test-Whisper $vpy) in $Venv"
  $target = $vpy
} elseif ($DryRun) {
  $py = if ($python) { $python.Path } else { 'python' }
  if (-not (Test-File $vpy)) { Dry "`"$py`" -m venv `"$Venv`"" }
  Dry "`"$vpy`" -m pip install --upgrade pip"
  Dry "`"$vpy`" -m pip install --upgrade faster-whisper"
  $target = $vpy
} else {
  if (-not (Test-File $vpy)) {
    Info "Creating $Venv" "יוצרים סביבה פרטית ב-$Venv"
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Venv) | Out-Null
    & $python.Path -m venv $Venv
    if (-not (Test-File $vpy)) { Bad 'Could not create the Python environment (see above).' 'לא הצלחנו ליצור את סביבת הפייתון (פרטים למעלה).'; Finish 1 }
  }
  Info 'Downloading and installing faster-whisper (a few minutes)...' 'מורידים ומתקינים את faster-whisper (כמה דקות)...'
  & $vpy -m pip install --disable-pip-version-check --upgrade pip
  & $vpy -m pip install --disable-pip-version-check --upgrade faster-whisper
  $ver = Test-Whisper $vpy
  if (-not $ver) { Bad 'faster-whisper could not be installed (see the messages above).' 'ההתקנה של faster-whisper נכשלה (פרטים למעלה).'; Finish 1 }
  Good "faster-whisper $ver"
  $target = $vpy
}

# ── 4. speech model ────────────────────────────────────────────────────────
Step 4 "Speech model ($model)" "מודל הדיבור ($model)"
if (Test-ModelCached $model) {
  Good "Already downloaded." 'כבר הורד.'
} elseif ($SkipModel) {
  Info 'Skipped (-SkipModel): it is downloaded on the first transcription.' 'דילגנו: המודל יורד בתמלול הראשון.'
} elseif ($DryRun) {
  Dry "would download the '$model' model once (faster-whisper / Hugging Face)"
} else {
  Info "Downloading the '$model' model once (small = about 500 MB)..." "מורידים פעם אחת את המודל '$model' (small = בערך 500MB)..."
  & $target -c "from faster_whisper import WhisperModel; WhisperModel('$model', device='cpu', compute_type='int8'); print('model ready')"
  if ($LASTEXITCODE -eq 0) { Good 'Model ready.' 'המודל מוכן.' }
  else { Warn 'The model could not be downloaded now - it will be tried again on the first transcription.' 'לא הצלחנו להוריד את המודל עכשיו - ננסה שוב בתמלול הראשון.' }
}

# ── 5. config.json ─────────────────────────────────────────────────────────
Step 5 'Saving the setting (config.json)' 'שומרים את ההגדרה (config.json)'
if (-not $node) {
  Bad 'Node.js 24+ was not found - install Frame Studio first, then run this again.' 'לא נמצא Node.js 24 ומעלה - התקינו קודם את Frame Studio ואז הפעילו שוב.'
  Finish 1
}
$cfgArgs = @()
if ($DryRun) { $cfgArgs += '--dry-run' }
$out = & $node (Join-Path $Root 'tools\config-set.mjs') @cfgArgs "asr.python=$(To-JsonPath $target)" 2>&1
$code = $LASTEXITCODE
foreach ($l in $out) { if ($DryRun) { Dry "$l" } else { Info "$l" } }
if ($code -ne 0) { Bad 'config.json could not be updated (see above).' 'לא הצלחנו לעדכן את config.json.'; Finish 1 }

Line ''
if ($DryRun) { Dry 'done (nothing was changed)' }
else {
  Good 'Local transcription is ready. In the editor: Captions tab -> auto transcribe, or: cutx transcribe <project> <media> --captions' 'התמלול המקומי מוכן. בעורך: לשונית "כתוביות" ← "תמלול אוטומטי", או: cutx transcribe <project> <media> --captions'
  Info 'If Frame Studio is open, it picks the setting up automatically.' 'אם Frame Studio פתוח, הוא קולט את ההגדרה לבד.'
}
Finish 0
