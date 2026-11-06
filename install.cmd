@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Frame Studio - setup

rem Frame Studio setup: double-click this file once after downloading. Safe to run again any time.
rem It checks / installs Node.js, ffmpeg and Google Chrome, saves the settings, creates the desktop shortcut and
rem starts the editor. All the work is done by tools\install.ps1 (options: -DryRun -Yes -NoStart -NoShortcut -NoPause).

if not exist "%~dp0tools\install.ps1" goto notextracted
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install.ps1" %*
exit /b %errorlevel%

:notextracted
echo.
echo   Please extract the ZIP first: right-click it, choose "Extract All...",
echo   then open the extracted folder and double-click install.cmd there.
echo.
echo   קודם צריך לחלץ את קובץ ה-ZIP: לחיצה ימנית עליו, "חלץ הכל...",
echo   ואז לפתוח את התיקייה שחולצה וללחוץ פעמיים על install.cmd שבתוכה.
echo.
pause
exit /b 1
