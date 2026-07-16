@echo off
REM Double-click entry point for Windows. macOS/Linux: run "node run.mjs" instead.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [FAILED] Node.js is not installed, or not on PATH.
  echo          Install the LTS build from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

node run.mjs
if errorlevel 1 pause
