@echo off
rem 대화 정리 앱을 켠다. 이 창이 앱이다: 창을 닫거나 Ctrl+C 를 누르면 앱이 종료된다.
setlocal
set "SCRIPT_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later was not found. Install Node.js and try again.
  pause
  exit /b 1
)
cd /d "%SCRIPT_DIR%"
node "%SCRIPT_DIR%src/launcher.js"
echo.
echo The app has stopped. You can close this window.
pause
