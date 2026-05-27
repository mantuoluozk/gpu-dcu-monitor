@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Please install Node.js 18 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist data mkdir data

echo Starting GPU/DCU resource dashboard...
echo Open http://localhost:3066 in your browser.
echo Press Ctrl+C in this window to stop the dashboard.
echo.

start "" "http://localhost:3066"
npm start
