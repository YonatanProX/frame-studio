@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Frame Studio - setup

rem Frame Studio setup from a downloaded ZIP: extract the ZIP, then double-click this file. Safe to run again any time.
rem It installs Frame Studio IN THIS FOLDER: downloads portable Node.js / ffmpeg if the computer has none, creates the
rem Desktop + Start Menu shortcuts, puts cutx on PATH, connects Claude (asks once) and starts the editor.
rem All the work is done by tools\install.ps1 (options: -DryRun -Yes -NoStart -NoShortcut -NoClaude -NoPath -NoPause).
rem The one-line installer in README.md does the same and keeps the program in %LOCALAPPDATA%\Programs\Frame Studio.

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
