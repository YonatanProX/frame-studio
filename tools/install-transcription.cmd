@echo off
chcp 65001 >nul
setlocal
title Frame Studio - local transcription

rem Optional: sets up local transcription (Python + faster-whisper) for automatic captions. Run install.cmd first.
rem All the work is done by install-transcription.ps1 (options: -DryRun -Yes -Force -SkipModel -NoPause).

if not exist "%~dp0install-transcription.ps1" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-transcription.ps1" %*
exit /b %errorlevel%

:notextracted
echo.
echo   Please extract the Frame Studio ZIP first, then run tools\install-transcription.cmd from the extracted folder.
echo   קודם צריך לחלץ את קובץ ה-ZIP של Frame Studio, ואז להפעיל את tools\install-transcription.cmd מהתיקייה שחולצה.
echo.
pause
exit /b 1
