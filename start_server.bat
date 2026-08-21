@echo off
title VIDS GOO - Multi-Chrome Studio Server
color 0B
cd /d "%~dp0"
cls

:: Tutup otomatis proses lama jika port 7890 masih dipakai
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7890 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

start http://127.0.0.1:7890

node server.js
pause
