'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  session,
  ipcMain,
  dialog
} = require('electron');
const { startBrowzServer } = require('../server/index');
const {
  RADIO_PROFILES,
  shouldBlockRequest,
  stripUrlTrackingParams,
  getEffectiveUserAgent
} = require('../shared/core-state');
const { buildStealthShieldScript } = require('./webview-shield');

// --- CHROMIUM UNTRACEABILITY & ZERO-TELEMETRY SWITCHES ---
if (app) {
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch('disable-translate');
  app.commandLine.appendSwitch('disable-client-side-phishing-detection');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-default-apps');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-breakpad');
  app.commandLine.appendSwitch('disable-speech-api');
  app.commandLine.appendSwitch(
    'disable-features',
    'OptimizationHints,MediaRouter,Translate,PrivacySandboxSettings4,Topics,BrowsingTopics,HardwareMediaKeyHandling,MediaSessionService'
  );
  // Prevent WebRTC from leaking local/ISP IP addresses
  app.commandLine.appendSwitch('enforce-webrtc-ip-permission-check');
  app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
}

let mainWindow = null;
const configuredPartitions = new Map();

function applyChromiumDoH(dohUrl) {
  if (!app || typeof app.configureHostResolver !== 'function') return;
  try {
    app.configureHostResolver({
      enableBuiltInDnsClient: true,
      secureDnsMode: dohUrl ? 'automatic' : 'off',
      secureDnsServers: dohUrl ? [dohUrl] : []
    });
  } catch {}
}

async function applyProxyToAllPartitions(engine) {
  const state = engine.getState();
  const proxyCfg = state.networkControl.proxy || {};
  applyChromiumDoH(proxyCfg.dohUrl);

  for (const [partitionName, ses] of configuredPartitions.entries()) {
    try {
      if (proxyCfg.mode !== 'direct' && proxyCfg.rules) {
        await ses.setProxy({
          proxyRules: proxyCfg.rules,
          proxyBypassRules: proxyCfg.bypassList || 'localhost,127.0.0.1'
        });
      } else {
        await ses.setProxy({ mode: 'direct' });
      }
    } catch {}
  }
}

async function clearChromiumPartitionStorage(partitionName) {
  const chromiumPartition = partitionName.startsWith('ephemeral:')
    ? partitionName.replace(/^ephemeral:/, 'ram_')
    : partitionName;
  const ses = session.fromPartition(chromiumPartition);
  try {
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
  } catch {}
}

/**
 * Configure a Chromium Session partition with:
 * - #2 Full Network Interception, Block Rules, Tracker Param Stripper, Header Spoofing & Proxy
 * - #4 Isolated Cookie & Storage Partitioning (RAM-only for Burner containers)
 * - #5 Permission Firewall & Download Blocker
 */
function configureChromiumPartition(partitionName, containerId, engine) {
  if (configuredPartitions.has(partitionName)) return;

  // Ephemeral partitions omit "persist:" in Chromium so they live 100% in RAM and never touch disk
  const chromiumPartition = partitionName.startsWith('ephemeral:')
    ? partitionName.replace(/^ephemeral:/, 'ram_')
    : partitionName;

  const ses = session.fromPartition(chromiumPartition);
  configuredPartitions.set(partitionName, ses);

  // --- #5: PERMISSION FIREWALL ---
  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (permission === 'fullscreen') return callback(true);
      let origin = 'unknown';
      try {
        origin = details?.requestingUrl ? new URL(details.requestingUrl).origin : webContents.getURL();
      } catch {}
      const allowed = engine.evaluatePermission(origin, permission);
      callback(allowed);
    });

    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      if (permission === 'fullscreen') return true;
      return engine.evaluatePermission(requestingOrigin || '', permission);
    });
  }

  // --- #2: NETWORK INTERCEPTION (Block rules, SSRF/Loopback/File Firewall, Radio Kill-Switch, URL Tracker Stripper & HTTPS Upgrade) ---
  ses.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
    const reqUrl = details.url || '';
    // Block all local file:// protocol access from inside webviews
    if (reqUrl.startsWith('file://')) {
      return callback({ cancel: true });
    }

    let parsedHost = '';
    try {
      parsedHost = new URL(reqUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {}

    // Block cloud metadata & obfuscated SSRF hosts in Chromium webview
    if (
      parsedHost === '169.254.169.254' ||
      parsedHost.startsWith('169.254.') ||
      parsedHost === 'metadata.google.internal' ||
      parsedHost === '100.100.100.200' ||
      parsedHost === '0.0.0.0' ||
      parsedHost === '::1' ||
      parsedHost === 'fd00:ec2::254' ||
      /^\d+$/.test(parsedHost) ||
      /^0x[0-9a-f]+$/i.test(parsedHost)
    ) {
      engine.recordBlockedRequest({
        tabId: details.webContentsId ? `wc-${details.webContentsId}` : 'tab-1',
        containerId,
        method: details.method,
        url: reqUrl,
        resourceType: details.resourceType,
        reason: 'Blocked SSRF / Cloud Metadata Target'
      });
      return callback({ cancel: true });
    }

    // Block external websites from scanning 127.0.0.1 / localhost (Private Network Access guard)
    const isLoopbackTarget = parsedHost === '127.0.0.1' || parsedHost === 'localhost';
    if (isLoopbackTarget) {
      const initiator = String(details.initiator || '');
      if (initiator && !initiator.startsWith('http://127.0.0.1:') && !initiator.startsWith('http://localhost:')) {
        engine.recordBlockedRequest({
          tabId: details.webContentsId ? `wc-${details.webContentsId}` : 'tab-1',
          containerId,
          method: details.method,
          url: reqUrl,
          resourceType: details.resourceType,
          reason: 'Blocked Cross-Origin Localhost Port Scan / Control Plane Access'
        });
        return callback({ cancel: true });
      }
      return callback({ cancel: false });
    }

    const state = engine.getState();
    const activeRadio = RADIO_PROFILES[state.stealth?.radioProfile || 'stealth_hidden'] || RADIO_PROFILES.stealth_hidden;

    // Enforce WebSocket Stream I/O Firewall at Chromium network layer too
    if (state.stealth?.blockWebSockets && (reqUrl.startsWith('ws://') || reqUrl.startsWith('wss://'))) {
      engine.recordBlockedRequest({
        tabId: details.webContentsId ? `wc-${details.webContentsId}` : 'tab-1',
        containerId,
        method: details.method,
        url: reqUrl,
        resourceType: 'WebSocket',
        reason: 'Blocked by Browz WebSocket Stream I/O Firewall'
      });
      return callback({ cancel: true });
    }

    if (state.capture.throttling?.offline || activeRadio.offline) {
      const reason = activeRadio.offline
        ? 'Air-Gap Radio Kill-Switch Active (Network I/O Cut)'
        : 'Offline Mode Active (Network Throttling)';
      engine.recordBlockedRequest({
        tabId: details.webContentsId ? `wc-${details.webContentsId}` : 'tab-1',
        containerId,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        reason
      });
      return callback({ cancel: true });
    }

    const { blocked, reason } = shouldBlockRequest(
      details.url,
      details.resourceType,
      state.networkControl
    );

    if (blocked) {
      state.networkControl.blockedTrackersCount = (state.networkControl.blockedTrackersCount || 0) + 1;
      engine.recordBlockedRequest({
        tabId: details.webContentsId ? `wc-${details.webContentsId}` : 'tab-1',
        containerId,
        method: details.method,
        url: details.url,
        resourceType: details.resourceType,
        reason
      });
      return callback({ cancel: true });
    }

    // Strip tracking query params (utm_*, fbclid, gclid, msclkid, etc.)
    if (state.stealth && state.stealth.stripTrackingParams) {
      const stripped = stripUrlTrackingParams(details.url);
      if (stripped.strippedCount > 0 && stripped.url !== details.url) {
        state.networkControl.strippedParamsCount =
          (state.networkControl.strippedParamsCount || 0) + stripped.strippedCount;
        return callback({ redirectURL: stripped.url });
      }
    }

    if (
      state.networkControl.forceHttps &&
      details.url.startsWith('http://') &&
      !details.url.includes('localhost') &&
      !details.url.includes('127.0.0.1')
    ) {
      return callback({ redirectURL: details.url.replace(/^http:\/\//i, 'https://') });
    }

    callback({ cancel: false });
  });

  // --- #2: REQUEST HEADER MANIPULATION (User-Agent, Referer, Client-Hints, Custom Headers) ---
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, callback) => {
    if (details.url.startsWith('http://127.0.0.1:')) {
      return callback({ requestHeaders: details.requestHeaders });
    }

    const state = engine.getState();
    const container = state.containers.find((c) => c.id === containerId);
    const headers = { ...details.requestHeaders };

    // Effective User-Agent from Stealth Persona or Container override
    headers['User-Agent'] = getEffectiveUserAgent(state.networkControl, container, state.stealth);

    // Strip Referer or downgrade to origin-only
    if (state.networkControl.stripReferer) {
      delete headers['Referer'];
      delete headers['referer'];
    }

    // Strip Client Hints / Chrome X-Client-Data tracking headers
    if (state.networkControl.stripTrackingHeaders) {
      for (const k of Object.keys(headers)) {
        const low = k.toLowerCase();
        if (low.startsWith('sec-ch-ua') || low === 'x-client-data') {
          delete headers[k];
        }
      }
    }

    // Spoof Accept-Language to match Stealth Persona
    if (state.stealth && state.stealth.spoofLanguage && state.stealth.persona) {
      headers['Accept-Language'] = `${state.stealth.persona.language || 'en-US'},en;q=0.9`;
    }

    // Inject DNT / GPC privacy headers & Radio Save-Data
    headers['DNT'] = '1';
    headers['Sec-GPC'] = '1';
    const activeRadio = RADIO_PROFILES[state.stealth?.radioProfile || 'stealth_hidden'] || RADIO_PROFILES.stealth_hidden;
    if (activeRadio.saveData) {
      headers['Save-Data'] = 'on';
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

const attachedGuests = new Set();

function syncGuestCDPState(webContents, engine) {
  if (!webContents || webContents.isDestroyed()) return;
  try {
    const state = engine.getState();
    const activeRadio = RADIO_PROFILES[state.stealth?.radioProfile || 'stealth_hidden'] || RADIO_PROFILES.stealth_hidden;
    const thr = state.capture.throttling || {};
    const isOffline = Boolean(thr.offline || activeRadio.offline);
    const latency = Number(thr.latencyMs || 0) + Number(activeRadio.latencyMs || 0);
    const downBytesPerSec = isOffline
      ? 0
      : thr.downloadKbps > 0
        ? (thr.downloadKbps * 1024) / 8
        : activeRadio.downlink > 0
          ? (activeRadio.downlink * 1024 * 1024) / 8
          : -1;
    const upBytesPerSec = isOffline
      ? 0
      : thr.uploadKbps > 0
        ? (thr.uploadKbps * 1024) / 8
        : activeRadio.downlink > 0
          ? (activeRadio.downlink * 512 * 1024) / 8
          : -1;
    const connType = isOffline
      ? 'none'
      : activeRadio.type === 'wifi'
        ? 'wifi'
        : activeRadio.effectiveType === '3g'
          ? 'cellular3g'
          : activeRadio.type === 'cellular'
            ? 'cellular4g'
            : 'ethernet';

    if (webContents.debugger.isAttached()) {
      webContents.debugger.sendCommand('Network.setCacheDisabled', {
        cacheDisabled: Boolean(state.capture.disableCache)
      }).catch(() => {});
      webContents.debugger.sendCommand('Network.emulateNetworkConditions', {
        offline: isOffline,
        latency,
        downloadThroughput: downBytesPerSec,
        uploadThroughput: upBytesPerSec,
        connectionType: connType
      }).catch(() => {});
    }
    const script = buildStealthShieldScript(state.stealth);
    webContents.executeJavaScript(script).catch(() => {});
  } catch {}
}

/**
 * Attach Chrome DevTools Protocol (CDP) Network Debugger to any webContents
 */
function attachCDPNetworkCapture(webContents, tabIdResolver, containerIdResolver, engine) {
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3');
    }
    webContents.debugger.sendCommand('Network.enable', {
      maxTotalBufferSize: 50 * 1024 * 1024,
      maxResourceBufferSize: 10 * 1024 * 1024,
      maxPostDataSize: 5 * 1024 * 1024
    });

    webContents.debugger.sendCommand('Page.enable').catch(() => {});
    webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: buildStealthShieldScript(engine.getState().stealth)
    }).catch(() => {});

    syncGuestCDPState(webContents, engine);

    const pending = new Map();

    webContents.debugger.on('message', async (_event, method, params) => {
      if (!engine.getState().capture.recording) return;

      if (method === 'Network.requestWillBeSent') {
        const req = params.request || {};
        if (!req.url || req.url.startsWith('data:')) return;

        pending.set(params.requestId, {
          requestId: params.requestId,
          tabId: tabIdResolver(),
          containerId: containerIdResolver(),
          startTimeMs: Date.now(),
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
          } catch {}
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
          reason: params.blockedReason || params.errorText || 'Blocked / Failed'
        });
      }
    });
  } catch (err) {
    console.error('CDP attach note:', err.message);
  }
}

async function createDesktopWindow() {
  const { port, engine } = await startBrowzServer(0, '127.0.0.1');

  // Hook engine callbacks so proxy/storage/stealth/radio changes in UI immediately apply to Chromium sessions
  engine.onProxyConfigChanged = () => applyProxyToAllPartitions(engine);
  engine.onClearPartitionStorage = (partitionName) => clearChromiumPartitionStorage(partitionName);
  engine.onContainerCreated = (c) => configureChromiumPartition(c.partition, c.id, engine);
  engine.onStealthOrNetworkChanged = () => {
    for (const guest of attachedGuests) {
      if (guest.isDestroyed()) {
        attachedGuests.delete(guest);
      } else {
        syncGuestCDPState(guest, engine);
      }
    }
  };

  // Configure initial containers & DoH in Chromium
  for (const c of engine.getState().containers) {
    configureChromiumPartition(c.partition, c.id, engine);
  }
  await applyProxyToAllPartitions(engine);

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1024,
    minHeight: 680,
    title: 'Browz — Untraceable Stealth & Network Control Browser',
    backgroundColor: '#090d16',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      webviewTag: true
    }
  });

  // SECURITY: Block OS Screen-Capture, Windows Recall & Third-Party Window Sniffing (WDA_EXCLUDEFROMCAPTURE)
  try {
    mainWindow.setContentProtection(true);
  } catch {}

  // SECURITY: Prevent main BrowserWindow shell from ever being navigated to an external URL
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!navigationUrl.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault();
    }
  });

  // SECURITY: Harden every <webview> guest before attachment
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInWorker = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.enableRemoteModule = false;
    webPreferences.webviewTag = false;
    webPreferences.navigateOnDragDrop = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    webPreferences.spellcheck = false;
    if (params && params.src) {
      const s = String(params.src);
      if (!s.startsWith('http://') && !s.startsWith('https://') && !s.startsWith('about:blank')) {
        event.preventDefault();
      }
    }
  });

  // Attach Untraceability Shield, CDP Network Capture & Partition Firewall to every <webview> tab
  mainWindow.webContents.on('did-attach-webview', (_event, guestWebContents) => {
    attachedGuests.add(guestWebContents);
    guestWebContents.once('destroyed', () => attachedGuests.delete(guestWebContents));

    const injectShield = () => {
      const script = buildStealthShieldScript(engine.getState().stealth);
      guestWebContents.executeJavaScript(script).catch(() => {});
    };

    guestWebContents.on('dom-ready', injectShield);
    guestWebContents.on('did-navigate', injectShield);
    guestWebContents.on('did-navigate-in-page', injectShield);

    attachCDPNetworkCapture(
      guestWebContents,
      () => 'tab-active',
      () => 'default',
      engine
    );

    // #5 Popup & External Protocol Firewall (Routes user-clicked <a target="_blank"> links cleanly into Browz tabs)
    guestWebContents.setWindowOpenHandler(({ url, disposition }) => {
      const isHttpUrl = /^https?:\/\//i.test(url || '');
      const isUserLinkClick =
        disposition === 'foreground-tab' ||
        disposition === 'background-tab' ||
        disposition === 'new-window';
      const allowed = (isHttpUrl && isUserLinkClick) || engine.evaluatePermission(url, 'popups');
      if (allowed && isHttpUrl && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.executeJavaScript(
          `window.postMessage({ type: 'browz:open-tab', url: ${JSON.stringify(url)}, containerId: 'default' }, '*')`
        ).catch(() => {});
      }
      return { action: 'deny' };
    });
  });

  ipcMain.handle('browz:getLocalPort', () => port);

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
  app.on('before-quit', () => {
    for (const [, ses] of configuredPartitions.entries()) {
      try {
        ses.clearCache().catch(() => {});
        ses.clearAuthCache().catch(() => {});
      } catch {}
    }
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
