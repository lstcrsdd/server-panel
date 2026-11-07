@echo off
rem Method Network Panel for Windows.
rem   start-windows.bat              - run the panel and open it in the browser
rem   start-windows.bat autostart    - start the panel at Windows logon
rem   start-windows.bat noautostart  - remove it from logon
rem Any other arguments go to server-panel.exe, e.g. -listen 127.0.0.1:7781
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Method Network Panel

set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Method Network Panel.lnk"

if /i "%~1"=="noautostart" (
  if exist "%LNK%" del "%LNK%"
  echo Автозапуск выключен.
  pause
  exit /b 0
)

where ssh >nul 2>nul
if errorlevel 1 (
  echo Не найден ssh.exe — нужен клиент OpenSSH.
  echo Параметры ^> Система ^> Дополнительные компоненты ^> Клиент OpenSSH,
  echo или в PowerShell от имени администратора:
  echo   Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0
  pause
  exit /b 1
)

rem Go is installed: rebuild so the exe matches the sources after git pull.
where go >nul 2>nul
if not errorlevel 1 (
  echo Сборка...
  go build -trimpath -o server-panel.exe . || goto buildfail
)
if not exist server-panel.exe (
  echo Не найден server-panel.exe.
  echo Скачайте server-panel-windows-amd64.exe со страницы Releases,
  echo переименуйте в server-panel.exe и положите рядом с этим файлом,
  echo или установите Go: https://go.dev/dl/
  pause
  exit /b 1
)

if /i "%~1"=="autostart" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LNK); $s.TargetPath = (Join-Path (Get-Location) 'server-panel.exe'); $s.Arguments = '-no-open'; $s.WorkingDirectory = (Get-Location).Path; $s.WindowStyle = 7; $s.Description = 'Method Network Panel'; $s.Save()"
  if errorlevel 1 goto lnkfail
  echo Автозапуск включён: панель будет стартовать свёрнутой при входе в Windows.
  echo Выключить: start-windows.bat noautostart
  start "" server-panel.exe
  exit /b 0
)

server-panel.exe %*
if errorlevel 1 pause
exit /b

:buildfail
echo Не удалось собрать панель.
pause
exit /b 1

:lnkfail
echo Не удалось создать ярлык автозапуска.
pause
exit /b 1
