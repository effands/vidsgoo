@echo off
title Google Vids Generator Server Control
color 0A
cd /d "e:\AUTO KLIK\Vids Goo"

echo ===================================================
echo   Google Vids Generator Web Server (Port 7890)
echo ===================================================
echo.

:: Tutup otomatis proses lama jika port 7890 masih dipakai
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7890 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo [STATUS] Membuka Web Dashboard di browser...
start http://127.0.0.1:7890

echo.
echo [PENTING] Jendela CMD ini adalah penopang server.
echo Jika jendela ini ditutup (X), server akan OTOMATIS MATI.
echo ===================================================
echo.
node server.js
pause

