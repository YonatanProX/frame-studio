@echo off
setlocal
rem Frame Studio CLI for cmd / PowerShell (Git Bash: use ./cutx). Uses the installer's portable Node.js when present.
set "FS_NODE=node"
if exist "%~dp0runtime\node\node.exe" set "FS_NODE=%~dp0runtime\node\node.exe"
"%FS_NODE%" "%~dp0cli\cutx.mjs" %*
exit /b %errorlevel%
