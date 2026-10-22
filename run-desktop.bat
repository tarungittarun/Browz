@echo off
title Browz Desktop Browser Launcher
echo ===================================================
echo   Browz — Performance Capture & Control Browser
echo ===================================================
if not exist "node_modules" (
  echo [1/2] Installing dependencies...
  call npm install
)
if not exist "node_modules\electron" (
  echo [2/2] Installing Electron Desktop Engine...
  call npm install --save-dev electron
)
echo Launching Browz Desktop Browser...
call npx electron .
