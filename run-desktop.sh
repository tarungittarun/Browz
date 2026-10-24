#!/usr/bin/env bash
set -e
echo "==================================================="
echo "  Browz — Performance Capture & Control Browser"
echo "==================================================="
if [ ! -d "node_modules" ]; then
  echo "[1/2] Installing dependencies..."
  npm install
fi
if [ ! -d "node_modules/electron" ]; then
  echo "[2/2] Installing Electron Desktop Engine..."
  npm install --save-dev electron
fi
echo "Launching Browz Desktop Browser..."
npx electron .
