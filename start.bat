@echo off
title StreamDash
color 0A
chcp 65001 >nul 2>&1

echo.
echo  ==========================================
echo   StreamDash  ^|  v3.0  ^|  by Ahmed
echo  ==========================================
echo.

:: ── Check Node.js ──────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js not installed.
    echo  Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% detected
echo.

:: ── Install dependencies if missing ────────────────────────────────
if not exist "%~dp0node_modules" (
    echo  [INFO] First run - installing dependencies...
    echo  Please wait, this only happens once.
    echo.
    cd /d "%~dp0"
    call npm install
    if %errorlevel% neq 0 (
        echo.
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo.
    echo  [OK] Dependencies installed successfully.
    echo.
)

:: ── Launch dashboard ────────────────────────────────────────────────
echo  [OK] Starting StreamDash server...
echo  [OK] Browser will open automatically.
echo.
echo  ──────────────────────────────────────────
echo   Dashboard: http://localhost:5000
echo   Press Ctrl+C to stop the server
echo  ──────────────────────────────────────────
echo.

cd /d "%~dp0"
node web/server.js
