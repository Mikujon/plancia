@echo off
rem Starts Plancia in production mode (one stable process) and opens http://localhost:5173.
rem Close this window to stop it.
title Plancia
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call pnpm install || goto :fail
)
echo Building the interface...
call pnpm build || goto :fail
set API_PORT=5173
echo.
echo Plancia is starting on http://localhost:5173  - keep this window open, close it to stop.
start "" cmd /c "timeout /t 5 >nul & start http://localhost:5173"
call pnpm start
goto :eof

:fail
echo.
echo Something went wrong. Check that Node 24+ and pnpm are installed (npm install -g pnpm).
pause
