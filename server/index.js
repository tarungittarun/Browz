'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

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
  THROTTLING_PRESETS,
  createInitialState,
  shouldBlockRequest,
  getEffectiveUserAgent
} = require('../shared/core-state');

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
    if (this.entries.length > (this.state.capture.maxEntries || 3000)) {
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

  // Check Offline Throttling Mode
  if (state.capture.throttling?.offline) {
    const entry = engine.recordBlockedRequest({
      tabId,
      containerId,
      method,
      url: rawUrl,
      resourceType,
      reason: 'Offline Mode Active (Network Throttling)',
      requestHeaders: incomingHeaders,
      requestBody: body
    });
    return {
      blocked: true,
      status: 0,
      statusText: 'Offline',
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(entry ? entry.responseBody : 'Offline Mode Active'),
      entry
    };
  }

  // Resolve internal browz:// or relative testbench URLs
  let targetUrl = rawUrl;
  if (targetUrl.startsWith('browz://testbench')) {
    const suffix = targetUrl.replace(/^browz:\/\/testbench/i, '') || '';
    targetUrl = `http://127.0.0.1:${localPort}/testbench${suffix}`;
  } else if (targetUrl.startsWith('/')) {
    targetUrl = `http://127.0.0.1:${localPort}${targetUrl}`;
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

  const container = engine.getContainer(containerId);
  const outHeaders = {};

  // Copy safe incoming headers
  for (const [k, v] of Object.entries(incomingHeaders || {})) {
    const low = k.toLowerCase();
    if (!['host', 'connection', 'content-length', 'accept-encoding'].includes(low)) {
      outHeaders[k] = v;
    }
  }

  // Effective User-Agent (#2 & #4)
  outHeaders['User-Agent'] = getEffectiveUserAgent(state.networkControl, container);
  outHeaders['Accept-Encoding'] = 'gzip, deflate, br';
  if (!outHeaders['Accept'] && !outHeaders['accept']) {
    outHeaders['Accept'] = '*/*';
  }

  // Strip Referer if enabled
  if (state.networkControl.stripReferer) {
    delete outHeaders['Referer'];
    delete outHeaders['referer'];
  }

  // Strip Tracking Client Hints if enabled
  if (state.networkControl.stripTrackingHeaders) {
    for (const k of Object.keys(outHeaders)) {
      if (k.toLowerCase().startsWith('sec-ch-ua')) {
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

  // Artificial throttling latency if configured (#2 Performance Throttling)
  const throttleLatencyMs = Number(state.capture.throttling?.latencyMs || 0);
  if (throttleLatencyMs > 0) {
    await new Promise((r) => setTimeout(r, throttleLatencyMs));
  }

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

    const reqOpts = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + (parsedUrl.search || ''),
      method: method.toUpperCase(),
      headers: outHeaders,
      timeout: 15000,
      rejectUnauthorized: false
    };

    const req = transport.request(reqOpts, (res) => {
      tFirstByte = msSinceStart();
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const tEnd = msSinceStart();
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

        // Response header manipulation (#2)
        const finalResHeaders = { ...res.headers };
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

        // Store Set-Cookie in isolated container jar (#4)
        const responseCookies = engine.storeSetCookies(
          containerId,
          parsedUrl.hostname,
          res.headers['set-cookie']
        );

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
          url: rawUrl,
          resourceType,
          protocol: `HTTP/${res.httpVersion || '1.1'}`,
          status: res.statusCode || 200,
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
          status: res.statusCode || 200,
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
      socket.on('lookup', () => {
        tDns = msSinceStart();
      });
      socket.on('connect', () => {
        tConnect = msSinceStart();
      });
      socket.on('secureConnect', () => {
        tSsl = msSinceStart();
      });
    });

    req.on('finish', () => {
      tSend = msSinceStart();
    });

    req.on('error', (err) => {
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
        statusText: 'Bad Gateway / Network Unreachable',
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
            url: rawUrl,
            note: 'In cloud sandbox preview, outbound connections are restricted to github.com, api.github.com, registry.npmjs.org, and pypi.org. Run `npm run desktop` or `npm start` locally for unrestricted internet access.'
          },
          null,
          2
        ),
        responseBodySize: 220,
        transferSize: 220,
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
function buildInjectedPageHook(tabId, containerId, originUrl) {
  return `<script data-browz-hook="1">
(function() {
  const TAB_ID = ${JSON.stringify(tabId)};
  const CONTAINER_ID = ${JSON.stringify(containerId)};
  const PAGE_ORIGIN = ${JSON.stringify(originUrl)};

  // Notify parent shell of page title & URL
  function notifyShell() {
    try {
      window.parent.postMessage({
        type: 'browz:page-meta',
        tabId: TAB_ID,
        title: document.title || PAGE_ORIGIN,
        url: PAGE_ORIGIN
      }, '*');
    } catch (e) {}
  }
  window.addEventListener('DOMContentLoaded', notifyShell);
  window.addEventListener('load', notifyShell);
  setTimeout(notifyShell, 150);

  function toProxyApiUrl(target, rType) {
    try {
      const resolved = new URL(target, PAGE_ORIGIN).href;
      if (resolved.includes('/api/proxy') || resolved.includes('/api/capture')) return target;
      return '/api/proxy?url=' + encodeURIComponent(resolved) +
        '&tabId=' + encodeURIComponent(TAB_ID) +
        '&containerId=' + encodeURIComponent(CONTAINER_ID) +
        '&resourceType=' + encodeURIComponent(rType || 'Fetch');
    } catch (e) {
      return target;
    }
  }

  // 1. Intercept window.fetch so every Fetch request/response is captured
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function(input, init) {
      const rawUrl = typeof input === 'string' ? input : (input && input.url) || '';
      const proxiedUrl = toProxyApiUrl(rawUrl, 'Fetch');
      return origFetch.call(this, proxiedUrl, init);
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
    const origGeo = navigator.geolocation.getCurrentPosition;
    navigator.geolocation.getCurrentPosition = function(success, error, opts) {
      origFetch('/api/permissions/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ origin: PAGE_ORIGIN, permission: 'geolocation', tabId: TAB_ID })
      }).then(r => r.json()).then(res => {
        if (res.allowed) {
          if (success) success({ coords: { latitude: 15.8497, longitude: 74.4977, accuracy: 20 }, timestamp: Date.now() });
        } else {
          if (error) error({ code: 1, message: 'Blocked by Browz Permission Firewall (geolocation)' });
        }
      });
    };
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia = async function(constraints) {
      const r = await origFetch('/api/permissions/check', {
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
    origFetch('/api/permissions/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: PAGE_ORIGIN, permission: 'popups', tabId: TAB_ID })
    }).then(r => r.json()).then(res => {
      if (res.allowed && url) {
        window.parent.postMessage({ type: 'browz:open-tab', url: new URL(url, PAGE_ORIGIN).href, containerId: CONTAINER_ID }, '*');
      }
    });
    return null;
  };

  // 5. Intercept normal anchor clicks so navigation stays inside the tab
  document.addEventListener('click', function(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (a.hasAttribute('download')) return;
    try {
      const resolved = new URL(href, PAGE_ORIGIN).href;
      e.preventDefault();
      window.parent.postMessage({
        type: 'browz:navigate-tab',
        tabId: TAB_ID,
        url: resolved
      }, '*');
    } catch (err) {}
  });
})();
</script>`;
}

/**
 * Built-in Interactive Performance & API Testbench HTML (`browz://testbench`)
 * Lets users test GET, POST, PUT, DELETE, Auth Cookies, Slow TTFB, 4xx/5xx Errors,
 * Parallel Load Bursts, Permission Firewall, and Download Interception immediately.
 */
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
  </div>

  <div class="status-box" id="output">Ready. Click any button above to generate network traffic and inspect it in the Capture Dock below.</div>

  <script>
    const out = document.getElementById('output');
    function log(msg) {
      out.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    }

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

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
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
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function startBrowzServer(port = Number(process.env.PORT || 3000)) {
  const engine = new BrowzEngine();
  const publicDir = path.join(__dirname, '..', 'public');
  let activePort = port;

  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;

    // --- 1. BUILT-IN TESTBENCH ENDPOINTS ---
    if (pathname === '/testbench' || pathname === '/testbench/') {
      const html = renderTestbenchHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

        // Strip X-Frame-Options & CSP frame-ancestors so any website renders inside tab view
        let bodyBuffer = result.body;
        if (
          resourceType === 'Document' &&
          String(outHeaders['Content-Type']).toLowerCase().includes('text/html')
        ) {
          let htmlStr = bodyBuffer.toString('utf8');
          const effectiveOrigin = targetUrl.startsWith('browz://')
            ? `http://127.0.0.1:${activePort}/testbench`
            : targetUrl;
          const baseTag = targetUrl.startsWith('http')
            ? `<base href="${targetUrl.replace(/"/g, '&quot;')}">`
            : '';
          const hookScript = buildInjectedPageHook(tabId, containerId, effectiveOrigin);
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
      engine.broadcast('state:updated', engine.state);
      return sendJson(res, 200, { ok: true, state: engine.state });
    }

    if (pathname === '/api/control/network' && req.method === 'POST') {
      const body = await readJsonBody(req);
      Object.assign(engine.state.networkControl, body);
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
        engine.state.containers.push({
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
        });
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

    // --- 9. SERVE BROWSER SHELL STATIC FILES (`public/`) ---
    const filePath = pathname === '/' ? path.join(publicDir, 'index.html') : path.join(publicDir, pathname);
    if (filePath.startsWith(publicDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
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
    server.listen(port, '0.0.0.0', () => {
      activePort = server.address().port;
      console.log(`Browz Browser & Capture Engine listening on http://0.0.0.0:${activePort}`);
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

module.exports = { startBrowzServer, executeCapturedRequest };
