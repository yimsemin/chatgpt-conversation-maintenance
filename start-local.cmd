@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later was not found. Install Node.js and try again.
  pause
  exit /b 1
)
node "%SCRIPT_DIR%launcher.js"
if errorlevel 1 pause
