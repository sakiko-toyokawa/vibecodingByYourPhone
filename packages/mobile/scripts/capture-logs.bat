@echo off
chcp 65001 >nul
echo === Yep Anywhere Log Capture ===

REM Check adb
where adb >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: adb not found in PATH.
    echo Please add Android SDK platform-tools to your PATH.
    echo Common location: %%LOCALAPPDATA%%\Android\Sdk\platform-tools
    exit /b 1
)

echo.
echo Checking connected devices...
adb devices

echo.
adb shell ps | findstr "yepanywhere" >nul
if %errorlevel% neq 0 (
    echo App not running. Please open Yep Anywhere first.
    exit /b 1
)
echo App is running.

echo.
echo Clearing old logs...
adb logcat -c

echo.
echo === Starting log capture ===
echo Press Ctrl+C to stop.
echo.

adb logcat -v threadtime -s RustStdoutStderr:D Tauri:D WebView:D chromium:D NotificationService:D NotificationManager:D System.out:D ActivityManager:D AndroidRuntime:E
