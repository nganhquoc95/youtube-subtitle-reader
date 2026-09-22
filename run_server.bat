@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if not errorlevel 1 (
    echo Starting YouTubeTTS server with Python launcher...
    py -3 server.py
    goto :exit
)

where python >nul 2>nul
if not errorlevel 1 (
    echo Starting YouTubeTTS server with Python...
    python server.py
    goto :exit
)

echo Python was not found in PATH. Please install Python 3 and try again.
pause
exit /b 1

:exit
if errorlevel 1 (
    echo Server exited with an error.
    pause
)
