@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Frame Studio

rem Frame Studio: starts the local server (if it is not running yet) and opens the editor window.
rem The desktop shortcut runs this file. First-time setup (Node.js, ffmpeg, Chrome, shortcut): install.cmd
rem FRAME_STUDIO_NO_BROWSER=1 starts only the server. FRAME_STUDIO_NO_ALERT=1 shows errors only in this window.

rem ---- Node.js: PATH first, then the usual install folders (right after an install it may not be on PATH yet)
set "NODE="
where node >nul 2>nul && set "NODE=node"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LocalAppData%\Microsoft\WinGet\Links\node.exe" set "NODE=%LocalAppData%\Microsoft\WinGet\Links\node.exe"
if not defined NODE if exist "%ProgramFiles%\WinGet\Links\node.exe" set "NODE=%ProgramFiles%\WinGet\Links\node.exe"
if not defined NODE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE goto nonode
if not "%NODE%"=="node" for %%D in ("%NODE%") do set "PATH=%%~dpD;%PATH%"

node -e "fetch('http://127.0.0.1:7788/api/health',{signal:AbortSignal.timeout(1500)}).then(r=>r.json()).then(j=>process.exit(j&&j.app==='frame-studio'?0:2)).catch(()=>process.exit(1))"
if errorlevel 2 goto busy
if errorlevel 1 goto startserver
goto browser

:startserver
rem Node.js 24+, ffmpeg and ffprobe, found the same way the server finds them
node "%~dp0tools\check-setup.mjs" --problems-only
if errorlevel 1 goto missing
start "Frame Studio - server" /min node "%~dp0server\main.mjs"
node -e "const t0=Date.now();const f=()=>fetch('http://127.0.0.1:7788/api/health',{signal:AbortSignal.timeout(1000)}).then(r=>r.json()).then(j=>process.exit(j&&j.app==='frame-studio'?0:2)).catch(()=>{if(Date.now()-t0>20000)process.exit(1);setTimeout(f,300)});f()"
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
echo     Double-click install.cmd in the Frame Studio folder to install what is missing.
echo [Frame Studio] %FS_HE%
echo     לחצו פעמיים על install.cmd בתיקיית Frame Studio כדי להתקין את מה שחסר.
echo     %~dp0install.cmd
echo.
set "FS_MSG=%FS_EN%\nDouble-click install.cmd in the Frame Studio folder to install what is missing.\n\n%FS_HE%\nלחצו פעמיים על install.cmd בתיקיית Frame Studio כדי להתקין את מה שחסר.\n\n%~dp0install.cmd"
call :alert
pause
exit /b 1

:busy
echo [Frame Studio] Port 7788 is used by another program. Close it and try again.
echo [Frame Studio] הפורט 7788 תפוס על ידי תוכנה אחרת. סגרו אותה ונסו שוב.
set "FS_MSG=Port 7788 is used by another program. Close it and try again.\n\nהפורט 7788 תפוס על ידי תוכנה אחרת. סגרו אותה ונסו שוב."
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
rem same browser detection as the server: env FRAME_STUDIO_CHROME, then "chrome" in config.json, then auto-detect
set "CHROME="
for /f "usebackq delims=" %%C in (`node "%~dp0tools\find-chrome.mjs"`) do set "CHROME=%%C"
if defined CHROME if exist "%CHROME%" goto chrome
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" goto chrome
start "" "http://127.0.0.1:7788/"
exit /b 0

:chrome
start "" "%CHROME%" --app=http://127.0.0.1:7788/ --new-window --window-size=1600,950
exit /b 0

rem ---- message box, because the shortcut starts this window minimized (text in FS_MSG, "\n" = new line)
:alert
if "%FRAME_STUDIO_NO_ALERT%"=="1" exit /b 0
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }; [void][System.Windows.Forms.MessageBox]::Show($f, $env:FS_MSG.Replace('\n', [Environment]::NewLine), 'Frame Studio', 'OK', 'Warning'); $f.Dispose()" >nul 2>nul
exit /b 0
