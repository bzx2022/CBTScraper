@echo off
e:
cd "E:\My Documents\Default Project\rss-bridge"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "restart-service.ps1"
pause
