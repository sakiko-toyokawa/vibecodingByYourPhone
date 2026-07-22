#Requires -Version 5.1
<#
.SYNOPSIS
    Capture Android logs for Yep Anywhere mobile app debugging.
.DESCRIPTION
    Checks adb connection, clears old logs, and starts logcat filtering
    for notification-related, Tauri, Rust, and WebView output.
#>

$ErrorActionPreference = "Stop"

Write-Host "=== Yep Anywhere Log Capture ===" -ForegroundColor Cyan

# Check adb
$adb = Get-Command adb -ErrorAction SilentlyContinue
if (-not $adb) {
    # Try common Android SDK paths
    $sdkPaths = @(
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe",
        "$env:PROGRAMFILES\Android\Sdk\platform-tools\adb.exe",
        "$env:PROGRAMFILES(x86)\Android\Sdk\platform-tools\adb.exe"
    )
    foreach ($path in $sdkPaths) {
        if (Test-Path $path) {
            $adb = $path
            break
        }
    }
    if (-not $adb) {
        Write-Host "ERROR: adb not found. Please install Android SDK platform-tools." -ForegroundColor Red
        exit 1
    }
}
Write-Host "Using adb: $adb" -ForegroundColor Gray

# Check device
Write-Host "`nChecking connected devices..." -ForegroundColor Yellow
& $adb devices

$deviceList = & $adb devices | Select-String "device$"
if ($deviceList.Count -eq 0) {
    Write-Host "`nERROR: No Android device found." -ForegroundColor Red
    Write-Host "Please check:" -ForegroundColor Yellow
    Write-Host "  1. USB cable is connected and supports data transfer"
    Write-Host "  2. USB debugging is enabled on the phone"
    Write-Host "  3. You tapped 'Allow' on the phone's debug authorization dialog"
    exit 1
}

# Show app info
Write-Host "`nChecking if Yep Anywhere is running..." -ForegroundColor Yellow
$processes = & $adb shell ps | Select-String "yepanywhere"
if ($processes) {
    Write-Host "App is running:" -ForegroundColor Green
    $processes | ForEach-Object { Write-Host "  $_" }
} else {
    Write-Host "App not running. Please open Yep Anywhere first." -ForegroundColor Red
    exit 1
}

# Clear old logs
Write-Host "`nClearing old logs..." -ForegroundColor Yellow
& $adb logcat -c

Write-Host "`n=== Starting log capture ===" -ForegroundColor Green
Write-Host "Filters: notification, Tauri, Rust, WebView, chromium" -ForegroundColor Gray
Write-Host "Press Ctrl+C to stop.`n" -ForegroundColor Gray

# Start logcat with filters
# -v threadtime: show thread and timestamp
# -s: suppress 'beginning of' messages
# Tags we care about:
#   RustStdoutStderr - Rust println! / eprintln!
#   Tauri            - Tauri framework logs
#   WebView          - WebView messages
#   chromium         - Chrome/V8 console.log
#   NotificationService - Android notification system
#   NotificationManager - Android notification manager
& $adb logcat -v threadtime -s `
    RustStdoutStderr:D `
    Tauri:D `
    WebView:D `
    chromium:D `
    NotificationService:D `
    NotificationManager:D `
    System.out:D `
    ActivityManager:D `
    AndroidRuntime:E
