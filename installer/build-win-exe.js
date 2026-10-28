'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const FILES_TO_EMBED = [
  'package.json',
  'run-desktop.bat',
  'electron/main.js',
  'electron/preload.js',
  'electron/webview-shield.js',
  'server/index.js',
  'shared/core-state.js',
  'shared/exporters.js',
  'public/index.html',
  'public/styles.css',
  'public/app.js'
];

function toCByteArray(buf) {
  const bytes = [];
  for (let i = 0; i < buf.length; i++) {
    bytes.push(`0x${buf[i].toString(16).padStart(2, '0')}`);
  }
  return bytes.join(', ');
}

function buildInstaller() {
  let headerLines = [
    '// Auto-generated embedded payload for Browz-Setup-1.0.0.exe',
    '#pragma once',
    '#include <stddef.h>',
    '#include <stdint.h>',
    '',
    'typedef struct {',
    '  const char* rel_path;',
    '  const uint8_t* data;',
    '  size_t size;',
    '} EmbeddedFile;',
    ''
  ];

  const tableEntries = [];

  FILES_TO_EMBED.forEach((rel, idx) => {
    const abs = path.join(ROOT, rel);
    const content = fs.readFileSync(abs);
    const varName = `file_data_${idx}`;
    headerLines.push(`static const uint8_t ${varName}[] = { ${toCByteArray(content)} };`);
    const winRel = rel.replace(/\//g, '\\\\');
    tableEntries.push(`  { "${winRel}", ${varName}, ${content.length} }`);
  });

  headerLines.push('');
  headerLines.push(`static const EmbeddedFile EMBEDDED_FILES[] = {`);
  headerLines.push(tableEntries.join(',\n'));
  headerLines.push('};');
  headerLines.push(`static const size_t EMBEDDED_FILE_COUNT = ${FILES_TO_EMBED.length};`);

  const headerPath = '/tmp/browz_payload.h';
  fs.writeFileSync(headerPath, headerLines.join('\n'), 'utf8');

  const cSource = `
#include <windows.h>
#include <shlobj.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "browz_payload.h"

static void ensure_dir(const char* dir_path) {
  CreateDirectoryA(dir_path, NULL);
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nCmdShow) {
  (void)hInstance; (void)hPrevInstance; (void)lpCmdLine; (void)nCmdShow;

  int resp = MessageBoxA(
    NULL,
    "Welcome to Browz Standalone Desktop Browser v1.0.0 Setup!\\n\\n"
    "This installer sets up Browz as a 100% SEPARATE Desktop Application (never uses Edge or Chrome):\\n"
    "  - Isolated Native Chromium Engine + Anti-Fingerprinting Shield\\n"
    "  - WebRTC IP Leak Prevention & Zero Google Telemetry\\n"
    "  - Multi-Tab Isolated Container Sessions (RAM-only Burner Tabs)\\n"
    "  - 100% CDP Network Request/Response Capture & Export (.HAR, k6, JMeter)\\n\\n"
    "Click YES to install Browz to %LOCALAPPDATA%\\\\Browz and launch the standalone desktop application.",
    "Browz Standalone Browser v1.0.0 Installer",
    MB_YESNO | MB_ICONINFORMATION
  );

  if (resp != IDYES) {
    return 0;
  }

  char localAppData[MAX_PATH];
  DWORD envLen = GetEnvironmentVariableA("LOCALAPPDATA", localAppData, MAX_PATH);
  if (envLen == 0 || envLen >= MAX_PATH) {
    strcpy(localAppData, "C:\\\\Browz");
  }

  char installRoot[MAX_PATH];
  snprintf(installRoot, MAX_PATH, "%s\\\\Browz", localAppData);
  ensure_dir(installRoot);

  const char* subdirs[] = { "electron", "server", "shared", "public" };
  for (int i = 0; i < 4; i++) {
    char subPath[MAX_PATH];
    snprintf(subPath, MAX_PATH, "%s\\\\%s", installRoot, subdirs[i]);
    ensure_dir(subPath);
  }

  for (size_t i = 0; i < EMBEDDED_FILE_COUNT; i++) {
    char fullPath[MAX_PATH];
    snprintf(fullPath, MAX_PATH, "%s\\\\%s", installRoot, EMBEDDED_FILES[i].rel_path);
    FILE* fp = fopen(fullPath, "wb");
    if (fp) {
      fwrite(EMBEDDED_FILES[i].data, 1, EMBEDDED_FILES[i].size, fp);
      fclose(fp);
    }
  }

  // Write Standalone Native Electron Desktop Launcher (NEVER opens Edge or system browsers)
  char launcherPath[MAX_PATH];
  snprintf(launcherPath, MAX_PATH, "%s\\\\Launch-Browz.bat", installRoot);
  FILE* lfp = fopen(launcherPath, "wb");
  if (lfp) {
    const char* script =
      "@echo off\\r\\n"
      "title Browz Standalone Desktop Browser\\r\\n"
      "cd /d \\"%~dp0\\"\\r\\n"
      "if exist \\"node_modules\\\\electron\\\\dist\\\\electron.exe\\" (\\r\\n"
      "  start \\"\\" \\"node_modules\\\\electron\\\\dist\\\\electron.exe\\" .\\r\\n"
      "  exit /b 0\\r\\n"
      ")\\r\\n"
      "echo ====================================================================\\r\\n"
      "echo   Browz First-Time Setup: Downloading Standalone Chromium Engine...\\r\\n"
      "echo   (This runs only once so Browz never uses Edge or system browsers)\\r\\n"
      "echo ====================================================================\\r\\n"
      "where node >nul 2>nul\\r\\n"
      "if %ERRORLEVEL% NEQ 0 (\\r\\n"
      "  echo Installing Node.js runtime via winget...\\r\\n"
      "  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements\\r\\n"
      "  set \\"PATH=%PATH%;C:\\\\Program Files\\\\nodejs\\"\\r\\n"
      ")\\r\\n"
      "call npm install --no-audit --no-fund electron@33.2.0\\r\\n"
      "if exist \\"node_modules\\\\electron\\\\dist\\\\electron.exe\\" (\\r\\n"
      "  start \\"\\" \\"node_modules\\\\electron\\\\dist\\\\electron.exe\\" .\\r\\n"
      "  exit /b 0\\r\\n"
      ")\\r\\n"
      "pause\\r\\n";
    fwrite(script, 1, strlen(script), lfp);
    fclose(lfp);
  }

  // Create Desktop Shortcut via PowerShell WScript.Shell
  char psCmd[1024];
  snprintf(
    psCmd,
    sizeof(psCmd),
    "powershell -NoProfile -WindowStyle Hidden -Command \\"$s=(New-Object -COM WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\\\Browz Browser.lnk');$s.TargetPath='%s\\\\Launch-Browz.bat';$s.WorkingDirectory='%s';$s.Description='Browz Standalone Untraceable Browser';$s.Save()\\"",
    installRoot,
    installRoot
  );
  WinExec(psCmd, SW_HIDE);

  MessageBoxA(
    NULL,
    "Browz Standalone Browser files installed to %LOCALAPPDATA%\\\\Browz!\\n\\n"
    "Click OK to launch the standalone Browz application (on first launch, it will fetch its own isolated Chromium engine so it NEVER uses Microsoft Edge).",
    "Browz Standalone Setup",
    MB_OK | MB_ICONINFORMATION
  );

  ShellExecuteA(NULL, "open", launcherPath, NULL, installRoot, SW_SHOWNORMAL);
  return 0;
}
`;

  const cPath = '/tmp/win_installer.c';
  fs.writeFileSync(cPath, cSource, 'utf8');

  const outExe = path.join(ROOT, 'Browz-Setup-1.0.0.exe');
  execFileSync(
    '/tmp/zig-venv/bin/python',
    [
      '-m',
      'ziglang',
      'cc',
      '-target',
      'x86_64-windows-gnu',
      '-O2',
      '-Wl,--subsystem,windows',
      '-I/tmp',
      cPath,
      '-luser32',
      '-lshell32',
      '-o',
      outExe
    ],
    { stdio: 'inherit' }
  );

  const stat = fs.statSync(outExe);
  console.log(`Built ${outExe} (${(stat.size / 1024).toFixed(1)} KB)`);
}

buildInstaller();
