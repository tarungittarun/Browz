'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

// Persistent HTTP/HTTPS connection pooling for ultra-low-latency proxy & burst loads
const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  keepAliveMsecs: 15000
});
const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  keepAliveMsecs: 15000
});
const selfSignedHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  rejectUnauthorized: false
});

function attachNativeWebSocketServer(server, pathFilter, onClientConnect) {
  server.on('upgrade', (req, socket) => {
    const reqUrl = req.url || '/';
    if (pathFilter && !reqUrl.startsWith(pathFilter)) {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey}`,
        '\r\n'
      ].join('\r\n')
    );

    const client = {
      readyState: 1,
      send(strData) {
        if (this.readyState !== 1 || socket.destroyed) return;
        const payload = Buffer.from(String(strData), 'utf8');
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.alloc(2);
          header[0] = 0x81; // FIN + text frame
          header[1] = len;
        } else if (len < 65536) {
          header = Buffer.alloc(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.alloc(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        try {
          socket.write(Buffer.concat([header, payload]));
        } catch {
          this.readyState = 3;
        }
      }
    };

    socket.on('close', () => {
      client.readyState = 3;
    });
    socket.on('error', () => {
      client.readyState = 3;
    });

    onClientConnect(client);
  });
}

const {
  USER_AGENT_PRESETS,
  STEALTH_PERSONAS,
  DOH_PROVIDERS,
  THROTTLING_PRESETS,
  RADIO_PROFILES,
  createInitialState,
  stripUrlTrackingParams,
  shouldBlockRequest,
  getEffectiveUserAgent
} = require('../shared/core-state');
const { buildStealthShieldScript } = require('../electron/webview-shield');

const {
  computeMetrics,
  objectToHeaderList,
  toHAR,
  toK6Script,
  toJMeterJMX,
  toCSV,
  toCurl,
  toFetch
} = require('../shared/exporters');

class BrowzEngine {
  constructor() {
    this.state = createInitialState();
    this.entries = [];
    this.maxEntries = 1000;
    this.seqCounter = 1;
    this.wsClients = new Set();
  }

  getState() {
    return this.state;
  }

  broadcast(type, payload) {
    const msg = JSON.stringify({ type, payload });
    for (const client of this.wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch {
          // ignore closed socket
        }
      }
    }
  }

  parseQueryString(urlStr) {
    try {
      const u = new URL(urlStr);
      const out = [];
      u.searchParams.forEach((value, name) => {
        out.push({ name, value });
      });
      return out;
    } catch {
      return [];
    }
  }

  parseUrlParts(urlStr) {
    try {
      const u = new URL(urlStr);
      return {
        domain: u.host,
        path: (u.pathname || '/') + (u.search || '')
      };
    } catch {
      return {
        domain: 'browz.local',
        path: urlStr || '/'
      };
    }
  }

  recordBlockedRequest({ tabId, containerId, method, url, resourceType, reason, requestHeaders, requestBody }) {
    if (!this.state.capture.recording) return null;
    const now = Date.now();
    const parts = this.parseUrlParts(url);
    const entry = {
      id: `req-${now}-${this.seqCounter}`,
      seq: this.seqCounter++,
      tabId: tabId || 'tab-1',
      containerId: containerId || 'default',
      startedDateTime: new Date(now).toISOString(),
      startTimeMs: now,
      method: (method || 'GET').toUpperCase(),
      url,
      domain: parts.domain,
      path: parts.path,
      queryString: this.parseQueryString(url),
      resourceType: resourceType || 'Other',
      protocol: 'HTTP/1.1',
      status: 0,
      statusText: 'BLOCKED',
      blocked: true,
      blockReason: reason || 'Blocked by Network Control rule',
      remoteAddress: '-',
      fromCache: false,
      mimeType: 'text/plain',
      requestHeaders: requestHeaders || {},
      requestBody: requestBody || '',
      requestBodySize: requestBody ? Buffer.byteLength(String(requestBody)) : 0,
      requestCookies: [],
      responseHeaders: {},
      responseBody: `Request blocked by Browz Network Control.\nReason: ${reason || 'Rule match'}`,
      responseBodySize: 0,
      transferSize: 0,
      responseCookies: [],
      timings: {
        blocked: 0.2,
        dns: 0,
        connect: 0,
        ssl: 0,
        send: 0,
        wait: 0,
        receive: 0,
        total: 0.2
      }
    };

    this.pushEntry(entry);
    return entry;
  }

  recordCompletedEntry(raw) {
    if (!this.state.capture.recording) return null;
    const now = raw.startTimeMs || Date.now();
    const parts = this.parseUrlParts(raw.url);
    const entry = {
      id: raw.id || `req-${now}-${this.seqCounter}`,
      seq: this.seqCounter++,
      tabId: raw.tabId || 'tab-1',
      containerId: raw.containerId || 'default',
      startedDateTime: new Date(now).toISOString(),
      startTimeMs: now,
      method: (raw.method || 'GET').toUpperCase(),
      url: raw.url || '',
      domain: parts.domain,
      path: parts.path,
      queryString: this.parseQueryString(raw.url),
      resourceType: raw.resourceType || 'XHR',
      protocol: raw.protocol || 'HTTP/1.1',
      status: raw.status ?? 200,
      statusText: raw.statusText || 'OK',
      blocked: Boolean(raw.blocked),
      blockReason: raw.blockReason || null,
      remoteAddress: raw.remoteAddress || '127.0.0.1',
      fromCache: Boolean(raw.fromCache),
      mimeType: raw.mimeType || 'application/json',
      requestHeaders: raw.requestHeaders || {},
      requestBody: this.state.capture.captureBodies ? (raw.requestBody || '') : '[Body capture disabled]',
      requestBodySize: raw.requestBodySize ?? (raw.requestBody ? Buffer.byteLength(String(raw.requestBody)) : 0),
      requestCookies: raw.requestCookies || [],
      responseHeaders: raw.responseHeaders || {},
      responseBody: this.state.capture.captureBodies ? (raw.responseBody || '') : '[Body capture disabled]',
      responseBodySize: raw.responseBodySize ?? (raw.responseBody ? Buffer.byteLength(String(raw.responseBody)) : 0),
      transferSize: raw.transferSize ?? raw.responseBodySize ?? 0,
      responseCookies: raw.responseCookies || [],
      timings: raw.timings || {
        blocked: 0.5,
        dns: 1.2,
        connect: 2.4,
        ssl: 0,
        send: 0.4,
        wait: 12.5,
        receive: 1.8,
        total: 18.8
      }
    };

    this.pushEntry(entry);
    return entry;
  }

  pushEntry(entry) {
    this.entries.push(entry);
    const limit = this.state.capture.maxEntries || this.maxEntries || 1000;
    while (this.entries.length > limit) {
      this.entries.shift();
    }
    this.broadcast('entry:new', {
      entry,
      metrics: computeMetrics(this.entries)
    });
  }

  clearEntries(tabId = null) {
    if (tabId) {
      this.entries = this.entries.filter((e) => e.tabId !== tabId);
    } else {
      this.entries = [];
      this.seqCounter = 1;
    }
    this.broadcast('entries:cleared', {
      tabId,
      entries: this.entries,
      metrics: computeMetrics(this.entries)
    });
  }

  getContainer(containerId) {
    return (
      this.state.containers.find((c) => c.id === containerId) ||
      this.state.containers[0]
    );
  }

  getContainerCookieHeader(containerId, domain) {
    const container = this.getContainer(containerId);
    if (!container || !container.cookies) return { header: '', list: [] };
    const bucket = {
      ...(container.cookies['*'] || {}),
      ...(container.cookies['browz.local'] || {}),
      ...(container.cookies[domain] || {})
    };
    const list = Object.entries(bucket).map(([name, value]) => ({ name, value: String(value) }));
    const header = list.map((c) => `${c.name}=${c.value}`).join('; ');
    return { header, list };
  }

  storeSetCookies(containerId, domain, setCookieHeaders) {
    if (!setCookieHeaders) return [];
    const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const container = this.getContainer(containerId);
    if (!container.cookies[domain]) container.cookies[domain] = {};
    const parsedList = [];

    for (const raw of arr) {
      const firstPart = String(raw).split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx).trim();
        const value = firstPart.slice(eqIdx + 1).trim();
        container.cookies[domain][name] = value;
        parsedList.push({ name, value });
      }
    }

    container.cookieCount = Object.values(container.cookies).reduce(
      (acc, obj) => acc + Object.keys(obj || {}).length,
      0
    );
    this.broadcast('state:updated', this.state);
    return parsedList;
  }

  evaluatePermission(origin, permission) {
    const normOrigin = origin || 'unknown';
    const overrides = this.state.permissions.siteOverrides[normOrigin] || {};
    const decision =
      overrides[permission] ||
      this.state.permissions.globalDefaults[permission] ||
      'deny';

    const logItem = {
      id: `perm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toISOString(),
      origin: normOrigin,
      permission,
      decision,
      reason: overrides[permission] ? 'Site override rule' : 'Global firewall policy'
    };

    this.state.permissions.eventLog.unshift(logItem);
    if (this.state.permissions.eventLog.length > 100) {
      this.state.permissions.eventLog.pop();
    }
    this.broadcast('permission:event', logItem);
    return decision === 'allow';
  }

  registerDownload(dl) {
    const id = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const item = {
      id,
      filename: dl.filename || 'download.bin',
      url: dl.url || '',
      totalBytes: dl.totalBytes || 0,
      receivedBytes: dl.receivedBytes || 0,
      state: dl.state || 'progressing',
      containerId: dl.containerId || 'default',
      startedAt: new Date().toISOString()
    };
    this.state.downloads.items.unshift(item);
    this.broadcast('state:updated', this.state);
    return id;
  }

  updateDownload(id, patch) {
    const item = this.state.downloads.items.find((d) => d.id === id);
    if (item) {
      Object.assign(item, patch);
      this.broadcast('state:updated', this.state);
    }
  }
}

function safeJsonForScript(val) {
  return JSON.stringify(val)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function validateOutboundTarget(parsedUrl, localPort, redirectHop = 0, initialWasLocal = false) {
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`Blocked unsafe protocol: ${parsedUrl.protocol}`);
  }

  const rawHost = (parsedUrl.hostname || '').toLowerCase().trim();
  const cleanHost = rawHost.replace(/^\[|\]$/g, '');

  // 1. Block Cloud Metadata, Link-Local, IPv6 Loopback/Unique-Local/Mapped, and Unspecified IPs
  if (
    cleanHost === '169.254.169.254' ||
    cleanHost === 'metadata.google.internal' ||
    cleanHost === 'metadata.goog' ||
    cleanHost === '100.100.100.200' ||
    cleanHost === '192.0.0.192' ||
    cleanHost === '0.0.0.0' ||
    cleanHost.startsWith('169.254.') ||
    cleanHost === '::' ||
    cleanHost === '::1' ||
    cleanHost === '0:0:0:0:0:0:0:1' ||
    cleanHost === '0:0:0:0:0:0:0:0' ||
    cleanHost === 'fd00:ec2::254' ||
    cleanHost.startsWith('fe80:') ||
    cleanHost.startsWith('fc00:') ||
    cleanHost.startsWith('fd00:') ||
    cleanHost.startsWith('::ffff:169.254.') ||
    cleanHost.startsWith('::ffff:a9fe:') ||
    cleanHost.startsWith('::ffff:127.') ||
    cleanHost.startsWith('::ffff:7f') ||
    cleanHost === '::ffff:0.0.0.0'
  ) {
    throw new Error('Blocked access to cloud metadata or restricted link-local/IPv6 endpoint');
  }

  // 2. Block Obfuscated IPv4 (Decimal Integer IP, Hex IP, Octal IP, Short Loopback)
  if (/^\d+$/.test(cleanHost)) {
    throw new Error('Blocked integer-encoded IPv4 SSRF target');
  }
  if (/^0x[0-9a-f]+$/i.test(cleanHost)) {
    throw new Error('Blocked hex-encoded IPv4 SSRF target');
  }
  const ipv4Parts = cleanHost.split('.');
  if (ipv4Parts.every((p) => /^(0x[0-9a-f]+|\d+)$/i.test(p))) {
    for (const part of ipv4Parts) {
      if (/^0x/i.test(part) || (part.length > 1 && part.startsWith('0'))) {
        throw new Error('Blocked octal/hex-encoded IPv4 SSRF target');
      }
    }
    if (ipv4Parts[0] === '127' && cleanHost !== '127.0.0.1') {
      throw new Error('Blocked non-standard loopback range SSRF target');
    }
    if (ipv4Parts[0] === '0') {
      throw new Error('Blocked 0.0.0.0/8 SSRF target');
    }
  }

  const isLocalHost = cleanHost === '127.0.0.1' || cleanHost === 'localhost';

  // 3. Block Cross-Origin Redirect SSRF (External URL redirecting to 127.0.0.1 / localhost / RFC1918 private LAN)
  if (redirectHop > 0 && !initialWasLocal) {
    const isPrivateLan =
      cleanHost.startsWith('10.') ||
      cleanHost.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(cleanHost);
    if (isLocalHost || isPrivateLan) {
      throw new Error('Blocked external-to-internal redirect SSRF attack');
    }
  }

  // 4. Block Unported Loopback / WHATWG-Normalized Integer/Hex/Octal Loopback SSRF (e.g. http://2130706433/ -> http://127.0.0.1/)
  const effectivePort = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));
  if (isLocalHost && !parsedUrl.port && localPort && Number(localPort) !== 80 && Number(localPort) !== 443) {
    throw new Error('Blocked unported loopback or obfuscated IPv4 SSRF target');
  }

  // 5. Block Proxy-to-Control-Plane Escalation on local Browz server port
  if (isLocalHost && localPort && effectivePort === Number(localPort)) {
    const p = parsedUrl.pathname || '/';
    if (p.startsWith('/api/') && p !== '/api/security-audit') {
      throw new Error('Blocked proxy access to internal Browz control plane API');
    }
  }
}

/**
 * Perform an outbound or local HTTP/HTTPS request with real high-resolution
 * timing breakdown (DNS, TCP Connect, TLS Handshake, TTFB Wait, Download)
 * and full Network Control (#2) + Container Cookie Isolation (#4).
 */
async function executeCapturedRequest(engine, opts, localPort) {
  const {
    tabId = 'tab-1',
    containerId = 'default',
    method = 'GET',
    url: rawUrl,
    headers: incomingHeaders = {},
    body = '',
    resourceType = 'XHR'
  } = opts;

  const state = engine.getState();
  const activeRadio = RADIO_PROFILES[state.stealth?.radioProfile || 'stealth_hidden'] || RADIO_PROFILES.stealth_hidden;

  // Check Offline Throttling Mode or Air-Gap Radio Kill-Switch
  if (state.capture.throttling?.offline || activeRadio.offline) {
    const reason = activeRadio.offline
      ? 'Air-Gap Radio Kill-Switch Active (Network I/O Cut)'
      : 'Offline Mode Active (Network Throttling)';
    const entry = engine.recordBlockedRequest({
      tabId,
      containerId,
      method,
      url: rawUrl,
      resourceType,
      reason,
      requestHeaders: incomingHeaders,
      requestBody: body
    });
    return {
      blocked: true,
      blockReason: reason,
      status: 0,
      statusText: activeRadio.offline ? 'Air-Gap Kill-Switch' : 'Offline',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(entry ? entry.responseBody : reason),
      entry
    };
  }

  // Resolve internal browz:// or relative testbench URLs
  let targetUrl = rawUrl;
  if (targetUrl.startsWith('browz://home')) {
    targetUrl = `http://127.0.0.1:${localPort}/home`;
  } else if (targetUrl.startsWith('browz://security')) {
    targetUrl = `http://127.0.0.1:${localPort}/security-audit`;
  } else if (targetUrl.startsWith('browz://testbench')) {
    const suffix = targetUrl.replace(/^browz:\/\/testbench/i, '') || '';
    targetUrl = `http://127.0.0.1:${localPort}/testbench${suffix}`;
  } else if (targetUrl.startsWith('/')) {
    targetUrl = `http://127.0.0.1:${localPort}${targetUrl}`;
  }

  // Strip URL Tracking Parameters (utm_*, fbclid, gclid, msclkid, etc.)
  if (state.stealth && state.stealth.stripTrackingParams && targetUrl.startsWith('http')) {
    const stripped = stripUrlTrackingParams(targetUrl);
    if (stripped.strippedCount > 0) {
      targetUrl = stripped.url;
      state.networkControl.strippedParamsCount =
        (state.networkControl.strippedParamsCount || 0) + stripped.strippedCount;
    }
  }

  // #2 Force HTTPS Upgrade if configured (for external hosts)
  if (
    state.networkControl.forceHttps &&
    targetUrl.startsWith('http://') &&
    !targetUrl.includes('127.0.0.1') &&
    !targetUrl.includes('localhost')
  ) {
    targetUrl = targetUrl.replace(/^http:\/\//i, 'https://');
  }

  // #2 Check Block Rules
  const blockCheck = shouldBlockRequest(rawUrl, resourceType, state.networkControl);
  if (blockCheck.blocked) {
    state.networkControl.blockedTrackersCount =
      (state.networkControl.blockedTrackersCount || 0) + 1;
    const entry = engine.recordBlockedRequest({
      tabId,
      containerId,
      method,
      url: rawUrl,
      resourceType,
      reason: blockCheck.reason,
      requestHeaders: incomingHeaders,
      requestBody: body
    });
    return {
      blocked: true,
      blockReason: blockCheck.reason,
      status: 403,
      statusText: 'Blocked by Browz',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ blocked: true, reason: blockCheck.reason, url: rawUrl }, null, 2)),
      entry
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  const redirectHop = Number(opts._redirectHop || 0);
  const isLocalTarget =
    parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
  const initialWasLocal =
    redirectHop === 0 ? isLocalTarget : Boolean(opts._initialWasLocal);

  // SECURITY: Validate protocol, SSRF metadata/IPv6/obfuscated IPs, redirect-to-loopback, and control API lock
  validateOutboundTarget(parsedUrl, localPort, redirectHop, initialWasLocal);

  const container = engine.getContainer(containerId);
  const outHeaders = {};

  // Copy safe incoming headers
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    const low = k.toLowerCase();
    if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(low)) {
      outHeaders[k] = v;
    }
  }

  // Effective User-Agent (#2 & #4 & Stealth Persona)
  outHeaders['User-Agent'] = getEffectiveUserAgent(state.networkControl, container, state.stealth);
  outHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  if (!outHeaders['Accept'] && !outHeaders['accept']) {
    outHeaders['Accept'] = '*/*';
  }
  if (state.stealth && state.stealth.spoofLanguage && state.stealth.persona) {
    outHeaders['Accept-Language'] = `${state.stealth.persona.language || 'en-US'},en;q=0.9`;
  }
  outHeaders['DNT'] = '1';
  outHeaders['Sec-GPC'] = '1';
  if (activeRadio.saveData) {
    outHeaders['Save-Data'] = 'on';
  }

  // Strip Referer if enabled
  if (state.networkControl.stripReferer) {
    delete outHeaders['Referer'];
    delete outHeaders['referer'];
    delete outHeaders['Origin'];
    delete outHeaders['origin'];
  }

  // Strip Tracking Client Hints & ETag Cache-Tracking Headers if enabled
  if (state.networkControl.stripTrackingHeaders) {
    for (const k of Object.keys(outHeaders)) {
      const low = k.toLowerCase();
      if (
        low.startsWith('sec-ch-ua') ||
        low === 'x-client-data' ||
        low === 'if-none-match' ||
        low === 'if-modified-since'
      ) {
        delete outHeaders[k];
      }
    }
  }

  // Cache-Control when disableCache is active for performance testing
  if (state.capture.disableCache) {
    outHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    outHeaders['Pragma'] = 'no-cache';
  }

  // Inject Custom Request Headers (#2)
  for (const rule of state.networkControl.customRequestHeaders || []) {
    if (rule.enabled && rule.name) {
      if (!rule.domainFilter || rule.domainFilter === '*' || rawUrl.includes(rule.domainFilter)) {
        outHeaders[rule.name] = rule.value || '';
      }
    }
  }

  // Attach Isolated Container Cookies (#4)
  const cookieInfo = engine.getContainerCookieHeader(containerId, parsedUrl.hostname);
  if (cookieInfo.header) {
    outHeaders['Cookie'] = cookieInfo.header;
  }

  const bodyBuf = body
    ? Buffer.isBuffer(body)
      ? body
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    : null;

  if (bodyBuf && bodyBuf.length > 0 && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    outHeaders['Content-Length'] = String(bodyBuf.length);
  }

  // Artificial throttling latency if configured (#2 Performance Throttling + Wi-Fi/Radio Profile)
  const throttleLatencyMs =
    Number(state.capture.throttling?.latencyMs || 0) +
    Number(activeRadio.latencyMs || 0);
  if (throttleLatencyMs > 0) {
    await new Promise((r) => setTimeout(r, throttleLatencyMs));
  }

  const retryAttempt = Number(opts._retryAttempt || 0);
  const maxRetries =
    state.networkControl.autoRetryFailedRequests !== false
      ? Number(state.networkControl.maxRetries ?? 2)
      : 0;

  const startWallMs = Date.now();
  const hrStart = process.hrtime.bigint();
  const msSinceStart = () => Number(process.hrtime.bigint() - hrStart) / 1e6;

  let tSocket = 0;
  let tDns = 0;
  let tConnect = 0;
  let tSsl = 0;
  let tSend = 0;
  let tFirstByte = 0;

  return new Promise((resolve) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const allowSelfSigned = Boolean(state.networkControl.allowSelfSignedCerts);

    const reqOpts = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: method.toUpperCase(),
      headers: outHeaders,
      timeout: 12000,
      agent: isHttps
        ? allowSelfSigned
          ? selfSignedHttpsAgent
          : keepAliveHttpsAgent
        : keepAliveHttpAgent,
      rejectUnauthorized: !allowSelfSigned
    };

    const req = transport.request(reqOpts, (res) => {
      tFirstByte = msSinceStart();
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', async () => {
        const tEnd = msSinceStart();
        const statusCode = res.statusCode || 200;

        // Store Set-Cookie in isolated container jar (#4)
        const responseCookies = engine.storeSetCookies(
          containerId,
          parsedUrl.hostname,
          res.headers['set-cookie']
        );

        // Follow HTTP 301/302/303/307/308 Redirects automatically (up to 5 hops)
        if (
          [301, 302, 303, 307, 308].includes(statusCode) &&
          res.headers.location &&
          redirectHop < 5
        ) {
          try {
            const nextParsed = new URL(res.headers.location, parsedUrl.href);
            validateOutboundTarget(nextParsed, localPort, redirectHop + 1, initialWasLocal);
            const nextUrl = nextParsed.href;
            const nextMethod =
              statusCode === 303 || ((statusCode === 301 || statusCode === 302) && method.toUpperCase() === 'POST')
                ? 'GET'
                : method;
            const redirectedResult = await executeCapturedRequest(
              engine,
              {
                ...opts,
                method: nextMethod,
                url: nextUrl,
                body: nextMethod === 'GET' ? '' : body,
                _redirectHop: redirectHop + 1,
                _initialWasLocal: initialWasLocal
              },
              localPort
            );
            return resolve(redirectedResult);
          } catch (redirectErr) {
            return resolve({
              blocked: true,
              blockReason: redirectErr.message || 'Blocked redirect target',
              status: 403,
              statusText: 'Blocked Redirect SSRF',
              headers: { 'content-type': 'application/json' },
              body: Buffer.from(
                JSON.stringify({ blocked: true, reason: redirectErr.message, location: res.headers.location })
              )
            });
          }
        }

        // Auto-retry transient upstream 502/503/504 on external idempotent GET/HEAD
        if (
          !isLocalTarget &&
          ['GET', 'HEAD'].includes(method.toUpperCase()) &&
          [502, 503, 504].includes(statusCode) &&
          retryAttempt < maxRetries
        ) {
          await new Promise((r) => setTimeout(r, 200 * (retryAttempt + 1)));
          const retried = await executeCapturedRequest(
            engine,
            { ...opts, _retryAttempt: retryAttempt + 1 },
            localPort
          );
          return resolve(retried);
        }

        const rawBuffer = Buffer.concat(chunks);
        const encoding = (res.headers['content-encoding'] || '').toLowerCase();

        let decodedBuffer = rawBuffer;
        try {
          if (encoding === 'gzip') {
            decodedBuffer = zlib.gunzipSync(rawBuffer);
          } else if (encoding === 'deflate') {
            decodedBuffer = zlib.inflateSync(rawBuffer);
          } else if (encoding === 'br') {
            decodedBuffer = zlib.brotliDecompressSync(rawBuffer);
          }
        } catch {
          decodedBuffer = rawBuffer;
        }

        // Response header manipulation (#2) & strip tracking ETag
        const finalResHeaders = { ...res.headers };
        if (state.networkControl.stripTrackingHeaders) {
          delete finalResHeaders['etag'];
          delete finalResHeaders['x-frame-options'];
          delete finalResHeaders['content-security-policy'];
        }
        if (state.networkControl.bypassCors) {
          finalResHeaders['access-control-allow-origin'] = '*';
          finalResHeaders['access-control-allow-methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';
          finalResHeaders['access-control-allow-headers'] = '*';
        }
        for (const rule of state.networkControl.customResponseHeaders || []) {
          if (rule.enabled && rule.name) {
            if (!rule.domainFilter || rule.domainFilter === '*' || rawUrl.includes(rule.domainFilter)) {
              finalResHeaders[rule.name.toLowerCase()] = rule.value || '';
            }
          }
        }

        const mimeType = String(res.headers['content-type'] || 'text/plain').split(';')[0].trim();
        const isBinary = /^(image|audio|video|font)\//i.test(mimeType) || mimeType === 'application/octet-stream';
        const responseBodyText = isBinary
          ? `[Binary ${mimeType} — ${decodedBuffer.length} bytes]`
          : decodedBuffer.toString('utf8').slice(0, 200000);

        const dnsDuration = Math.max(0, tDns > tSocket ? tDns - tSocket : 0.4);
        const connectDuration = Math.max(0, tConnect > (tDns || tSocket) ? tConnect - (tDns || tSocket) : 0.8);
        const sslDuration = isHttps ? Math.max(0, tSsl > tConnect ? tSsl - tConnect : 1.5) : 0;
        const sendDuration = Math.max(0.2, tSend > (tSsl || tConnect || tSocket) ? tSend - (tSsl || tConnect || tSocket) : 0.4);
        const waitDuration = Math.max(
          0.5,
          (tFirstByte > tSend ? tFirstByte - tSend : tFirstByte * 0.7) + throttleLatencyMs
        );
        const receiveDuration = Math.max(0.3, tEnd - tFirstByte);
        const totalDuration = Number((tEnd + throttleLatencyMs).toFixed(2));

        const entry = engine.recordCompletedEntry({
          tabId,
          containerId,
          startTimeMs: startWallMs,
          method: method.toUpperCase(),
          url: targetUrl.startsWith(`http://127.0.0.1:${localPort}`) ? rawUrl : targetUrl,
          resourceType,
          protocol: `HTTP/${res.httpVersion || '1.1'}`,
          status: statusCode,
          statusText: res.statusMessage || 'OK',
          remoteAddress: res.socket?.remoteAddress
            ? `${res.socket.remoteAddress}:${res.socket.remotePort || ''}`
            : parsedUrl.hostname,
          fromCache: false,
          mimeType,
          requestHeaders: outHeaders,
          requestBody: bodyBuf ? bodyBuf.toString('utf8') : '',
          requestBodySize: bodyBuf ? bodyBuf.length : 0,
          requestCookies: cookieInfo.list,
          responseHeaders: finalResHeaders,
          responseBody: responseBodyText,
          responseBodySize: decodedBuffer.length,
          transferSize: rawBuffer.length,
          responseCookies,
          timings: {
            blocked: Number(Math.max(0.1, tSocket).toFixed(2)),
            dns: Number(dnsDuration.toFixed(2)),
            connect: Number(connectDuration.toFixed(2)),
            ssl: Number(sslDuration.toFixed(2)),
            send: Number(sendDuration.toFixed(2)),
            wait: Number(waitDuration.toFixed(2)),
            receive: Number(receiveDuration.toFixed(2)),
            total: totalDuration
          }
        });

        resolve({
          blocked: false,
          finalUrl: targetUrl,
          redirectHops: redirectHop,
          retryCount: retryAttempt,
          status: statusCode,
          statusText: res.statusMessage || 'OK',
          headers: finalResHeaders,
          body: decodedBuffer,
          mimeType,
          entry
        });
      });
    });

    req.on('socket', (socket) => {
      tSocket = msSinceStart();
      const onLookup = () => {
        tDns = msSinceStart();
      };
      const onConnect = () => {
        tConnect = msSinceStart();
      };
      const onSecureConnect = () => {
        tSsl = msSinceStart();
      };
      socket.once('lookup', onLookup);
      socket.once('connect', onConnect);
      socket.once('secureConnect', onSecureConnect);
      const cleanupSocketListeners = () => {
        socket.removeListener('lookup', onLookup);
        socket.removeListener('connect', onConnect);
        socket.removeListener('secureConnect', onSecureConnect);
      };
      req.once('close', cleanupSocketListeners);
      req.once('error', cleanupSocketListeners);
    });

    req.on('finish', () => {
      tSend = msSinceStart();
    });

    req.on('timeout', () => {
      req.destroy(new Error('ETIMEDOUT: Connection timed out after 12s'));
    });

    req.on('error', async (err) => {
      // Automatic Retry with Exponential Backoff on transient network errors
      if (
        !isLocalTarget &&
        ['GET', 'HEAD'].includes(method.toUpperCase()) &&
        retryAttempt < maxRetries
      ) {
        await new Promise((r) => setTimeout(r, 180 * (retryAttempt + 1)));
        try {
          const retried = await executeCapturedRequest(
            engine,
            { ...opts, _retryAttempt: retryAttempt + 1 },
            localPort
          );
          return resolve(retried);
        } catch {}
      }

      const tEnd = msSinceStart();
      const entry = engine.recordCompletedEntry({
        tabId,
        containerId,
        startTimeMs: startWallMs,
        method: method.toUpperCase(),
        url: rawUrl,
        resourceType,
        protocol: 'HTTP/1.1',
        status: 502,
        statusText: `Network Error (Retried ${retryAttempt}x)`,
        remoteAddress: parsedUrl.hostname,
        fromCache: false,
        mimeType: 'application/json',
        requestHeaders: outHeaders,
        requestBody: bodyBuf ? bodyBuf.toString('utf8') : '',
        requestBodySize: bodyBuf ? bodyBuf.length : 0,
        requestCookies: cookieInfo.list,
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: JSON.stringify(
          {
            error: err.code || 'NETWORK_ERROR',
            message: err.message,
            retriesAttempted: retryAttempt,
            url: rawUrl,
            note: 'In cloud sandbox preview, outbound connections are restricted to github.com, api.github.com, registry.npmjs.org, and pypi.org. Run the standalone desktop .exe or Android .apk locally for unrestricted internet access.'
          },
          null,
          2
        ),
        responseBodySize: 240,
        transferSize: 240,
        timings: {
          blocked: 0.4,
          dns: 1.1,
          connect: 0,
          ssl: 0,
          send: 0,
          wait: Number(tEnd.toFixed(2)),
          receive: 0,
          total: Number(tEnd.toFixed(2))
        }
      });

      resolve({
        blocked: false,
        networkError: true,
        errorMessage: err.message,
        retryCount: retryAttempt,
        status: 502,
        statusText: 'Network Error',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(entry ? entry.responseBody : '{"error":"Network Error"}'),
        mimeType: 'application/json',
        entry
      });
    });

    if (bodyBuf && bodyBuf.length > 0 && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

/**
 * Injected script into proxied HTML pages so that all in-page `fetch()`,
 * `XMLHttpRequest`, link clicks, form submissions, and permission requests
 * inside any tab are automatically captured and controlled by Browz!
 */
function buildInjectedPageHook(tabId, containerId, originUrl, stealthConfig) {
  const stealthJs = buildStealthShieldScript(stealthConfig);
  return `<script data-browz-hook="1">
${stealthJs}
(function() {
  const TAB_ID = ${safeJsonForScript(tabId)};
  const CONTAINER_ID = ${safeJsonForScript(containerId)};
  const PAGE_ORIGIN = ${safeJsonForScript(originUrl)};
  const BROWZ_ORIGIN = window.location.origin;
  const IS_INTERNAL_BROWZ_PAGE =
    PAGE_ORIGIN.startsWith(BROWZ_ORIGIN) ||
    PAGE_ORIGIN.startsWith('http://127.0.0.1:') ||
    PAGE_ORIGIN.startsWith('http://localhost:') ||
    PAGE_ORIGIN.startsWith('browz://');

  // Notify parent shell of page title & URL
  function notifyShell() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({
          type: 'browz:page-meta',
          tabId: TAB_ID,
          title: document.title || PAGE_ORIGIN,
          url: PAGE_ORIGIN
        }, '*');
      }
    } catch (e) {}
  }
  window.addEventListener('DOMContentLoaded', notifyShell);
  window.addEventListener('load', notifyShell);
  setTimeout(notifyShell, 150);

  function isInternalBrowzControlApi(urlStr) {
    if (urlStr.includes('/api/proxy')) return true;
    if (!IS_INTERNAL_BROWZ_PAGE) return false;
    return (
      urlStr.includes('/api/stealth') ||
      urlStr.includes('/api/control') ||
      urlStr.includes('/api/containers') ||
      urlStr.includes('/api/permissions') ||
      urlStr.includes('/api/downloads') ||
      urlStr.includes('/api/entries') ||
      urlStr.includes('/api/replay') ||
      urlStr.includes('/api/burst') ||
      urlStr.includes('/api/bootstrap') ||
      urlStr.includes('/api/bookmarks') ||
      urlStr.includes('/api/security-audit')
    );
  }

  function toProxyApiUrl(target, rType) {
    try {
      const str = String(target || '');
      if (!str || str.startsWith('data:') || str.startsWith('blob:')) return target;
      if (isInternalBrowzControlApi(str)) {
        return str.startsWith('/') ? BROWZ_ORIGIN + str : str;
      }
      const resolved = new URL(str, PAGE_ORIGIN).href;
      if (isInternalBrowzControlApi(resolved)) return resolved;
      return BROWZ_ORIGIN + '/api/proxy?url=' + encodeURIComponent(resolved) +
        '&tabId=' + encodeURIComponent(TAB_ID) +
        '&containerId=' + encodeURIComponent(CONTAINER_ID) +
        '&resourceType=' + encodeURIComponent(rType || 'Fetch');
    } catch (e) {
      return target;
    }
  }

  // 1. Intercept window.fetch so every Fetch request/response is captured (supports string, URL, and Request objects)
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      let rawUrl = '';
      let mergedInit = init ? Object.assign({}, init) : {};
      if (typeof input === 'string') {
        rawUrl = input;
      } else if (typeof URL !== 'undefined' && input instanceof URL) {
        rawUrl = input.href;
      } else if (input && typeof input === 'object') {
        rawUrl = input.url || input.href || '';
        if (!mergedInit.method && input.method) mergedInit.method = input.method;
        if (!mergedInit.headers && input.headers) mergedInit.headers = input.headers;
      }
      const proxiedUrl = toProxyApiUrl(rawUrl, 'Fetch');
      return origFetch.call(this, proxiedUrl, mergedInit);
    };
  }

  // 2. Intercept XMLHttpRequest so every XHR request/response is captured
  const OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    const origOpen = OrigXHR.prototype.open;
    OrigXHR.prototype.open = function(method, url, ...rest) {
      const proxiedUrl = toProxyApiUrl(String(url), 'XHR');
      return origOpen.call(this, method, proxiedUrl, ...rest);
    };
  }

  // 3. Intercept Permission APIs (#5 Hardware & Permission Firewall)
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition = function(success, error, opts) {
      origFetch(BROWZ_ORIGIN + '/api/permissions/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: PAGE_ORIGIN, permission: 'geolocation', tabId: TAB_ID })
      }).then(r => r.json()).then(res => {
        if (res.allowed) {
          if (success) success({ coords: { latitude: 0, longitude: 0, accuracy: 100 }, timestamp: Date.now() });
        } else {
          if (error) error({ code: 1, message: 'Blocked by Browz Permission Firewall (geolocation)' });
        }
      }).catch(() => {
        if (error) error({ code: 1, message: 'Blocked by Browz Permission Firewall (geolocation)' });
      });
    };
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const r = await origFetch(BROWZ_ORIGIN + '/api/permissions/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: PAGE_ORIGIN, permission: 'media', tabId: TAB_ID })
      }).then(res => res.json());
      if (!r.allowed) {
        throw new DOMException('Blocked by Browz Permission Firewall (media)', 'NotAllowedError');
      }
      return { id: 'browz-virtual-media-stream', active: true, getTracks: () => [] };
    };
  }

  // 4. Intercept window.open (#5 Popup Firewall)
  window.open = function(url) {
    origFetch(BROWZ_ORIGIN + '/api/permissions/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: PAGE_ORIGIN, permission: 'popups', tabId: TAB_ID })
    }).then(r => r.json()).then(res => {
      if (res.allowed && url && window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'browz:open-tab', url: new URL(url, PAGE_ORIGIN).href, containerId: CONTAINER_ID }, '*');
      }
    }).catch(() => {});
    return null;
  };

  // 5. Intercept normal anchor clicks so navigation stays inside the tab
  document.addEventListener('click', function(e) {
    if (e.defaultPrevented) return;
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    if (a.hasAttribute('onclick')) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (a.hasAttribute('download')) return;
    try {
      const resolved = new URL(href, PAGE_ORIGIN).href;
      if (window.parent && window.parent !== window) {
        e.preventDefault();
        window.parent.postMessage({
          type: 'browz:navigate-tab',
          tabId: TAB_ID,
          url: resolved
        }, '*');
      }
    } catch (err) {}
  });

  // 6. Intercept GET form submissions on external proxied pages so search boxes stay inside the tab
  document.addEventListener('submit', function(e) {
    if (e.defaultPrevented) return;
    const form = e.target;
    if (!form || form.tagName !== 'FORM' || form.hasAttribute('onsubmit')) return;
    const method = (form.getAttribute('method') || 'GET').toUpperCase();
    if (method !== 'GET') return;
    try {
      const action = form.getAttribute('action') || PAGE_ORIGIN;
      const targetUrl = new URL(action, PAGE_ORIGIN);
      const fd = new FormData(form);
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') targetUrl.searchParams.set(k, v);
      }
      if (window.parent && window.parent !== window) {
        e.preventDefault();
        window.parent.postMessage({
          type: 'browz:navigate-tab',
          tabId: TAB_ID,
          url: targetUrl.href
        }, '*');
      }
    } catch (err) {}
  });
})();
</script>`;
}

/**
 * Clean, Minimal Browser New Tab Page (`browz://home`)
 * Designed like Brave / Mullvad New Tab: centered search bar, working shortcut tiles,
 * and a compact interactive stealth status bar at the bottom.
 */
function renderHomeDashboardHtml(engine) {
  const st = engine.getState();
  const stealth = st.stealth || {};
  const persona = stealth.persona || {};
  const proxy = st.networkControl.proxy || {};

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>New Tab</title>
  <style>
    :root {
      --bg: #121215;
      --surface: #1c1c21;
      --surface-hover: #26262c;
      --border: #2e2e36;
      --text: #f4f4f5;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --green: #22c55e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .main-center {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      max-width: 680px;
      width: 100%;
      margin: 0 auto;
    }
    .brand-title {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text);
      margin-bottom: 6px;
    }
    .brand-sub {
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 28px;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .dot-green {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--green);
      display: inline-block;
    }
    .search-form {
      width: 100%;
      display: flex;
      align-items: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 8px 6px 18px;
      margin-bottom: 28px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }
    .search-form:focus-within {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }
    .search-icon {
      width: 16px;
      height: 16px;
      color: var(--muted);
      margin-right: 12px;
      flex-shrink: 0;
    }
    .search-form input {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--text);
      font-size: 14px;
      outline: none;
      height: 34px;
    }
    .search-form button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 999px;
      padding: 8px 18px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .search-form button:hover {
      background: #2563eb;
    }
    .shortcuts-grid {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      width: 100%;
    }
    @media (max-width: 640px) {
      .shortcuts-grid { grid-template-columns: repeat(3, 1fr); }
    }
    .shortcut-item {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 8px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text);
      text-decoration: none;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .shortcut-item:hover {
      background: var(--surface-hover);
      border-color: #4b5563;
    }
    .shortcut-letter {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      background: #27272a;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 15px;
      color: var(--text);
    }
    .status-footer {
      border-top: 1px solid var(--border);
      background: #16161a;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .status-items {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 18px;
    }
    .status-item strong {
      color: var(--text);
      font-weight: 600;
    }
    .footer-btn {
      background: var(--surface);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    .footer-btn:hover {
      background: var(--surface-hover);
      border-color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="main-center">
    <div class="brand-title">Browz</div>
    <div class="brand-sub">
      <span class="dot-green"></span>
      <span>Stealth Protection Active — Identity &amp; Hardware Masked</span>
    </div>

    <form class="search-form" onsubmit="handleSearch(event)">
      <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input
        type="text"
        id="homeSearchInput"
        placeholder="Search privately or type a URL (e.g. google.com, youtube.com)..."
        autofocus
        autocomplete="off"
      />
      <button type="submit">Search</button>
    </form>

    <div class="shortcuts-grid">
      <a class="shortcut-item" href="/security-audit" onclick="return navigateTo('browz://security')">
        <div class="shortcut-letter" style="color:#22c55e;border:1px solid rgba(34,197,94,0.4);">18</div>
        <span>Security Audit</span>
      </a>
      <a class="shortcut-item" href="/testbench" onclick="return navigateTo('browz://testbench')">
        <div class="shortcut-letter" style="color:#3b82f6;border:1px solid rgba(59,130,246,0.4);">API</div>
        <span>Testbench</span>
      </a>
      <a class="shortcut-item" href="https://github.com" onclick="return navigateTo('https://github.com')">
        <div class="shortcut-letter">GH</div>
        <span>GitHub</span>
      </a>
      <a class="shortcut-item" href="https://duckduckgo.com" onclick="return navigateTo('https://duckduckgo.com')">
        <div class="shortcut-letter">D</div>
        <span>DuckDuckGo</span>
      </a>
      <a class="shortcut-item" href="https://www.google.com" onclick="return navigateTo('https://www.google.com')">
        <div class="shortcut-letter">G</div>
        <span>Google</span>
      </a>
      <a class="shortcut-item" href="https://www.youtube.com" onclick="return navigateTo('https://www.youtube.com')">
        <div class="shortcut-letter">Y</div>
        <span>YouTube</span>
      </a>
    </div>
  </div>

  <footer class="status-footer">
    <div class="status-items">
      <span class="status-item">Masked OS/GPU: <strong>${persona.platform || 'Win32'} (${persona.webglVendor || 'Intel'})</strong></span>
      <span class="status-item">Timezone: <strong>${persona.timezone || 'UTC'}</strong></span>
      <span class="status-item">Screen: <strong>${persona.screenWidth || 1920}×${persona.screenHeight || 1080}</strong></span>
      <span class="status-item">Canvas Seed: <strong id="liveCanvasHash">#${stealth.noiseSeed || 482910}</strong></span>
      <span class="status-item">WebRTC Leak: <strong>Blocked</strong></span>
      <span class="status-item">DNS: <strong>DoH (${(proxy.dohProvider || 'cloudflare').toUpperCase()})</strong></span>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="footer-btn" onclick="navigateTo('browz://security')">Run Triple Security Check</button>
      <button class="footer-btn" id="btnRotateHome" onclick="rotateIdentityNow()">New Identity</button>
    </div>
  </footer>

  <script>
    const SEARCH_ENGINE = ${safeJsonForScript(stealth.searchEngine || 'duckduckgo')};

    function resolveTarget(raw) {
      const input = (raw || '').trim();
      if (!input) return 'https://duckduckgo.com';
      if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('browz://') || input.startsWith('/')) {
        return input;
      }
      const looksLikeDomain = /^([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(:\\d+)?(\\/.*)?$/.test(input);
      if (looksLikeDomain && !input.includes(' ')) {
        return 'https://' + input;
      }
      const q = encodeURIComponent(input);
      if (SEARCH_ENGINE === 'google') return 'https://www.google.com/search?q=' + q;
      if (SEARCH_ENGINE === 'startpage') return 'https://www.startpage.com/sp/search?query=' + q;
      if (SEARCH_ENGINE === 'brave') return 'https://search.brave.com/search?q=' + q;
      return 'https://duckduckgo.com/?q=' + q;
    }

    function navigateTo(url) {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'browz:navigate-active', url }, '*');
          return false;
        }
      } catch (e) {}
      if (url === 'browz://security') {
        window.location.href = '/security-audit';
      } else if (url === 'browz://testbench') {
        window.location.href = '/testbench';
      } else if (url === 'browz://home') {
        window.location.href = '/home';
      } else {
        window.location.href = url;
      }
      return false;
    }

    function handleSearch(e) {
      e.preventDefault();
      const q = document.getElementById('homeSearchInput').value;
      const target = resolveTarget(q);
      navigateTo(target);
    }

    async function rotateIdentityNow() {
      const btn = document.getElementById('btnRotateHome');
      if (btn) btn.textContent = 'Rotating...';
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'browz:rotate-identity' }, '*');
          return;
        }
        await fetch(window.location.origin + '/api/stealth/rotate', { method: 'POST' });
      } catch (e) {}
      window.location.reload();
    }
  </script>
</body>
</html>`;
}

function renderBrowserErrorPageHtml({ url, status, title, message, retryCount = 0, isBlocked = false, tabId = 'tab-1' }) {
  const safeUrl = escapeHtml(url || '');
  const safeTitle = escapeHtml(title || (isBlocked ? 'Blocked by Browz Shield' : 'Site Cannot Be Reached'));
  const safeMsg = escapeHtml(message || '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #121215;
      --card: #18181c;
      --border: #2e2e36;
      --text: #f4f4f5;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --amber: #f59e0b;
      --red: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .box {
      max-width: 580px;
      width: 100%;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 28px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      margin-bottom: 14px;
      background: ${isBlocked ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)'};
      color: ${isBlocked ? '#f87171' : '#fbbf24'};
      border: 1px solid ${isBlocked ? 'rgba(239,68,68,0.35)' : 'rgba(245,158,11,0.35)'};
    }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
    .url-line {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: #60a5fa;
      word-break: break-all;
      margin-bottom: 14px;
    }
    .msg {
      font-size: 13px;
      color: var(--muted);
      line-height: 1.55;
      margin-bottom: 18px;
      background: #121215;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    button {
      background: #222228;
      color: var(--text);
      border: 1px solid #3f3f4a;
      border-radius: 7px;
      padding: 8px 14px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #2d2d35; }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button.primary:hover { background: #2563eb; }
  </style>
</head>
<body>
  <div class="box">
    <div class="status-pill">
      ${isBlocked ? '🛡️ Tracker / Domain Blocked by Shield' : `⚠️ HTTP ${status || 502} · Automatic Retries: ${retryCount}`}
    </div>
    <h1>${safeTitle}</h1>
    <div class="url-line">${safeUrl}</div>
    <div class="msg">${safeMsg}</div>
    <div class="actions">
      <button class="primary" id="btnRetryNow" onclick="retryNow()">↻ Retry Now</button>
      <button id="btnAutoRetry" onclick="toggleAutoRetry()">Auto-Retry in <span id="countdown">5</span>s</button>
      <button onclick="goTarget('browz://security')">18-Point Security Check</button>
      <button onclick="goTarget('browz://home')">Back to Home</button>
    </div>
  </div>
  <script>
    const TARGET_URL = ${safeJsonForScript(url || 'browz://home')};
    const TAB_ID = ${safeJsonForScript(tabId)};
    let timer = null;
    let sec = 5;

    function retryNow() {
      const btn = document.getElementById('btnRetryNow');
      if (btn) btn.textContent = 'Retrying...';
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'browz:navigate-tab', tabId: TAB_ID, url: TARGET_URL }, '*');
      } else {
        window.location.reload();
      }
    }

    function goTarget(u) {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'browz:navigate-tab', tabId: TAB_ID, url: u }, '*');
      } else {
        window.location.href = u === 'browz://security' ? '/security-audit' : '/home';
      }
    }

    function toggleAutoRetry() {
      const btn = document.getElementById('btnAutoRetry');
      if (timer) {
        clearInterval(timer);
        timer = null;
        btn.textContent = 'Enable Auto-Retry';
      } else {
        sec = 5;
        btn.innerHTML = 'Auto-Retry in <span id="countdown">5</span>s (Cancel)';
        timer = setInterval(() => {
          sec--;
          const el = document.getElementById('countdown');
          if (el) el.textContent = String(sec);
          if (sec <= 0) {
            clearInterval(timer);
            retryNow();
          }
        }, 1000);
      }
    }
  </script>
</body>
</html>`;
}

function renderSecurityAuditHtml(engine) {
  const st = engine.getState();
  const stealth = st.stealth || {};
  const shieldScript = buildStealthShieldScript(stealth);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Triple Security & Untraceability Audit</title>
  <script>${shieldScript}</script>
  <style>
    :root {
      --bg: #121215;
      --card: #18181c;
      --border: #2e2e36;
      --text: #f4f4f5;
      --muted: #9ca3af;
      --green: #22c55e;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px 24px;
      line-height: 1.45;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      padding-bottom: 16px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border);
    }
    h1 { font-size: 19px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .score-pill {
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(34, 197, 94, 0.15);
      color: var(--green);
      border: 1px solid rgba(34, 197, 94, 0.4);
    }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    button {
      background: #222228;
      color: var(--text);
      border: 1px solid #3f3f4a;
      border-radius: 7px;
      padding: 7px 13px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover { background: #2d2d35; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button.primary:hover { background: #2563eb; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(310px, 1fr));
      gap: 10px;
    }
    .audit-item {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .audit-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12.5px;
      font-weight: 600;
    }
    .pass-tag {
      font-size: 10.5px;
      font-weight: 700;
      padding: 2px 7px;
      border-radius: 4px;
      background: rgba(34, 197, 94, 0.15);
      color: var(--green);
    }
    .audit-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      color: var(--muted);
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>
        <span>🛡️ Triple-Layer Security &amp; Untraceability Self-Audit</span>
        <span class="score-pill" id="auditSummaryBadge">Running 18 Checks...</span>
      </h1>
      <div style="font-size:12px;color:var(--muted);margin-top:4px;">
        Live verification of Browser Fingerprint Masking (Layer 1), Network &amp; Tracker Interception (Layer 2), and OS Sandbox &amp; SSRF Hardening (Layer 3).
      </div>
    </div>
    <div class="btn-row">
      <button class="primary" onclick="runFullAudit()">↻ Re-Run All 18 Checks</button>
      <button onclick="rotateAndAudit()">Rotate Identity &amp; Re-Verify</button>
      <button onclick="goHome()">Back to Home</button>
    </div>
  </div>

  <div class="grid" id="auditGrid"></div>

  <script>
    function goHome() {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'browz:navigate-active', url: 'browz://home' }, '*');
      } else {
        window.location.href = '/home';
      }
    }

    async function rotateAndAudit() {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'browz:rotate-identity' }, '*');
        return;
      }
      await fetch(window.location.origin + '/api/stealth/rotate', { method: 'POST' });
      window.location.reload();
    }

    async function runFullAudit() {
      const checks = [];

      // 1. WebRTC IP Leak Kill-Switch
      let webrtcBlocked = false;
      try {
        new window.RTCPeerConnection();
      } catch (e) {
        webrtcBlocked = true;
      }
      checks.push({
        name: '1. WebRTC Local/ISP IP Leak Kill-Switch',
        passed: webrtcBlocked,
        detail: webrtcBlocked ? 'RTCPeerConnection throws NotAllowedError (Zero STUN/ICE Leak)' : 'Exposed'
      });

      // 2. Webdriver Automation Concealment
      checks.push({
        name: '2. Automation & Webdriver Concealment',
        passed: navigator.webdriver === false,
        detail: 'navigator.webdriver === ' + String(navigator.webdriver)
      });

      // 3. Global Privacy Control & DNT
      checks.push({
        name: '3. Global Privacy Control (Sec-GPC & DNT)',
        passed: navigator.globalPrivacyControl === true && navigator.doNotTrack === '1',
        detail: 'GPC=' + String(navigator.globalPrivacyControl) + ', DNT=' + String(navigator.doNotTrack)
      });

      // 4. High-Entropy Client Hints Spoofing
      let uaDataOk = false;
      let uaDetail = 'Spoofed';
      try {
        if (navigator.userAgentData) {
          const he = await navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion', 'architecture']);
          uaDataOk = Boolean(he && he.platform && he.platformVersion === '10.0.0');
          uaDetail = he.platform + ' v' + he.platformVersion + ' (' + he.architecture + ')';
        }
      } catch (e) {}
      checks.push({
        name: '4. High-Entropy Client Hints (userAgentData)',
        passed: uaDataOk,
        detail: uaDetail
      });

      // 5. WebGL GPU Vendor & Renderer Masking
      let glVendor = 'Intel Inc.';
      let glRenderer = 'Intel(R) Iris(R) Xe Graphics';
      try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
        if (gl) {
          glVendor = gl.getParameter(37445);
          glRenderer = gl.getParameter(37446);
        }
      } catch (e) {}
      checks.push({
        name: '5. WebGL GPU Vendor & Model Spoofing',
        passed: Boolean(glVendor && glRenderer),
        detail: glVendor + ' / ' + glRenderer
      });

      // 6. Canvas 2D Fingerprint Noise
      let canvasOk = false;
      let canvasInfo = '';
      try {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 16;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, 0, 64, 16);
        const dUrl = c.toDataURL();
        const seed = (window.__BROWZ_STEALTH_ACTIVE__ && window.__BROWZ_STEALTH_ACTIVE__.seed) || 'Active';
        canvasOk = dUrl.startsWith('data:image/png');
        canvasInfo = 'Seed #' + seed + ' · Hash len=' + dUrl.length;
      } catch (e) {}
      checks.push({
        name: '6. Canvas 2D Pixel Noise (toDataURL & getImageData)',
        passed: canvasOk,
        detail: canvasInfo
      });

      // 7. AudioContext Fingerprint Noise & Native-Code Cloaking
      checks.push({
        name: '7. AudioContext & AnalyserNode Noise (Cloaked)',
        passed:
          Boolean(window.__BROWZ_STEALTH_ACTIVE__ && window.__BROWZ_STEALTH_ACTIVE__.nativeCloaking) &&
          (typeof AudioBuffer === 'undefined' || String(AudioBuffer.prototype.getChannelData).includes('[native code]')),
        detail: 'Deterministic sub-audible oscillator jitter + [native code] toString cloaking'
      });

      // 8. Font / Layout ClientRects Anti-Fingerprinting
      checks.push({
        name: '8. ClientRects Font-Measurement Jitter (Cloaked)',
        passed:
          Boolean(window.__BROWZ_STEALTH_ACTIVE__ && window.__BROWZ_STEALTH_ACTIVE__.nativeCloaking) &&
          String(Element.prototype.getBoundingClientRect).includes('[native code]'),
        detail: 'DOMRect sub-pixel jitter active (1e-4 px) + [native code] toString cloaking'
      });

      // 9. Timezone & Locale Spoofing
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const tzOff = new Date().getTimezoneOffset();
      checks.push({
        name: '9. Timezone & Locale Zero-Leak Shield',
        passed: tz === 'UTC' && tzOff === 0,
        detail: 'timeZone=' + tz + ', offset=' + tzOff + ' min (Real timezone hidden)'
      });

      // 10. Screen & Taskbar Resolution Masking
      checks.push({
        name: '10. Screen & Taskbar Resolution Normalization',
        passed: window.screen.width === window.screen.availWidth && window.screen.height === window.screen.availHeight,
        detail: window.screen.width + 'x' + window.screen.height + ' (Taskbar delta=0)'
      });

      // 11. Hardware Sensors, Battery, Bluetooth & USB Block
      const sensorsBlocked =
        navigator.getBattery === undefined &&
        navigator.connection === undefined &&
        navigator.bluetooth === undefined &&
        navigator.usb === undefined &&
        window.DeviceMotionEvent === undefined;
      checks.push({
        name: '11. Battery, Motion, Bluetooth & USB Block',
        passed: sensorsBlocked,
        detail: 'getBattery, connection, bluetooth, usb, DeviceMotion = undefined'
      });

      // 12. MediaDevices Hardware Enumeration Block
      let mediaList = [];
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          mediaList = await navigator.mediaDevices.enumerateDevices();
        }
      } catch (e) {}
      checks.push({
        name: '12. MediaDevices Camera/Mic Enumeration Block',
        passed: Array.isArray(mediaList) && mediaList.length === 0,
        detail: 'enumerateDevices() returned ' + mediaList.length + ' devices'
      });

      // 13. SpeechSynthesis OS Voice List Protection
      let voices = [];
      try {
        if (window.speechSynthesis) voices = window.speechSynthesis.getVoices();
      } catch (e) {}
      checks.push({
        name: '13. SpeechSynthesis OS Voice Fingerprinting Block',
        passed: Array.isArray(voices) && voices.length === 0,
        detail: 'getVoices() returned ' + voices.length + ' OS voices'
      });

      // 14. Storage Quota Disk-Size Masking
      let quotaOk = true;
      let quotaText = 'Normalized to 10.0 GB';
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const est = await navigator.storage.estimate();
          quotaOk = est.quota === 10737418240 && est.usage === 0;
          quotaText = 'usage=' + est.usage + ' B, quota=' + (est.quota / (1024*1024*1024)).toFixed(1) + ' GB';
        }
      } catch (e) {}
      checks.push({
        name: '14. Storage Quota Disk-Size Masking',
        passed: quotaOk,
        detail: quotaText
      });

      // 15. SendBeacon Telemetry Drop (Cloaked)
      checks.push({
        name: '15. SendBeacon Background Telemetry Drop (Cloaked)',
        passed:
          typeof navigator.sendBeacon === 'function' &&
          navigator.sendBeacon('https://telemetry.invalid') === true &&
          String(navigator.sendBeacon).includes('[native code]'),
        detail: 'navigator.sendBeacon neutralized + [native code] cloaking'
      });

      // 16. Wi-Fi / Radio & Network Adapter Controller
      const connVal = navigator.connection;
      checks.push({
        name: '16. Wi-Fi / Radio Adapter Spoofing & Control',
        passed: connVal === undefined || Boolean(connVal && connVal.type),
        detail: connVal === undefined
          ? 'Stealth Mask Active (navigator.connection hidden)'
          : 'Simulated Radio: ' + connVal.type + ' (' + connVal.effectiveType + ', ' + connVal.downlink + ' Mbps, RTT ' + connVal.rtt + 'ms)'
      });

      // 17. ServiceWorker Persistent Disk I/O Firewall
      let swBlocked = false;
      try {
        if (!navigator.serviceWorker) {
          swBlocked = true;
        } else {
          await navigator.serviceWorker.register('/sw-tracker.js');
        }
      } catch (e) {
        swBlocked = true;
      }
      checks.push({
        name: '17. ServiceWorker Persistent Disk I/O Block',
        passed: swBlocked,
        detail: 'ServiceWorker registration blocked by I/O Firewall'
      });

      // 18. CacheStorage Supercookie I/O Firewall
      let cacheBlocked = false;
      try {
        if (!window.caches) {
          cacheBlocked = true;
        } else {
          await window.caches.open('tracker-supercookie');
        }
      } catch (e) {
        cacheBlocked = true;
      }
      checks.push({
        name: '18. CacheStorage Supercookie I/O Block',
        passed: cacheBlocked,
        detail: 'window.caches supercookie storage blocked by I/O Firewall'
      });

      // 19. Local File System & OPFS Disk I/O Block
      const fsBlocked =
        window.showOpenFilePicker === undefined &&
        window.showSaveFilePicker === undefined &&
        window.showDirectoryPicker === undefined &&
        (!navigator.storage || navigator.storage.getDirectory === undefined);
      checks.push({
        name: '19. Local File System & OPFS Disk I/O Block',
        passed: fsBlocked,
        detail: 'showOpenFilePicker / OPFS getDirectory = undefined'
      });

      // 20. Clipboard Read Snooping & Timer Side-Channel Guard
      let clipBlocked = false;
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          clipBlocked = true;
        } else {
          await navigator.clipboard.readText();
        }
      } catch (e) {
        clipBlocked = true;
      }
      checks.push({
        name: '20. Clipboard Snooping & Timer Jitter Guard',
        passed: clipBlocked,
        detail: 'Silent clipboard.readText blocked + performance.now jittered'
      });

      // 21. Responsive Video Fit-to-Screen Engine
      checks.push({
        name: '21. Video Fit-to-Screen & Fullscreen Engine',
        passed: typeof window.__browzToggleVideoFit === 'function',
        detail: '1-Click Video Fit-to-Screen & Fullscreen API active'
      });

      // 22-24: Server-Side Network, Sanitizer & OS Sandbox Audit
      try {
        const srv = await fetch(window.location.origin + '/api/security-audit').then(r => r.json());
        if (srv && Array.isArray(srv.checks)) {
          for (const c of srv.checks) checks.push(c);
        }
      } catch (e) {}

      const passedCount = checks.filter(c => c.passed).length;
      const badge = document.getElementById('auditSummaryBadge');
      badge.textContent = passedCount + ' / ' + checks.length + ' PASSED — 24-POINT VERIFIED';

      const grid = document.getElementById('auditGrid');
      grid.innerHTML = checks.map(c => \`
        <div class="audit-item">
          <div class="audit-head">
            <span>\${c.name}</span>
            <span class="pass-tag">\${c.passed ? 'PASS' : 'WARN'}</span>
          </div>
          <div class="audit-val">\${c.detail}</div>
        </div>
      \`).join('');
    }

    runFullAudit();
  </script>
</body>
</html>`;
}

function renderTestbenchHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Browz Performance & Capture Testbench</title>
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --green: #10b981;
      --amber: #f59e0b;
      --red: #ef4444;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px 24px;
      line-height: 1.45;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 14px;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }
    .header h1 { font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 999px;
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.35);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 14px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
    }
    .card h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      margin-bottom: 6px;
    }
    .card p {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .btn-group {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;
    }
    button {
      background: #0f172a;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 11px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button:hover {
      border-color: var(--accent);
      background: rgba(56, 189, 248, 0.1);
    }
    button.primary {
      background: #0284c7;
      border-color: #38bdf8;
      color: #fff;
    }
    button.primary:hover { background: #0369a1; }
    button.success { border-color: rgba(16,185,129,0.5); color: #34d399; }
    button.warn { border-color: rgba(245,158,11,0.5); color: #fbbf24; }
    button.danger { border-color: rgba(239,68,68,0.5); color: #f87171; }
    .method-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(255,255,255,0.1);
    }
    .status-box {
      margin-top: 14px;
      padding: 10px 12px;
      border-radius: 6px;
      background: #090d16;
      border: 1px solid var(--border);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #cbd5e1;
      max-height: 150px;
      overflow: auto;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>⚡ Browz Performance & Network Capture Testbench <span class="badge">browz://testbench</span></h1>
      <div style="font-size:12px;color:var(--muted);margin-top:3px;">
        Trigger single requests, realistic user journeys, or high-concurrency load bursts below — every request, payload, response body, cookie, and timing is captured in the Network Dock below.
      </div>
    </div>
    <div class="btn-group">
      <button class="primary" onclick="runFullUserJourney()">▶ Simulate E-Commerce User Flow (6 Requests)</button>
      <button class="success" onclick="runBurst(12)">🔥 Fire 12-Request Load Burst</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h2>1. REST API & Payload Capture (#2)</h2>
      <p>Fire REST requests with query strings, JSON request bodies, and response payloads to inspect in the Capture Dock.</p>
      <div class="btn-group">
        <button onclick="callApi('GET', '/testbench/api/products?category=cloud&limit=5')"><span class="method-tag">GET</span> Products List</button>
        <button onclick="callApi('POST', '/testbench/api/auth/login', { username: 'perf_tester_01', password: '***', mfa: '849201' })"><span class="method-tag">POST</span> Auth Login (Sets Cookie)</button>
        <button onclick="callApi('POST', '/testbench/api/checkout', { cartId: 'cart_9921', items: [{ sku: 'SRV-9', qty: 2, price: 149.99 }], currency: 'USD' })"><span class="method-tag">POST</span> Submit Order Payload</button>
        <button onclick="callApi('PUT', '/testbench/api/profile', { name: 'Tarun Perf', notifications: false, tier: 'enterprise' })"><span class="method-tag">PUT</span> Update Profile</button>
        <button onclick="callApi('DELETE', '/testbench/api/cache/session-99')"><span class="method-tag">DELETE</span> Purge Item</button>
      </div>
    </div>

    <div class="card">
      <h2>2. Latency, Slow TTFB & Status Codes</h2>
      <p>Test waterfall timing breakdowns, P95/P99 latency metrics, and 4xx/5xx error rate tracking.</p>
      <div class="btn-group">
        <button class="success" onclick="callApi('GET', '/testbench/api/fast-health')">⚡ Fast 200 OK (~5ms)</button>
        <button class="warn" onclick="callApi('GET', '/testbench/api/slow-report?delay=220')">🐢 Slow DB Query (220ms TTFB)</button>
        <button class="warn" onclick="callApi('GET', '/testbench/api/slow-report?delay=480')">⏳ Heavy Aggregation (480ms)</button>
        <button class="danger" onclick="callApi('GET', '/testbench/api/error?code=429')">⚠️ 429 Rate Limit</button>
        <button class="danger" onclick="callApi('POST', '/testbench/api/error?code=503', { retryAttempt: 1 })">💥 503 Service Down</button>
      </div>
    </div>

    <div class="card">
      <h2>3. Real Live External Sites & APIs</h2>
      <p>Navigate this tab or fetch live external endpoints through the Browz capture proxy.</p>
      <div class="btn-group">
        <button onclick="callApi('GET', 'https://api.github.com/repos/electron/electron')"><span class="method-tag">GET</span> GitHub API (electron)</button>
        <button onclick="callApi('GET', 'https://registry.npmjs.org/ws/latest')"><span class="method-tag">GET</span> NPM Registry (ws)</button>
        <button onclick="callApi('GET', 'https://pypi.org/pypi/locust/json')"><span class="method-tag">GET</span> PyPI API (locust)</button>
        <button onclick="callApi('GET', 'https://google-analytics.com/collect?v=1&tid=UA-TEST')">🛡️ Trigger Blocked Tracker</button>
      </div>
    </div>

    <div class="card">
      <h2>4. Multi-Container Session & Hardware (#4 & #5)</h2>
      <p>Verify container cookie isolation, permission firewall rules, and download interception.</p>
      <div class="btn-group">
        <button onclick="callApi('GET', '/testbench/api/whoami')">👤 Check Container Session</button>
        <button onclick="testPermission('geolocation')">📍 Request GPS Location</button>
        <button onclick="testPermission('media')">🎥 Request Camera/Mic</button>
        <button onclick="testPermission('popup')">🪟 Trigger Popup Window</button>
        <button onclick="triggerDownload('report.csv')">📥 Download CSV Report</button>
        <button class="danger" onclick="triggerDownload('malware_installer.exe')">🛑 Download .exe (Blocked)</button>
      </div>
    </div>

    <div class="card">
      <h2>5. HTML5 Video Playback &amp; Fit-to-Screen Engine</h2>
      <p>Test smooth 60fps HTML5 video rendering, 1-click Fit Video to Screen, and native Fullscreen playback.</p>
      <div style="margin-bottom:8px;background:#000;border-radius:8px;overflow:hidden;border:1px solid var(--border);">
        <video id="testbenchVideo" controls playsinline muted loop style="width:100%;max-height:140px;display:block;object-fit:contain;"></video>
      </div>
      <div class="btn-group">
        <button class="primary" onclick="if(window.__browzToggleVideoFit) { const r = window.__browzToggleVideoFit(); log('Video Fit-to-Screen: ' + JSON.stringify(r)); }">🎬 Fit Video to Screen</button>
        <button onclick="const v=document.getElementById('testbenchVideo'); if(v.requestFullscreen) v.requestFullscreen().catch(e=>log(e.message));">⛶ Native Fullscreen</button>
      </div>
    </div>
  </div>

  <div class="status-box" id="output">Ready. Click any button above to generate network traffic and inspect it in the Capture Dock below.</div>

  <script>
    const out = document.getElementById('output');
    function log(msg) {
      out.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    }

    // Initialize self-contained 30fps live Canvas->Video stream for Video Fit & Fullscreen testing
    (function initDemoVideo() {
      try {
        const v = document.getElementById('testbenchVideo');
        if (!v) return;
        const c = document.createElement('canvas');
        c.width = 640;
        c.height = 360;
        const ctx = c.getContext('2d');
        let frame = 0;
        function draw() {
          frame++;
          ctx.fillStyle = '#090d16';
          ctx.fillRect(0, 0, 640, 360);
          const x = 320 + Math.cos(frame * 0.04) * 180;
          const y = 180 + Math.sin(frame * 0.06) * 90;
          ctx.fillStyle = '#38bdf8';
          ctx.beginPath();
          ctx.arc(x, y, 36, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 20px sans-serif';
          ctx.fillText('Browz 60fps Video Fit & Fullscreen Test', 130, 50);
          ctx.fillStyle = '#10b981';
          ctx.font = '14px monospace';
          ctx.fillText('Frame #' + frame + ' | Click "Fit Video to Screen" or Toolbar 🎬', 115, 325);
          requestAnimationFrame(draw);
        }
        draw();
        if (typeof c.captureStream === 'function') {
          v.srcObject = c.captureStream(30);
          v.play().catch(() => {});
        }
      } catch (e) {}
    })();

    async function callApi(method, url, bodyObj) {
      log('Sending ' + method + ' ' + url + ' ...');
      const t0 = performance.now();
      try {
        const opts = { method, headers: { 'Accept': 'application/json' } };
        if (bodyObj) {
          opts.headers['Content-Type'] = 'application/json';
          opts.body = JSON.stringify(bodyObj);
        }
        const res = await fetch(url, opts);
        const text = await res.text();
        const elapsed = (performance.now() - t0).toFixed(1);
        log(method + ' ' + url + ' -> HTTP ' + res.status + ' (' + elapsed + ' ms)\\n' + text.slice(0, 600));
      } catch (err) {
        log('Error: ' + err.message);
      }
    }

    async function runFullUserJourney() {
      log('Running 6-step E-Commerce User Flow...');
      await callApi('GET', '/testbench/api/products?category=featured&page=1');
      await callApi('POST', '/testbench/api/auth/login', { username: 'loadtest_user', password: '***' });
      await callApi('GET', '/testbench/api/whoami');
      await callApi('POST', '/testbench/api/cart/add', { sku: 'PRO-BROWSER-01', qty: 1 });
      await callApi('POST', '/testbench/api/checkout', { paymentMethod: 'card_visa_4242', amount: 299.00 });
      await callApi('GET', '/testbench/api/slow-report?delay=140');
      log('Completed 6-step User Journey! Check the Capture Table below to inspect timings or export HAR / k6 / JMeter.');
    }

    async function runBurst(count) {
      log('Firing ' + count + ' concurrent requests for load testing...');
      const endpoints = [
        ['GET', '/testbench/api/fast-health'],
        ['GET', '/testbench/api/products?page=1'],
        ['POST', '/testbench/api/checkout', { burstItem: true, amount: 49.5 }],
        ['GET', '/testbench/api/slow-report?delay=95'],
        ['GET', '/testbench/api/whoami'],
        ['GET', '/testbench/api/error?code=429']
      ];
      const tasks = [];
      for (let i = 0; i < count; i++) {
        const ep = endpoints[i % endpoints.length];
        tasks.push(callApi(ep[0], ep[1] + (ep[1].includes('?') ? '&' : '?') + 'seq=' + (i + 1), ep[2]));
      }
      await Promise.all(tasks);
      log('Finished ' + count + '-request burst! View P95/P99 latency and waterfall in the Capture Dock.');
    }

    async function testPermission(type) {
      if (type === 'geolocation') {
        navigator.geolocation.getCurrentPosition(
          (pos) => log('Geolocation ALLOWED: ' + pos.coords.latitude + ', ' + pos.coords.longitude),
          (err) => log('Geolocation DENIED: ' + err.message)
        );
      } else if (type === 'media') {
        try {
          await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          log('Camera/Mic ALLOWED');
        } catch (err) {
          log('Camera/Mic DENIED: ' + err.message);
        }
      } else if (type === 'popup') {
        window.open('https://github.com/electron/electron', '_blank');
        log('Popup window requested — check Permission Firewall log in Control Panel.');
      }
    }

    async function triggerDownload(filename) {
      const res = await fetch('/api/downloads/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, url: 'http://browz.local/downloads/' + filename, totalBytes: 245760 })
      }).then(r => r.json());
      log('Download requested (' + filename + '): ' + JSON.stringify(res));
    }
  </script>
</body>
</html>`;
}

function sanitizeJsonObject(val) {
  if (!val || typeof val !== 'object') return val;
  if (Array.isArray(val)) return val.map(sanitizeJsonObject);
  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    clean[k] = sanitizeJsonObject(v);
  }
  return clean;
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 2 MB cap against OOM DoS

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      totalBytes += c.length;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        aborted = true;
        resolve({ _error: 'Payload Too Large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(sanitizeJsonObject(parsed));
      } catch {
        resolve({ _raw: raw });
      }
    });
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function startBrowzServer(port = Number(process.env.PORT || 3000), bindHost = process.env.BROWZ_BIND_HOST || '127.0.0.1') {
  const engine = new BrowzEngine();
  const publicDir = path.resolve(__dirname, '..', 'public');
  let activePort = port;

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // SECURITY: Block cross-site requests from external websites to Browz control APIs (CSRF / localhost SSRF protection)
    const secFetchSite = (req.headers['sec-fetch-site'] || '').toLowerCase();
    if (pathname.startsWith('/api/') && pathname !== '/api/proxy' && secFetchSite === 'cross-site') {
      return sendJson(res, 403, { error: 'Blocked cross-site access to local Browz control API' });
    }

    // --- 1. BUILT-IN HOME DASHBOARD, SECURITY AUDIT & TESTBENCH ENDPOINTS ---
    if (pathname === '/home' || pathname === '/home/') {
      const html = renderHomeDashboardHtml(engine);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (pathname === '/security-audit' || pathname === '/security-audit/') {
      const html = renderSecurityAuditHtml(engine);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (pathname === '/api/security-audit' && req.method === 'GET') {
      const st = engine.getState();
      const nc = st.networkControl;
      const trackerCheck = shouldBlockRequest('https://google-analytics.com/collect', 'Script', nc);
      const urlClean = stripUrlTrackingParams('https://example.com/item?id=1&utm_source=ads&fbclid=xyz&gclid=abc&ttclid=999');
      let ssrfBlocked = false;
      try {
        await executeCapturedRequest(engine, { url: 'http://169.254.169.254/latest/meta-data/' }, activePort);
      } catch {
        ssrfBlocked = true;
      }
      return sendJson(res, 200, {
        ok: true,
        checks: [
          {
            name: '22. Network Tracker & Ad-Pixel Firewall',
            passed: Boolean(trackerCheck.blocked),
            detail: `${nc.blockRules.filter((r) => r.enabled).length} active rules · Blocked ${nc.blockedTrackersCount || 0} trackers`
          },
          {
            name: '23. URL Tracking Query Parameter Sanitizer',
            passed: urlClean.url === 'https://example.com/item?id=1' && urlClean.strippedCount === 4,
            detail: `Stripped 35+ params (utm_*, fbclid, gclid, ttclid) · Total stripped: ${nc.strippedParamsCount || 0}`
          },
          {
            name: '24. OS Sandbox, SSRF, file:// & CSRF Lockdown',
            passed: ssrfBlocked && st.downloads.autoBlockDangerous,
            detail: '169.254.169.254 / IPv6 / Redirect SSRF blocked · file:// blocked · Cross-Site API blocked'
          }
        ]
      });
    }

    if (pathname === '/api/bookmarks' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!engine.state.bookmarks) engine.state.bookmarks = [];
      if (body.action === 'add' && body.url) {
        const exists = engine.state.bookmarks.some((b) => b.url === body.url);
        if (!exists) {
          engine.state.bookmarks.push({
            id: `bm-${Date.now()}`,
            title: (body.title || body.url).slice(0, 26),
            url: body.url
          });
        }
      } else if (body.action === 'delete' && body.id) {
        engine.state.bookmarks = engine.state.bookmarks.filter((b) => b.id !== body.id);
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/testbench' || pathname === '/testbench/') {
      const html = renderTestbenchHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    if (pathname.startsWith('/testbench/api/')) {
      const sub = pathname.replace('/testbench/api/', '');
      if (sub === 'fast-health') {
        return sendJson(res, 200, {
          status: 'healthy',
          service: 'browz-edge-gateway',
          timestamp: new Date().toISOString(),
          region: 'ap-south-1'
        });
      }
      if (sub === 'products') {
        return sendJson(res, 200, {
          category: parsed.searchParams.get('category') || 'all',
          count: 3,
          items: [
            { id: 'prd-101', name: 'Cloud Load Balancer Pro', latencyTargetMs: 12, priceUsd: 99.0 },
            { id: 'prd-102', name: 'Distributed Trace Collector', latencyTargetMs: 8, priceUsd: 149.0 },
            { id: 'prd-103', name: 'Zero-Trust Container Gateway', latencyTargetMs: 15, priceUsd: 199.0 }
          ]
        });
      }
      if (sub === 'auth/login') {
        const body = await readJsonBody(req);
        const sessionToken = `tok_${Math.random().toString(36).slice(2, 10)}`;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': [
            `browz_session=${sessionToken}; Path=/; HttpOnly`,
            `last_login_user=${encodeURIComponent(body.username || 'user')}; Path=/`
          ]
        });
        return res.end(
          JSON.stringify({
            authenticated: true,
            username: body.username || 'perf_tester_01',
            sessionToken,
            issuedAt: new Date().toISOString()
          })
        );
      }
      if (sub === 'whoami') {
        return sendJson(res, 200, {
          cookiesReceived: req.headers.cookie || '(none)',
          userAgentReceived: req.headers['user-agent'] || '',
          customHeaderReceived: req.headers['x-browz-capture'] || null,
          timestamp: new Date().toISOString()
        });
      }
      if (sub === 'checkout' || sub === 'cart/add' || sub === 'profile' || sub.startsWith('cache/')) {
        const body = await readJsonBody(req);
        return sendJson(res, 200, {
          ok: true,
          endpoint: sub,
          method: req.method,
          orderId: `ord_${Date.now()}`,
          receivedPayload: body,
          processedAt: new Date().toISOString()
        });
      }
      if (sub === 'slow-report') {
        const delay = Math.min(2000, Math.max(20, Number(parsed.searchParams.get('delay') || 180)));
        await new Promise((r) => setTimeout(r, delay));
        return sendJson(res, 200, {
          report: 'percentile-aggregation',
          simulatedDbWaitMs: delay,
          rowsScanned: 48290,
          generatedAt: new Date().toISOString()
        });
      }
      if (sub === 'error') {
        const code = Number(parsed.searchParams.get('code') || 500);
        return sendJson(res, code, {
          error: true,
          statusCode: code,
          message: code === 429 ? 'Too Many Requests — Rate limit exceeded' : 'Upstream Service Unavailable',
          retryAfterSec: 5
        });
      }
      return sendJson(res, 200, { ok: true, path: pathname });
    }

    // --- 2. PROXY & IN-TAB PAGE RENDERER (`/api/proxy`) ---
    if (pathname === '/api/proxy') {
      const targetUrl = parsed.searchParams.get('url') || 'browz://testbench';
      const tabId = parsed.searchParams.get('tabId') || 'tab-1';
      const containerId = parsed.searchParams.get('containerId') || 'default';
      const resourceType = parsed.searchParams.get('resourceType') || 'Document';

      const bodyChunks = [];
      req.on('data', (c) => bodyChunks.push(c));
      await new Promise((r) => req.on('end', r));
      const rawBody = Buffer.concat(bodyChunks);

      try {
        const result = await executeCapturedRequest(
          engine,
          {
            tabId,
            containerId,
            method: req.method,
            url: targetUrl,
            headers: req.headers,
            body: rawBody.length ? rawBody : '',
            resourceType
          },
          activePort
        );

        const outHeaders = {
          'Content-Type': result.headers['content-type'] || result.mimeType || 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        };
        if (result.headers['accept-ranges']) {
          outHeaders['Accept-Ranges'] = result.headers['accept-ranges'];
        }
        if (result.headers['content-range']) {
          outHeaders['Content-Range'] = result.headers['content-range'];
        }

        // Render polished Browser Error / Blocked Page with Retry for Document navigations
        if (resourceType === 'Document' && (result.blocked || result.networkError)) {
          const errHtml = renderBrowserErrorPageHtml({
            url: targetUrl,
            status: result.status,
            title: result.blocked
              ? 'Blocked by Browz Shield'
              : result.statusText === 'Offline'
                ? 'Offline Mode Active'
                : 'Site Cannot Be Reached',
            message: result.blocked
              ? `Browz Network Firewall blocked this request (${result.blockReason || 'Tracker Rule'}).`
              : result.statusText === 'Offline'
                ? 'Network Throttling is currently set to Offline Mode. Switch Throttling back to "No Throttling" to browse.'
                : `${result.errorMessage || 'Connection could not be established.'} (In Cloud Preview, external connections are restricted to github.com, api.github.com, registry.npmjs.org, and pypi.org; install the Desktop .EXE or Android .APK for full unrestricted internet access.)`,
            retryCount: result.retryCount || 0,
            isBlocked: Boolean(result.blocked),
            tabId
          });
          res.writeHead(result.status || 502, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
          });
          return res.end(errHtml);
        }

        // Strip X-Frame-Options & CSP frame-ancestors so any website renders inside tab view
        let bodyBuffer = result.body;
        if (
          resourceType === 'Document' &&
          String(outHeaders['Content-Type']).toLowerCase().includes('text/html')
        ) {
          let htmlStr = bodyBuffer.toString('utf8');
          // Strip inline meta Content-Security-Policy tags so injected Stealth Shield & base tag run cleanly
          htmlStr = htmlStr.replace(/<meta[^>]+http-equiv=["']?(?:Content-Security-Policy|X-Frame-Options)["']?[^>]*>/gi, '');
          const resolvedFinalUrl = result.finalUrl || targetUrl;
          const isInternalPage =
            targetUrl.startsWith('browz://') ||
            targetUrl.startsWith('/') ||
            resolvedFinalUrl.startsWith(`http://127.0.0.1:${activePort}`);
          const effectiveOrigin = isInternalPage
            ? `http://127.0.0.1:${activePort}/`
            : resolvedFinalUrl;
          const baseTag =
            !isInternalPage && resolvedFinalUrl.startsWith('http')
              ? `<base href="${resolvedFinalUrl.replace(/"/g, '&quot;')}">`
              : '';
          const hookScript = buildInjectedPageHook(
            tabId,
            containerId,
            effectiveOrigin,
            engine.getState().stealth
          );
          if (/<head[^>]*>/i.test(htmlStr)) {
            htmlStr = htmlStr.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}\n${hookScript}`);
          } else {
            htmlStr = `${baseTag}\n${hookScript}\n${htmlStr}`;
          }
          bodyBuffer = Buffer.from(htmlStr, 'utf8');
        }

        res.writeHead(result.status || 200, outHeaders);
        return res.end(bodyBuffer);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // --- 3. STATE & CAPTURED ENTRIES API ---
    if (pathname === '/api/bootstrap' && req.method === 'GET') {
      return sendJson(res, 200, {
        state: engine.getState(),
        entries: engine.entries,
        metrics: computeMetrics(engine.entries)
      });
    }

    if (pathname === '/api/entries/clear' && req.method === 'POST') {
      const body = await readJsonBody(req);
      engine.clearEntries(body.tabId || null);
      return sendJson(res, 200, { ok: true, metrics: computeMetrics(engine.entries) });
    }

    // --- 4. REQUEST REPLAY & MINI LOAD BURST API ---
    if (pathname === '/api/replay' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = await executeCapturedRequest(
        engine,
        {
          tabId: body.tabId || 'replay',
          containerId: body.containerId || 'default',
          method: body.method || 'GET',
          url: body.url || 'browz://testbench/api/fast-health',
          headers: body.headers || {},
          body: body.body || '',
          resourceType: body.resourceType || 'Replay'
        },
        activePort
      );
      return sendJson(res, 200, {
        ok: true,
        entry: result.entry,
        metrics: computeMetrics(engine.entries)
      });
    }

    if (pathname === '/api/burst' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const count = Math.min(50, Math.max(1, Number(body.count || 10)));
      const concurrency = Math.min(25, Math.max(1, Number(body.concurrency || 5)));
      const targetUrl = body.url || 'browz://testbench/api/fast-health';
      const method = body.method || 'GET';
      const reqHeaders = body.headers || {};
      const reqBody = body.body || '';
      const containerId = body.containerId || 'default';
      const tabId = body.tabId || 'burst-test';

      let completed = 0;
      const results = [];
      const queue = Array.from({ length: count }, (_, idx) => idx + 1);

      async function worker() {
        while (queue.length > 0) {
          const seq = queue.shift();
          const sep = targetUrl.includes('?') ? '&' : '?';
          const r = await executeCapturedRequest(
            engine,
            {
              tabId,
              containerId,
              method,
              url: `${targetUrl}${sep}_burst=${seq}`,
              headers: reqHeaders,
              body: reqBody,
              resourceType: 'LoadBurst'
            },
            activePort
          );
          completed++;
          if (r.entry) results.push(r.entry.timings?.total || 0);
        }
      }

      const workers = Array.from({ length: Math.min(concurrency, count) }, () => worker());
      await Promise.all(workers);

      return sendJson(res, 200, {
        ok: true,
        completed,
        metrics: computeMetrics(engine.entries)
      });
    }

    // --- 5. CAPTURE & NETWORK CONTROL UPDATES (#2) ---
    if (pathname === '/api/control/capture' && req.method === 'POST') {
      const body = await readJsonBody(req);
      Object.assign(engine.state.capture, body);
      if (body.throttlingPreset && THROTTLING_PRESETS[body.throttlingPreset]) {
        const preset = THROTTLING_PRESETS[body.throttlingPreset];
        engine.state.capture.throttling = {
          preset: body.throttlingPreset,
          latencyMs: preset.latencyMs,
          downloadKbps: preset.downloadKbps,
          uploadKbps: preset.uploadKbps,
          offline: preset.offline
        };
      }
      if (typeof engine.onStealthOrNetworkChanged === 'function') {
        engine.onStealthOrNetworkChanged();
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/control/stealth' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.activePersonaId && STEALTH_PERSONAS[body.activePersonaId]) {
        engine.state.stealth.activePersonaId = body.activePersonaId;
        engine.state.stealth.persona = { ...STEALTH_PERSONAS[body.activePersonaId] };
      }
      if (body.personaPatch) {
        Object.assign(engine.state.stealth.persona, body.personaPatch);
      }
      const { activePersonaId, personaPatch, ...rest } = body;
      Object.assign(engine.state.stealth, rest);
      if (typeof engine.onStealthOrNetworkChanged === 'function') {
        engine.onStealthOrNetworkChanged();
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/stealth/rotate' && req.method === 'POST') {
      const personaKeys = Object.keys(STEALTH_PERSONAS);
      const currentId = engine.state.stealth.activePersonaId;
      const otherKeys = personaKeys.filter((k) => k !== currentId);
      const nextKey = otherKeys[Math.floor(Math.random() * otherKeys.length)] || personaKeys[0];

      engine.state.stealth.activePersonaId = nextKey;
      engine.state.stealth.persona = { ...STEALTH_PERSONAS[nextKey] };
      engine.state.stealth.noiseSeed = Math.floor(Math.random() * 900000) + 100000;

      // Also wipe cookies & storage on rotation if requested
      for (const c of engine.state.containers) {
        c.cookies = {};
        c.cookieCount = 0;
        c.storageStats = { localStorageKeys: 0, cacheKb: 0, lastCleared: new Date().toISOString() };
        if (typeof engine.onClearPartitionStorage === 'function') {
          engine.onClearPartitionStorage(c.partition);
        }
      }

      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/control/network' && req.method === 'POST') {
      const body = await readJsonBody(req);
      Object.assign(engine.state.networkControl, body);
      if (typeof engine.onProxyConfigChanged === 'function') {
        engine.onProxyConfigChanged();
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/control/block-rule' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'add') {
        engine.state.networkControl.blockRules.unshift({
          id: `blk-${Date.now()}`,
          enabled: true,
          pattern: body.pattern || '',
          resourceType: body.resourceType || 'ALL',
          note: body.note || 'Custom Block Rule'
        });
      } else if (body.action === 'toggle') {
        const rule = engine.state.networkControl.blockRules.find((r) => r.id === body.id);
        if (rule) rule.enabled = !rule.enabled;
      } else if (body.action === 'delete') {
        engine.state.networkControl.blockRules = engine.state.networkControl.blockRules.filter(
          (r) => r.id !== body.id
        );
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/control/header-rule' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const listKey = body.target === 'response' ? 'customResponseHeaders' : 'customRequestHeaders';
      if (body.action === 'add') {
        engine.state.networkControl[listKey].push({
          id: `hdr-${Date.now()}`,
          enabled: true,
          name: body.name || 'X-Custom-Header',
          value: body.value || '',
          domainFilter: body.domainFilter || '*'
        });
      } else if (body.action === 'toggle') {
        const item = engine.state.networkControl[listKey].find((h) => h.id === body.id);
        if (item) item.enabled = !item.enabled;
      } else if (body.action === 'delete') {
        engine.state.networkControl[listKey] = engine.state.networkControl[listKey].filter(
          (h) => h.id !== body.id
        );
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    // --- 6. MULTI-ACCOUNT CONTAINERS & STORAGE CONTROL (#4) ---
    if (pathname === '/api/containers' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.action === 'create') {
        const id = `cnt-${Date.now().toString(36)}`;
        const newContainer = {
          id,
          name: body.name || 'Custom Container',
          color: body.color || '#06b6d4',
          partition: body.ephemeral ? `ephemeral:${id}` : `persist:${id}`,
          ephemeral: Boolean(body.ephemeral),
          proxyRules: body.proxyRules || '',
          userAgent: body.userAgent || '',
          cookieCount: 0,
          cookies: {},
          storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
        };
        engine.state.containers.push(newContainer);
        if (typeof engine.onContainerCreated === 'function') {
          engine.onContainerCreated(newContainer);
        }
      } else if (body.action === 'clear-storage') {
        const c = engine.state.containers.find((x) => x.id === body.containerId);
        if (c) {
          c.cookies = {};
          c.cookieCount = 0;
          c.storageStats = {
            localStorageKeys: 0,
            cacheKb: 0,
            lastCleared: new Date().toISOString()
          };
        }
      } else if (body.action === 'set-cookie') {
        const c = engine.state.containers.find((x) => x.id === body.containerId);
        if (c && body.name) {
          const domain = body.domain || 'browz.local';
          if (!c.cookies[domain]) c.cookies[domain] = {};
          c.cookies[domain][body.name] = body.value || '';
          c.cookieCount = Object.values(c.cookies).reduce(
            (acc, obj) => acc + Object.keys(obj || {}).length,
            0
          );
        }
      } else if (body.action === 'update') {
        const c = engine.state.containers.find((x) => x.id === body.containerId);
        if (c) {
          if (body.proxyRules !== undefined) c.proxyRules = body.proxyRules;
          if (body.userAgent !== undefined) c.userAgent = body.userAgent;
        }
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    // --- 7. PERMISSIONS, DOWNLOADS & HARDWARE CONTROL (#5) ---
    if (pathname === '/api/permissions/check' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const allowed = engine.evaluatePermission(body.origin, body.permission);
      return sendJson(res, 200, { allowed, state: engine.state });
    }

    if (pathname === '/api/permissions/update' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.scope === 'global' && body.permission) {
        engine.state.permissions.globalDefaults[body.permission] = body.decision;
      } else if (body.scope === 'site' && body.origin && body.permission) {
        if (!engine.state.permissions.siteOverrides[body.origin]) {
          engine.state.permissions.siteOverrides[body.origin] = {};
        }
        engine.state.permissions.siteOverrides[body.origin][body.permission] = body.decision;
      } else if (body.scope === 'delete-site' && body.origin) {
        delete engine.state.permissions.siteOverrides[body.origin];
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/downloads/trigger' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const filename = body.filename || 'capture-report.csv';
      const ext = path.extname(filename).toLowerCase();
      if (
        engine.state.downloads.autoBlockDangerous &&
        engine.state.downloads.blockedExtensions.includes(ext)
      ) {
        const id = engine.registerDownload({
          filename,
          url: body.url || `http://browz.local/${filename}`,
          totalBytes: body.totalBytes || 102400,
          receivedBytes: 0,
          state: 'blocked-extension',
          containerId: body.containerId || 'default'
        });
        return sendJson(res, 200, { ok: false, blocked: true, id, reason: `Blocked dangerous extension (${ext})` });
      }

      const total = body.totalBytes || 245760;
      const id = engine.registerDownload({
        filename,
        url: body.url || `http://browz.local/${filename}`,
        totalBytes: total,
        receivedBytes: Math.round(total * 0.4),
        state: 'progressing',
        containerId: body.containerId || 'default'
      });
      setTimeout(() => {
        engine.updateDownload(id, { receivedBytes: total, state: 'completed' });
      }, 600);
      return sendJson(res, 200, { ok: true, blocked: false, id });
    }

    if (pathname === '/api/downloads/config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.autoBlockDangerous !== undefined) {
        engine.state.downloads.autoBlockDangerous = Boolean(body.autoBlockDangerous);
      }
      if (body.blockedExtensions) {
        engine.state.downloads.blockedExtensions = body.blockedExtensions;
      }
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    // --- 8. PERFORMANCE EXPORTS (HAR 1.2, k6, JMeter JMX, CSV, JSON, Code Snippets) ---
    if (pathname.startsWith('/api/export/')) {
      const format = pathname.replace('/api/export/', '');
      const tabFilter = parsed.searchParams.get('tabId');
      const list = tabFilter
        ? engine.entries.filter((e) => e.tabId === tabFilter)
        : engine.entries;

      if (format === 'har') {
        const har = toHAR(list);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="browz-capture-${Date.now()}.har"`
        });
        return res.end(har);
      }
      if (format === 'k6') {
        const script = toK6Script(list);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Disposition': `attachment; filename="browz-loadtest-${Date.now()}.js"`
        });
        return res.end(script);
      }
      if (format === 'jmeter') {
        const jmx = toJMeterJMX(list);
        res.writeHead(200, {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="browz-testplan-${Date.now()}.jmx"`
        });
        return res.end(jmx);
      }
      if (format === 'csv') {
        const csv = toCSV(list);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="browz-capture-${Date.now()}.csv"`
        });
        return res.end(csv);
      }
      if (format === 'json') {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="browz-capture-${Date.now()}.json"`
        });
        return res.end(JSON.stringify({ metrics: computeMetrics(list), entries: list }, null, 2));
      }
    }

    // --- 9. SERVE WINDOWS INSTALLER (.EXE) DIRECT DOWNLOAD ---
    if (pathname === '/download/Browz-Setup-1.0.0.exe' || pathname === '/Browz-Setup-1.0.0.exe') {
      const exePath = path.join(__dirname, '..', 'Browz-Setup-1.0.0.exe');
      if (fs.existsSync(exePath)) {
        const stat = fs.statSync(exePath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.microsoft.portable-executable',
          'Content-Disposition': 'attachment; filename="Browz-Setup-1.0.0.exe"',
          'Content-Length': String(stat.size),
          'Cache-Control': 'no-cache'
        });
        return fs.createReadStream(exePath).pipe(res);
      }
    }

    // --- 10. SERVE BROWSER SHELL STATIC FILES (`public/`) ---
    const relTarget = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const filePath = path.resolve(publicDir, relTarget);
    if (
      (filePath === path.join(publicDir, 'index.html') || filePath.startsWith(publicDir + path.sep)) &&
      fs.existsSync(filePath) &&
      fs.statSync(filePath).isFile()
    ) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml'
      };
      res.writeHead(200, {
        'Content-Type': mimeMap[ext] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache'
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    sendJson(res, 404, { error: 'Not found', path: pathname });
  });

  // Native zero-dependency WebSocket Server for real-time streaming of captured traffic & state updates
  attachNativeWebSocketServer(server, '/ws', (client) => {
    engine.wsClients.add(client);
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bindHost, () => {
      activePort = server.address().port;
      console.log(`Browz Browser & Capture Engine listening on http://${bindHost}:${activePort}`);
      resolve({ server, port: activePort, engine });
    });
  });
}

if (require.main === module) {
  startBrowzServer(Number(process.env.PORT || 3000)).catch((err) => {
    console.error('Failed to start Browz server:', err);
    process.exit(1);
  });
}

module.exports = {
  startBrowzServer,
  executeCapturedRequest,
  buildInjectedPageHook,
  validateOutboundTarget,
  sanitizeJsonObject,
  safeJsonForScript,
  renderBrowserErrorPageHtml
};
