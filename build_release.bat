@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" (
    set "PYTHON_BIN=.venv\Scripts\python.exe"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python was not found. Install Python 3 and try again.
        pause
        exit /b 1
    )
    set "PYTHON_BIN=python"
)

"%PYTHON_BIN%" -m PyInstaller --version >nul 2>nul
if errorlevel 1 (
    echo PyInstaller is not installed in the selected Python environment.
    echo Install it with: %PYTHON_BIN% -m pip install pyinstaller
    pause
    exit /b 1
)

if exist "dist" rmdir /s /q "dist"
if exist "build" rmdir /s /q "build"

"%PYTHON_BIN%" -m PyInstaller --clean --noconfirm launcher.spec
if errorlevel 1 goto :failed

"%PYTHON_BIN%" -m PyInstaller --clean --noconfirm server.spec
if errorlevel 1 goto :failed

echo.
echo Build completed:
echo   dist\launcher.exe
echo   dist\server.exe
exit /b 0

:failed
echo.
echo Build failed.
pause
exit /b 1
