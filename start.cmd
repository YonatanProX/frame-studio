@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Frame Studio

rem Frame Studio: starts the local server (if it is not running yet) and opens the editor window.
rem The Desktop / Start Menu shortcut runs this file. Setup and repair: the installer (see README) or install.cmd.
rem FRAME_STUDIO_NO_BROWSER=1 starts only the server. FRAME_STUDIO_NO_ALERT=1 shows errors only in this window.
rem FRAME_STUDIO_PORT=<port> uses another port (default 7788).

if not defined FRAME_STUDIO_PORT set "FRAME_STUDIO_PORT=7788"
set "FS_URL=http://127.0.0.1:%FRAME_STUDIO_PORT%"

rem ---- Node.js: the portable copy from the installer first, then PATH, then the usual install folders
set "NODE="
if exist "%~dp0runtime\node\node.exe" set "NODE=%~dp0runtime\node\node.exe"
if not defined NODE where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Microsoft\WinGet\Links\node.exe" set "NODE=%LocalAppData%\Microsoft\WinGet\Links\node.exe"
if not defined NODE if exist "%ProgramFiles%\WinGet\Links\node.exe" set "NODE=%ProgramFiles%\WinGet\Links\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE goto nonode
if not "%NODE%"=="node" for %%D in ("%NODE%") do set "PATH=%%~dpD;%PATH%"
rem the portable ffmpeg too (config.json normally names it already; this also covers a moved folder)
if exist "%~dp0runtime\ffmpeg\bin\ffmpeg.exe" set "PATH=%~dp0runtime\ffmpeg\bin;%PATH%"

node -e "fetch(process.env.FS_URL+'/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(j=>process.exit(j&&j.app==='frame-studio'?0:2)).catch(()=>process.exit(1))"
if errorlevel 2 goto busy
if errorlevel 1 goto startserver
goto browser

:startserver
rem Node.js 24+, ffmpeg, ffprobe and a browser, found the same way the server finds them
node "%~dp0tools\check-setup.mjs" --problems-only
if errorlevel 1 goto missing
start "Frame Studio - server" /min node "%~dp0server\main.mjs" --port %FRAME_STUDIO_PORT%
node -e "const t0=Date.now();const f=()=>fetch(process.env.FS_URL+'/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(j=>process.exit(j&&j.app==='frame-studio'?0:2)).catch(()=>{if(Date.now()-t0>20000)process.exit(1);setTimeout(f,300)});f()"
if errorlevel 2 goto busy
if errorlevel 1 goto failed
goto browser

:nonode
set "FS_EN=Node.js 24 or newer was not found on this computer."
set "FS_HE=לא נמצא במחשב Node.js בגרסה 24 ומעלה."
goto needinstall

:missing
set "FS_EN=Something Frame Studio needs is missing - see the list in this window."
set "FS_HE=חסר רכיב ש-Frame Studio צריך - הרשימה בחלון הזה."
goto needinstall

:needinstall
echo.
echo [Frame Studio] %FS_EN%
echo     Run the Frame Studio installer again to repair it (install.cmd in this folder does the same).
echo [Frame Studio] %FS_HE%
echo     הפעילו שוב את ההתקנה של Frame Studio כדי לתקן (גם install.cmd בתיקייה הזו עושה את זה).
echo     %~dp0install.cmd
echo.
set "FS_MSG=%FS_EN%\nRun the Frame Studio installer again to repair it (install.cmd in the Frame Studio folder does the same).\n\n%FS_HE%\nהפעילו שוב את ההתקנה של Frame Studio כדי לתקן (גם install.cmd בתיקיית התוכנה עושה את זה).\n\n%~dp0install.cmd"
call :alert
pause
exit /b 1

:busy
echo [Frame Studio] Port %FRAME_STUDIO_PORT% is used by another program. Close it and try again.
echo [Frame Studio] הפורט %FRAME_STUDIO_PORT% תפוס על ידי תוכנה אחרת. סגרו אותה ונסו שוב.
set "FS_MSG=Port %FRAME_STUDIO_PORT% is used by another program. Close it and try again.\n\nהפורט %FRAME_STUDIO_PORT% תפוס על ידי תוכנה אחרת. סגרו אותה ונסו שוב."
call :alert
pause
exit /b 1

:failed
echo [Frame Studio] The server did not start. Details are in server.log in the Frame Studio folder.
echo [Frame Studio] השרת לא עלה. הפרטים בקובץ server.log בתיקיית התוכנה.
set "FS_MSG=The server did not start. Details are in server.log in the Frame Studio folder.\n\nהשרת לא עלה. הפרטים בקובץ server.log בתיקיית התוכנה.\n\n%~dp0server.log"
call :alert
pause
exit /b 1

:browser
if "%FRAME_STUDIO_NO_BROWSER%"=="1" exit /b 0
rem same browser detection as the server: env FRAME_STUDIO_CHROME, then "chrome" in config.json, then Chrome / Edge
set "CHROME="
for /f "usebackq delims=" %%C in (`node "%~dp0tools\find-chrome.mjs"`) do set "CHROME=%%C"
if defined CHROME if exist "%CHROME%" goto chrome
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if exist "%CHROME%" goto chrome
start "" "%FS_URL%/"
exit /b 0

:chrome
rem (a parent app's compatibility layer makes Edge quit at once - do not pass it on)
set "__COMPAT_LAYER="
start "" "%CHROME%" --app=%FS_URL%/ --new-window --window-size=1600,950
exit /b 0

rem ---- message box, because the shortcut starts this window minimized (text in FS_MSG, "\n" = new line)
:alert
if "%FRAME_STUDIO_NO_ALERT%"=="1" exit /b 0
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }; [void][System.Windows.Forms.MessageBox]::Show($f, $env:FS_MSG.Replace('\n', [Environment]::NewLine), 'Frame Studio', 'OK', 'Warning'); $f.Dispose()" >nul 2>nul
exit /b 0
