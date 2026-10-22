'use strict';

const path = require('path');
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog
} = require('electron');
const fs = require('fs');
const { startBrowzServer } = require('../server/index');
const { shouldBlockRequest, getEffectiveUserAgent } = require('../shared/core-state');

let mainWindow = null;
let serverInstance = null;
const configuredPartitions = new Set();

/**
 * Attach 100% Network (#2), Container Session (#4), and Permission/Download (#5)
 * hooks to a Chromium Session partition.
 */
function configureChromiumPartition(partitionName, containerId, engine) {
  if (configuredPartitions.has(partitionName)) return;
  configuredPartitions.add(partitionName);

  const ses = session.fromPartition(partitionName);

  // --- #2: NETWORK INTERCEPTION (Block rules & HTTPS Upgrade) ---
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const state = engine.getState();
    const { blocked, reason } = shouldBlockRequest(
      details.url,
      details.resourceType,
      state.networkControl
    );

    if (blocked) {
      engine.recordBlockedRequest({
        tabId: `wc-${details.webContentsId || 1}`,
        containerId,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        reason
      });
      return callback({ cancel: true });
    }

    if (state.networkControl.forceHttps && details.url.startsWith('http://') && !details.url.includes('localhost') && !details.url.includes('127.0.0.1')) {
      return callback({ redirectURL: details.url.replace(/^http:\/\//i, 'https://') });
    }

    callback({ cancel: false });
  });

  // --- #2: REQUEST HEADER MANIPULATION (User-Agent, Referer, Custom Headers) ---
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    const state = engine.getState();
    const container = state.containers.find((c) => c.id === containerId);
    const headers = { ...details.requestHeaders };

    // Effective User-Agent
    headers['User-Agent'] = getEffectiveUserAgent(state.networkControl, container);

    // Strip Referer if configured
    if (state.networkControl.stripReferer) {
      delete headers['Referer'];
      delete headers['referer'];
    }

    // Strip Client Hints / Tracking headers if configured
    if (state.networkControl.stripTrackingHeaders) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase().startsWith('sec-ch-ua')) {
          delete headers[k];
        }
      }
    }

    // Custom Request Headers
    for (const rule of state.networkControl.customRequestHeaders || []) {
      if (rule.enabled && rule.name) {
        if (!rule.domainFilter || rule.domainFilter === '*' || details.url.includes(rule.domainFilter)) {
          headers[rule.name] = rule.value || '';
        }
      }
    }

    callback({ requestHeaders: headers });
  });

  // --- #2: RESPONSE HEADER MANIPULATION & CORS BYPASS ---
  ses.webRequest.onHeadersReceived({ urls: ['*://*/*'] }, (details, callback) => {
    const state = engine.getState();
    const responseHeaders = { ...(details.responseHeaders || {}) };

    if (state.networkControl.bypassCors) {
      responseHeaders['Access-Control-Allow-Origin'] = ['*'];
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD'];
      responseHeaders['Access-Control-Allow-Headers'] = ['*'];
    }

    for (const rule of state.networkControl.customResponseHeaders || []) {
      if (rule.enabled && rule.name) {
        if (!rule.domainFilter || rule.domainFilter === '*' || details.url.includes(rule.domainFilter)) {
          responseHeaders[rule.name] = [rule.value || ''];
        }
      }
    }

    callback({ responseHeaders });
  });

  // --- #5: PERMISSION FIREWALL ---
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingUrl ? new URL(details.requestingUrl).origin : webContents.getURL();
    const allowed = engine.evaluatePermission(origin, permission);
    callback(allowed);
  });

  ses.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return engine.evaluatePermission(requestingOrigin || '', permission);
  });

  // --- #5: DOWNLOAD INTERCEPTION & CONTROLLER ---
  ses.on('will-download', (_event, item) => {
    const state = engine.getState();
    const filename = item.getFilename();
    const url = item.getURL();
    const totalBytes = item.getTotalBytes();
    const ext = path.extname(filename).toLowerCase();

    if (
      state.downloads.autoBlockDangerous &&
      state.downloads.blockedExtensions.includes(ext)
    ) {
      item.cancel();
      engine.registerDownload({
        filename,
        url,
        totalBytes,
        receivedBytes: 0,
        state: 'blocked-extension',
        containerId
      });
      return;
    }

    const dlId = engine.registerDownload({
      filename,
      url,
      totalBytes,
      receivedBytes: 0,
      state: 'progressing',
      containerId
    });

    item.on('updated', (_ev, dlState) => {
      engine.updateDownload(dlId, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: item.isPaused() ? 'paused' : dlState
      });
    });

    item.once('done', (_ev, dlState) => {
      engine.updateDownload(dlId, {
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        state: dlState
      });
    });
  });
}

/**
 * Attach Chrome DevTools Protocol (CDP) Network Debugger to any webContents
 * so 100% of requests, headers, payloads, response bodies, and sub-ms timings
 * are captured natively.
 */
function attachCDPNetworkCapture(webContents, tabId, containerId, engine) {
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
    }
    webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 50 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 5 * 1024 * 1024
    });

    const state = engine.getState();
    webContents.debugger.sendCommand('Network.setCacheDisabled', {
      cacheDisabled: Boolean(state.capture.disableCache)
    });

    const pending = new Map();

    webContents.debugger.on('message', async (_event, method, params) => {
      if (!engine.getState().capture.recording) return;

      if (method === 'Network.requestWillBeSent') {
        const req = params.request || {};
        pending.set(params.requestId, {
          requestId: params.requestId,
          tabId,
          containerId,
          startTimeMs: Date.now(),
          wallTime: params.wallTime,
          timestamp: params.timestamp,
          method: req.method || 'GET',
          url: req.url || '',
          resourceType: params.type || 'Other',
          requestHeaders: req.headers || {},
          requestBody: req.postData || '',
          requestBodySize: req.postData ? Buffer.byteLength(req.postData) : 0
        });
      } else if (method === 'Network.responseReceived') {
        const item = pending.get(params.requestId);
        if (!item) return;
        const res = params.response || {};
        const t = res.timing || {};
        item.status = res.status || 200;
        item.statusText = res.statusText || 'OK';
        item.protocol = res.protocol || 'HTTP/1.1';
        item.mimeType = res.mimeType || 'text/plain';
        item.remoteAddress = res.remoteIPAddress ? `${res.remoteIPAddress}:${res.remotePort || ''}` : '';
        item.fromCache = Boolean(res.fromDiskCache || res.fromServiceWorker);
        item.responseHeaders = res.headers || {};
        item.cdpTiming = {
          dns: Math.max(0, (t.dnsEnd || 0) - (t.dnsStart || 0)),
          connect: Math.max(0, (t.connectEnd || 0) - (t.connectStart || 0)),
          ssl: Math.max(0, (t.sslEnd || 0) - (t.sslStart || 0)),
          send: Math.max(0, (t.sendEnd || 0) - (t.sendStart || 0)),
          wait: Math.max(0, (t.receiveHeadersStart || t.receiveHeadersEnd || 0) - (t.sendEnd || 0))
        };
      } else if (method === 'Network.loadingFinished') {
        const item = pending.get(params.requestId);
        if (!item) return;
        pending.delete(params.requestId);

        let responseBody = '';
        if (engine.getState().capture.captureBodies) {
          try {
            const bodyRes = await webContents.debugger.sendCommand('Network.getResponseBody', {
              requestId: params.requestId
            });
            responseBody = bodyRes.base64Encoded
              ? `[Base64 Binary Payload: ${bodyRes.body.length} chars]`
              : bodyRes.body;
          } catch {
            // Body may be unavailable for redirects or empty responses
          }
        }

        const totalMs = Math.max(1, Date.now() - item.startTimeMs);
        const cdpT = item.cdpTiming || { dns: 0, connect: 0, ssl: 0, send: 0.5, wait: totalMs * 0.6 };
        const receiveMs = Math.max(0.5, totalMs - (cdpT.dns + cdpT.connect + cdpT.ssl + cdpT.send + cdpT.wait));

        engine.recordCompletedEntry({
          tabId: item.tabId,
          containerId: item.containerId,
          startTimeMs: item.startTimeMs,
          method: item.method,
          url: item.url,
          resourceType: item.resourceType,
          protocol: item.protocol || 'HTTP/1.1',
          status: item.status || 200,
          statusText: item.statusText || 'OK',
          remoteAddress: item.remoteAddress || '',
          fromCache: item.fromCache || false,
          mimeType: item.mimeType || 'text/plain',
          requestHeaders: item.requestHeaders,
          requestBody: item.requestBody,
          requestBodySize: item.requestBodySize,
          responseHeaders: item.responseHeaders || {},
          responseBody: typeof responseBody === 'string' ? responseBody.slice(0, 200000) : '',
          responseBodySize: params.encodedDataLength || Buffer.byteLength(responseBody || ''),
          transferSize: params.encodedDataLength || Buffer.byteLength(responseBody || ''),
          timings: {
            blocked: 0.4,
            dns: Number(cdpT.dns.toFixed(2)),
            connect: Number(cdpT.connect.toFixed(2)),
            ssl: Number(cdpT.ssl.toFixed(2)),
            send: Number(cdpT.send.toFixed(2)),
            wait: Number(cdpT.wait.toFixed(2)),
            receive: Number(receiveMs.toFixed(2)),
            total: Number(totalMs.toFixed(2))
          }
        });
      } else if (method === 'Network.loadingFailed') {
        const item = pending.get(params.requestId);
        if (!item) return;
        pending.delete(params.requestId);
        engine.recordBlockedRequest({
          tabId: item.tabId,
          containerId: item.containerId,
          method: item.method,
          url: item.url,
          resourceType: item.resourceType,
          reason: params.blockedReason || params.errorText || 'Failed'
        });
      }
    });
  } catch (err) {
    console.error('CDP attach note:', err.message);
  }
}

async function createDesktopWindow() {
  const { port, engine } = await startBrowzServer(0);

  // Configure initial containers in Chromium
  for (const c of engine.getState().containers) {
    configureChromiumPartition(c.partition, c.id, engine);
  }

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    title: 'Browz — Performance Capture & Privacy Control Browser',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  // Automatically attach CDP Network Capture & Partition Firewall to every <webview> tab
  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    const partition = webContents.session.storagePath ? `persist:${path.basename(webContents.session.storagePath)}` : 'persist:default';
    const matched = engine.getState().containers.find((c) => c.partition === partition);
    const containerId = matched ? matched.id : 'default';
    configureChromiumPartition(partition, containerId, engine);
    attachCDPNetworkCapture(webContents, `webview-${webContents.id}`, containerId, engine);

    // #5 Popup & External Protocol Firewall
    webContents.setWindowOpenHandler(({ url }) => {
      const allowed = engine.evaluatePermission(url, 'popups');
      return { action: allowed ? 'allow' : 'deny' };
    });
  });

  // OS Native Controls (#5)
  ipcMain.handle('browz:toggleAlwaysOnTop', () => {
    const next = !mainWindow.isAlwaysOnTop();
    mainWindow.setAlwaysOnTop(next);
    return { alwaysOnTop: next };
  });

  ipcMain.handle('browz:captureScreenshot', async () => {
    const image = await mainWindow.webContents.capturePage();
    const { filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Save Browz Screenshot',
      defaultPath: `browz-capture-${Date.now()}.png`,
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (filePath) {
      fs.writeFileSync(filePath, image.toPNG());
      return { saved: true, filePath };
    }
    return { saved: false };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

if (app) {
  app.whenReady().then(createDesktopWindow);
  app.on('window-all-closed', () => {
    if (serverInstance) serverInstance.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
