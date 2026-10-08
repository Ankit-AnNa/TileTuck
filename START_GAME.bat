@echo off
title Block Quest - Starting...
cd /d "%~dp0"

echo.
echo  Block Quest v12 - Starting servers...
echo.

:: Check Python
where py >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Python not found. Install Python from python.org first.
    pause
    exit /b 1
)

:: Use venv if available at D:\Game\.venv
if exist "D:\Game\.venv\Scripts\python.exe" (
    set PY=D:\Game\.venv\Scripts\python.exe
) else (
    set PY=py
)

:: Start backend (port 8000)
start "Block Quest Backend" cmd /k "%PY% -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000"

:: Wait a moment for backend to start
timeout /t 2 /nobreak >nul

:: Start frontend (port 5500)
start "Block Quest Frontend" cmd /k "%PY% -m http.server 5500 -d frontend"

:: Wait a moment for frontend to start
timeout /t 2 /nobreak >nul

:: Open browser
start http://localhost:5500

echo.
echo  Game opened in browser: http://localhost:5500
echo  Keep both server windows open while playing.
echo.
pause
