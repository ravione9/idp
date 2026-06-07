@echo off
:: Lenskart IdP — Device context agent
:: Drop this file into your Windows Startup folder to auto-start at login.
:: Startup folder:  %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
::
:: The agent runs silently in background on http://127.0.0.1:17891/device-context
:: It tells the IdP login page: hostname, local IP.
::
:: No admin rights required. Requires Node.js 18+ on PATH.

set SCRIPT=%~dp0device-context-agent.mjs
if not exist "%SCRIPT%" (
  echo [IdP Agent] Cannot find device-context-agent.mjs next to this bat file.
  pause
  exit /b 1
)

start /B /MIN node "%SCRIPT%"
