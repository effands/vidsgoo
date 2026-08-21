@echo off
chcp 65001 >nul
title VIDS GOO - Multi-Chrome Studio Server
color 0B
cd /d "%~dp0"
cls

echo.
echo   ██╗   ██╗██╗██████╗ ███████╗     ██████╗  ██████╗  ██████╗ 
echo   ██║   ██║██║██╔══██╗██╔════╝    ██╔════╝ ██╔═══██╗██╔═══██╗
echo   ██║   ██║██║██║  ██║███████╗    ██║  ███╗██║   ██║██║   ██║
echo   ╚██╗ ██╔╝██║██║  ██║╚════██║    ██║   ██║██║   ██║██║   ██║
echo    ╚████╔╝ ██║██████╔╝███████║    ╚██████╔╝╚██████╔╝╚██████╔╝
echo     ╚═══╝  ╚═╝╚═════╝ ╚══════╝     ╚═════╝  ╚═════╝  ╚═════╝ 
echo.
echo   ===========================================================
echo      GOOGLE VIDS AUTOMATION STUDIO - MULTI-CHROME FLEET
echo   ===========================================================
echo.

:: Tutup otomatis proses lama jika port 7890 masih dipakai
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :7890 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>&1

echo   [+] Status   : Membuka Web Dashboard di browser...
start http://127.0.0.1:7890

echo   [+] Local UI : http://127.0.0.1:7890
echo   [!] Penting  : Jendela ini adalah penopang server aktif.
echo                  Jangan tutup jendela ini saat otomatisasi berjalan.
echo   ===========================================================
echo.
node server.js
pause
