# Frame Studio: creates a shortcut "Frame Studio.lnk" -> start.cmd, with the icon app\icon.ico (tools\install.ps1 makes
# the Desktop + Start Menu shortcuts itself; this script is for making one by hand, e.g. in another folder).
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\make-shortcut.ps1 [-Desktop <folder>] [-Node <node.exe>] [-Name <name>]
# -Desktop defaults to the user's real desktop folder (also when Windows / OneDrive moved it). -Node is only used to
# generate the icon when app\icon.ico is missing. Running it again just refreshes the shortcut.
# This file is ASCII on purpose (Windows PowerShell 5.1 reads BOM-less scripts as ANSI); Hebrew text is built from code points.
param(
  [string]$Desktop = [Environment]::GetFolderPath('Desktop'),
  [string]$Node = '',
  [string]$Name = 'Frame Studio'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'start.cmd'
$icon = Join-Path $root 'app\icon.ico'
if (-not $Node) {
  $Node = Join-Path $root 'runtime\node\node.exe'
  if (-not (Test-Path -LiteralPath $Node)) { $Node = 'node' }
}

if (-not $Desktop) { $Desktop = Join-Path $env:USERPROFILE 'Desktop' }
if (-not (Test-Path -LiteralPath $target)) { throw "start.cmd not found: $target" }
if (-not (Test-Path -LiteralPath $icon)) {
  & $Node (Join-Path $root 'tools\make-icon.mjs') $icon
  if (-not (Test-Path -LiteralPath $icon)) { throw "icon could not be generated: $icon" }
}
if (-not (Test-Path -LiteralPath $Desktop)) { New-Item -ItemType Directory -Force -Path $Desktop | Out-Null }

# "Frame Studio - <Hebrew: video editor that Claude edits live>"
$he = -join ([char[]](
  0x05E2,0x05D5,0x05E8,0x05DA,0x0020,0x05D5,0x05D9,0x05D3,0x05D0,0x05D5,0x0020,  # video editor
  0x05E9,0x05E7,0x05DC,0x05D5,0x05D3,0x0020,                                        # that Claude
  0x05E2,0x05D5,0x05E8,0x05DA,0x0020,0x05D1,0x05E9,0x05D9,0x05D3,0x05D5,0x05E8,0x0020,0x05D7,0x05D9  # edits live
))

$lnkPath = Join-Path $Desktop "$Name.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $target
$lnk.WorkingDirectory = $root
$lnk.IconLocation = "$icon,0"
$lnk.WindowStyle = 7          # minimized: the helper console stays out of the way (start.cmd shows errors in a message box)
$lnk.Description = "Frame Studio - $he"
$lnk.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null

Write-Output "OK: $lnkPath"
