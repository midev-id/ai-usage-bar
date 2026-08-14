@echo off
setlocal
set "APP_DIR=%~dp0..\dist"
set "APP_EXE=%APP_DIR%\CodexBar-0.48.0-portable.exe"

if not exist "%APP_EXE%" (
  echo CodexBar executable not found:
  echo %APP_EXE%
  exit /b 1
)

start "CodexBar" "%APP_EXE%"
endlocal
