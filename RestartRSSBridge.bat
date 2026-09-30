@echo off
cd /d "%~dp0rss-bridge"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0rss-bridge\restart-service.ps1"
pause
