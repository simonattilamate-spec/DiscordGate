@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Telepitsd a Node.js 24 LTS verziot: https://nodejs.org/
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Toltsd ki a megnyilo .env fajlt, mentsd el, majd inditsd ujra ezt a fajlt.
  notepad .env
  exit /b 0
)
if not exist node_modules\@fluxerjs\core (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
pause
