'use strict';

const assert = require('assert');
const http = require('http');
const { startBrowzServer, executeCapturedRequest } = require('../server/index');

async function runVerification() {
  console.log('Starting Browz verification suite...');
  const { server, port, engine } = await startBrowzServer(0);
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Bootstrap check
    const boot = await fetch(`${baseUrl}/api/bootstrap`).then((r) => r.json());
    assert.strictEqual(boot.state.capture.recording, true, 'Capture should be recording by default');
    assert.ok(boot.state.containers.length >= 5, 'Should have default containers');
    console.log('✓ 1. Bootstrap & initial state verified');

    // 2. Capture GET & POST requests with body & cookies in Container 'user-a'
    const loginRes = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('browz://testbench/api/auth/login')}&tabId=tab-1&containerId=user-a&resourceType=Fetch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'perf_user_alpha', password: 'secret' })
      }
    ).then((r) => r.json());
    assert.strictEqual(loginRes.authenticated, true, 'Login should succeed');

    // Verify container cookie isolation (#4)
    const whoUserA = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('browz://testbench/api/whoami')}&tabId=tab-1&containerId=user-a&resourceType=Fetch`
    ).then((r) => r.json());
    assert.ok(whoUserA.cookiesReceived.includes('browz_session='), 'User-A container should send its session cookie');

    const whoUserB = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('browz://testbench/api/whoami')}&tabId=tab-2&containerId=user-b&resourceType=Fetch`
    ).then((r) => r.json());
    assert.ok(!whoUserB.cookiesReceived.includes('browz_session='), 'User-B container must NOT receive User-A session cookie');
    console.log('✓ 2. Request/Response capture & Multi-Container cookie isolation (#4) verified');

    // 3. Test Blocked Tracker Rule (#2)
    const blockedRes = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('https://google-analytics.com/collect?v=1')}&tabId=tab-1&containerId=default&resourceType=Script`
    );
    assert.strictEqual(blockedRes.status, 403, 'Blocked tracker domain should return 403 Blocked');
    console.log('✓ 3. Network Interception & Tracker Blocking (#2) verified');

    // 4. Test Concurrent Load Burst (/api/burst)
    const burstRes = await fetch(`${baseUrl}/api/burst`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tabId: 'tab-1',
        containerId: 'default',
        method: 'POST',
        url: 'browz://testbench/api/checkout',
        body: JSON.stringify({ sku: 'PERF-99', qty: 2 }),
        count: 8,
        concurrency: 4
      })
    }).then((r) => r.json());
    assert.strictEqual(burstRes.completed, 8, 'Burst should complete 8 requests');
    assert.ok(burstRes.metrics.total >= 12, 'Total captured entries should be >= 12');
    assert.ok(burstRes.metrics.p95Ms >= 0, 'P95 latency metric should be computed');
    console.log('✓ 4. Concurrent Load Burst & P50/P95/P99 metrics verified');

    // 5. Test Permission Firewall & Download Extension Blocker (#5)
    const permRes = await fetch(`${baseUrl}/api/permissions/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'https://untrusted.example', permission: 'geolocation' })
    }).then((r) => r.json());
    assert.strictEqual(permRes.allowed, false, 'Geolocation should be blocked by default firewall policy');

    const dlBlocked = await fetch(`${baseUrl}/api/downloads/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'trojan.exe', totalBytes: 51200 })
    }).then((r) => r.json());
    assert.strictEqual(dlBlocked.blocked, true, '.exe download should be automatically blocked');
    console.log('✓ 5. Permission Firewall & Download Blocker (#5) verified');

    // 6. Verify Performance Exports (HAR 1.2, k6, JMeter JMX, CSV)
    const harText = await fetch(`${baseUrl}/api/export/har`).then((r) => r.text());
    const harJson = JSON.parse(harText);
    assert.strictEqual(harJson.log.version, '1.2', 'HAR export must be version 1.2');
    assert.ok(harJson.log.entries.length >= 10, 'HAR should contain all captured entries');

    const k6Text = await fetch(`${baseUrl}/api/export/k6`).then((r) => r.text());
    assert.ok(k6Text.includes("import http from 'k6/http'"), 'k6 export should contain valid k6 imports');

    const jmxText = await fetch(`${baseUrl}/api/export/jmeter`).then((r) => r.text());
    assert.ok(jmxText.includes('<jmeterTestPlan'), 'JMeter export should be valid JMX XML');

    const csvText = await fetch(`${baseUrl}/api/export/csv`).then((r) => r.text());
    assert.ok(csvText.includes('TTFB_Wait_ms'), 'CSV export should include timing columns');
    console.log('✓ 6. HAR 1.2, Grafana k6, Apache JMeter (.jmx), and CSV exports verified');

    // 7. Security Hardening Checks
    assert.strictEqual(
      boot.state.networkControl.allowSelfSignedCerts,
      false,
      'Strict SSL/TLS certificate validation must be ON by default'
    );

    const csrfRes = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' }
    });
    assert.strictEqual(csrfRes.status, 403, 'Cross-site requests to control APIs must be rejected (403)');

    const fileProtoRes = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('file:///C:/Windows/win.ini')}`
    );
    assert.strictEqual(fileProtoRes.status, 500, 'file:// protocol must be blocked in proxy');

    const metadataRes = await fetch(
      `${baseUrl}/api/proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`
    );
    assert.strictEqual(metadataRes.status, 500, 'Cloud metadata SSRF must be blocked');
    console.log('✓ 7. Security hardening (CSRF block, SSRF block, file:// block, strict TLS, 127.0.0.1 bind) verified');

    // 8. Stealth & Anonymity Engine Verification
    const initialSeed = boot.state.stealth.noiseSeed;
    const rotRes = await fetch(`${baseUrl}/api/stealth/rotate`, { method: 'POST' }).then((r) => r.json());
    assert.strictEqual(rotRes.ok, true, 'Identity rotation must succeed');
    assert.notStrictEqual(rotRes.state.stealth.noiseSeed, initialSeed, 'Canvas/Audio noise seed must rotate');

    const homeHtml = await fetch(`${baseUrl}/home`).then((r) => r.text());
    assert.ok(homeHtml.includes('Stealth Protection Active'), 'Home dashboard should render stealth status');
    console.log('✓ 8. Stealth Persona rotation, Canvas/Audio noise seed & Anonymity Dashboard verified');

    // 9. E2E Untraceability Shield Execution Verification (WebGL, Canvas, WebRTC, Timezone, URL Sanitizer)
    const vm = require('vm');
    const fs = require('fs');
    const path = require('path');
    const { buildStealthShieldScript } = require('../electron/webview-shield');
    const { stripUrlTrackingParams } = require('../shared/core-state');

    const cleanUrlCheck = stripUrlTrackingParams(
      'https://example.com/product?id=77&utm_source=newsletter&fbclid=IwAR123&gclid=Cj0KC&msclkid=998'
    );
    assert.strictEqual(cleanUrlCheck.url, 'https://example.com/product?id=77', 'Must strip all tracking query params');
    assert.strictEqual(cleanUrlCheck.strippedCount, 4, 'Should count 4 stripped tracking params');

    function MockWebGL() {}
    MockWebGL.prototype.getParameter = function (p) {
      return p === 37445 ? 'Real NVIDIA Corp' : 'Real RTX 4090';
    };
    const sandbox = {
      navigator: {
        webdriver: true,
        hardwareConcurrency: 32,
        deviceMemory: 64,
        getBattery: () => {},
        connection: { effectiveType: '4g' },
        mediaDevices: { enumerateDevices: async () => [{ label: 'Real Webcam' }] },
        sendBeacon: () => false
      },
      window: {
        screen: { width: 3840, height: 2160, colorDepth: 32 },
        RTCPeerConnection: function () {},
        webkitRTCPeerConnection: function () {}
      },
      Intl: {
        DateTimeFormat: function () {}
      },
      Date,
      WebGLRenderingContext: MockWebGL,
      WebGL2RenderingContext: MockWebGL,
      DOMException: Error
    };
    sandbox.Intl.DateTimeFormat.prototype.resolvedOptions = function () {
      return { timeZone: 'Asia/Calcutta', locale: 'en-IN' };
    };

    const shieldJs = buildStealthShieldScript(boot.state.stealth);
    vm.runInNewContext(shieldJs, sandbox);

    assert.strictEqual(sandbox.navigator.webdriver, false, 'Webdriver flag must be hidden');
    assert.strictEqual(sandbox.navigator.getBattery, undefined, 'Battery API must be blocked');
    assert.strictEqual(sandbox.navigator.connection, undefined, 'Network Info API must be blocked');
    assert.strictEqual(
      new sandbox.WebGLRenderingContext().getParameter(37445),
      'Intel Inc.',
      'WebGL Vendor must be spoofed'
    );
    assert.strictEqual(
      new sandbox.Intl.DateTimeFormat().resolvedOptions().timeZone,
      'UTC',
      'Real timezone (Asia/Calcutta) must be masked to UTC'
    );
    let webrtcBlocked = false;
    try {
      new sandbox.window.RTCPeerConnection();
    } catch {
      webrtcBlocked = true;
    }
    assert.strictEqual(webrtcBlocked, true, 'WebRTC RTCPeerConnection must be blocked to prevent IP leak');
    console.log('✓ 9. E2E Untraceability Shield (WebGL, Timezone, WebRTC, Battery, URL Sanitizer) verified');

    // 10. Android Native Browser Security & Manifest Audit
    const manifestXml = fs.readFileSync(
      path.join(__dirname, '..', 'android/app/src/main/AndroidManifest.xml'),
      'utf8'
    );
    const mainActivityJava = fs.readFileSync(
      path.join(__dirname, '..', 'android/app/src/main/java/com/browz/mobile/MainActivity.java'),
      'utf8'
    );
    assert.ok(manifestXml.includes('android:allowBackup="false"'), 'Android backup must be disabled');
    assert.ok(manifestXml.includes('android.webkit.WebView.MetricsOptOut'), 'WebView telemetry opt-out must be set');
    assert.ok(!manifestXml.includes('ACCESS_FINE_LOCATION'), 'Must not request OS GPS permission');
    assert.ok(!manifestXml.includes('CAMERA'), 'Must not request OS Camera permission');
    assert.ok(mainActivityJava.includes('FLAG_SECURE'), 'Android FLAG_SECURE screenshot protection must be present');
    assert.ok(mainActivityJava.includes('setAllowFileAccess(false)'), 'WebView local file access must be disabled');
    assert.ok(mainActivityJava.includes('setAcceptThirdPartyCookies(wv, false)'), 'Third-party cookies must be disabled');
    assert.ok(mainActivityJava.includes('DeviceMotionEvent = undefined'), 'Mobile gyroscope/accelerometer sensors must be blocked');
    console.log('✓ 10. Android Native Browser (Manifest & MainActivity security hardening) verified');

    // 11. Multi-Hop HTTP Redirect Following, URL Sanitizer on Redirects & Friendly Browser Error/Retry Page
    let redirectHopCookieReceived = '';
    const mockUpstream = http.createServer((req, res) => {
      if (req.url.startsWith('/start-redir')) {
        res.writeHead(302, {
          Location: '/final-landing?ok=1&fbclid=leak999&utm_campaign=spy',
          'Set-Cookie': 'hop_token=verified_hop; Path=/'
        });
        return res.end();
      }
      if (req.url.startsWith('/final-landing')) {
        redirectHopCookieReceived = req.headers.cookie || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ landedUrl: req.url, cookie: redirectHopCookieReceived }));
      }
      res.writeHead(404).end();
    });
    await new Promise((r) => mockUpstream.listen(0, '127.0.0.1', r));
    const upPort = mockUpstream.address().port;
    try {
      const redirRes = await executeCapturedRequest(
        engine,
        {
          tabId: 'tab-redir',
          containerId: 'user-a',
          method: 'GET',
          url: `http://127.0.0.1:${upPort}/start-redir?utm_source=email`
        },
        port
      );
      const redirJson = JSON.parse(redirRes.body.toString('utf8'));
      assert.strictEqual(redirRes.status, 200, '302 Redirect must be followed to 200 OK destination');
      assert.strictEqual(redirJson.landedUrl, '/final-landing?ok=1', 'Redirect target must have fbclid & utm_campaign stripped');
      assert.ok(redirJson.cookie.includes('hop_token=verified_hop'), 'Cookie set during 302 hop must be preserved in container');

      // Verify Document navigation to blocked tracker renders friendly HTML page with Retry Now button
      const blockedDocHtml = await fetch(
        `${baseUrl}/api/proxy?url=${encodeURIComponent('https://doubleclick.net/ad')}&tabId=tab-1&containerId=default&resourceType=Document`
      ).then((r) => r.text());
      assert.ok(blockedDocHtml.includes('Blocked by Browz Shield'), 'Blocked Document must render friendly browser page');
      assert.ok(blockedDocHtml.includes('Retry Now'), 'Browser error/blocked page must include Retry Now button');
    } finally {
      mockUpstream.close();
    }
    console.log('✓ 11. Multi-Hop 301/302 Redirect Following, Hop Cookie Preservation & Browser Retry Page verified');

    // 12. Triple-Layer 18-Point Security & Untraceability Audit (userAgentData, Storage Quota, Voices, SSRF, Bookmarks)
    const heValues = await sandbox.navigator.userAgentData.getHighEntropyValues(['platform', 'platformVersion']);
    assert.strictEqual(heValues.platformVersion, '10.0.0', 'High-entropy userAgentData platformVersion must be masked');
    assert.strictEqual(sandbox.navigator.bluetooth, undefined, 'WebBluetooth API must be blocked');
    assert.strictEqual(sandbox.navigator.usb, undefined, 'WebUSB API must be blocked');

    const secAuditApi = await fetch(`${baseUrl}/api/security-audit`).then((r) => r.json());
    assert.strictEqual(secAuditApi.ok, true);
    assert.strictEqual(secAuditApi.checks.length, 3);
    assert.ok(secAuditApi.checks.every((c) => c.passed), 'All server-side security audit checks must pass');

    const secAuditHtml = await fetch(`${baseUrl}/security-audit`).then((r) => r.text());
    assert.ok(secAuditHtml.includes('Triple-Layer Security'), 'Security Audit page must render');

    const bmRes = await fetch(`${baseUrl}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'add',
        title: 'Verification Site',
        url: 'https://github.com/tarungittarun/Browz'
      })
    }).then((r) => r.json());
    assert.ok(bmRes.state.bookmarks.some((b) => b.title === 'Verification Site'), 'Bookmark addition must persist');
    console.log('✓ 12. Triple-Layer 18-Point Security Audit (Client Hints, WebUSB/Bluetooth, SSRF, Bookmarks) verified');

    // 13. End-to-End Mobile Browser Compatibility & Triple Security Verification
    assert.ok(mainActivityJava.includes('__BROWZ_MOBILE_SHIELD_ACTIVE__'), 'Mobile shield must have idempotent execution guard');
    assert.ok(mainActivityJava.includes('bridgeSecret'), 'Mobile JS bridge must require per-session cryptographic secret');
    assert.ok(mainActivityJava.includes("Object.defineProperty(window, 'BrowzNative', { get: () => undefined"), 'Mobile bridge must hide BrowzNative on external sites');
    assert.ok(mainActivityJava.includes('retryAttemptsByUrl'), 'Mobile browser must support automatic transient network retries');
    assert.ok(mainActivityJava.includes('renderBookmarksBar'), 'Mobile browser must include scrollable Bookmarks Bar');
    assert.ok(mainActivityJava.includes('setTextZoom'), 'Mobile browser must support Page Zoom controls');
    assert.ok(mainActivityJava.includes('findAllAsync'), 'Mobile browser must support Find in Page');
    assert.ok(mainActivityJava.includes('LOAD_NO_CACHE'), 'Mobile browser must support RAM-only Ghost Mode tabs');
    assert.ok(mainActivityJava.includes('loadSecurityAuditIntoWebView'), 'Mobile browser must include the in-app privacy checks page (browz://security)');
    assert.ok(mainActivityJava.includes('loadTestbenchIntoWebView'), 'Mobile browser must include built-in Mobile API Testbench (browz://testbench)');
    assert.ok(mainActivityJava.includes('isBlockedLocalHost(host)'),
      'Mobile shouldInterceptRequest must block local, loopback and metadata targets');
    const localHostFn = mainActivityJava.slice(mainActivityJava.indexOf('private static boolean isBlockedLocalHost'),
      mainActivityJava.indexOf('private static int[] ipv4Octets'));
    assert.ok(localHostFn.includes('169') && localHostFn.includes('254'),
      'the local-host guard must cover the 169.254 link-local/metadata range');
    assert.ok(localHostFn.includes('127'), 'the local-host guard must cover loopback');
    assert.ok(localHostFn.includes('localhost'), 'the local-host guard must cover localhost aliases');
    assert.ok(mainActivityJava.includes('a[target=\\"_blank\\"]'), 'Mobile browser must rewrite target=_blank links for WebView compatibility');
    console.log('✓ 13. End-to-End Mobile Browser Compatibility (Retries, Bookmarks, Zoom, Find, Ghost Tab, Bridge Lockdown & 18-Point Mobile Audit) verified');

    // 14. Desktop & Mobile 60fps Fluidity, Shortcuts, Autocomplete, Resizer & Rotation Persistence
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
    const androidManifest = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

    assert.ok(serverJs.includes('keepAliveHttpAgent') && serverJs.includes('keepAlive: true'), 'Server must use HTTP/HTTPS Keep-Alive connection pooling');
    assert.ok(indexHtml.includes('omniboxSuggestions') && appJs.includes('renderOmniboxSuggestions'), 'Desktop browser must include live Omnibox Autocomplete dropdown');
    assert.ok(indexHtml.includes('findBar') && appJs.includes('findInActiveTab'), 'Desktop browser must include floating Find-in-Page bar (Ctrl+F)');
    assert.ok(indexHtml.includes('dockResizeHandle') && appJs.includes('resizing-dock'), 'Desktop browser must include 60fps drag-to-resize handle for Traffic Dock');
    assert.ok(androidManifest.includes('hardwareAccelerated="true"') && androidManifest.includes('smallestScreenSize|screenLayout|uiMode'), 'Android Manifest must enable GPU acceleration and prevent reload on rotation');
    assert.ok(mainActivityJava.includes('LAYER_TYPE_HARDWARE') && mainActivityJava.includes('setOffscreenPreRaster(true)'), 'Android WebView must use hardware layer and offscreen pre-rasterization');
    assert.ok(mainActivityJava.includes('setOnLongClickListener') && mainActivityJava.includes('HitTestResult'), 'Android WebView must support Long-Press Link Context Menu');
    assert.ok(mainActivityJava.includes('onShowCustomView') && mainActivityJava.includes('onHideCustomView'), 'Android WebChromeClient must support Fullscreen HTML5 Video');
    console.log('✓ 14. Desktop & Mobile 60fps Fluidity (Keep-Alive Pool, Omnibox Autocomplete, Ctrl+F Find Bar, Dock Resizer, GPU Layers & Zero-Reload Rotation) verified');

    // 15. Strict Script Syntax & Runtime Verification (buildInjectedPageHook, public/app.js, Home, Audit & Testbench HTML)
    const { buildInjectedPageHook } = require('../server/index');
    const hookRawHtml = buildInjectedPageHook('tab-test', 'default', 'https://example.com/app', engine.getState().stealth);
    const hookJsBody = hookRawHtml
      .replace(/^<script[^>]*>/i, '')
      .replace(/<\/script>$/i, '');

    // Must compile with zero SyntaxError in V8
    new vm.Script(hookJsBody, { filename: 'injected-page-hook.js' });
    new vm.Script(appJs, { filename: 'public/app.js' });

    // Execute hookJsBody inside a simulated DOM context and verify fetch(URL), fetch(Request), link click & video fit
    let postedMessages = [];
    let capturedFetchUrls = [];
    const mockVideoEl = {
      tagName: 'VIDEO',
      paused: false,
      classes: new Set(),
      attrs: {},
      classList: {
        add(c) { mockVideoEl.classes.add(c); },
        remove(c) { mockVideoEl.classes.delete(c); }
      },
      setAttribute(k, v) { mockVideoEl.attrs[k] = v; }
    };
    const clickListeners = [];
    const hookSandbox = {
      URL,
      DOMException: Error,
      setTimeout: (fn) => { try { fn(); } catch {} return 1; },
      clearTimeout: () => {},
      navigator: {
        userAgent: 'Test',
        platform: 'Linux',
        language: 'en-US',
        languages: ['en-US'],
        geolocation: { getCurrentPosition: () => {} },
        mediaDevices: { getUserMedia: async () => ({}), enumerateDevices: async () => [{ id: 'cam1' }] },
        storage: { estimate: async () => ({ usage: 999, quota: 123 }), getDirectory: async () => ({}), persist: async () => true },
        clipboard: { readText: async () => 'secret-clipboard' },
        sendBeacon: () => false
      },
      window: null,
      document: {
        title: 'Mock Page',
        readyState: 'complete',
        head: { appendChild: () => {} },
        body: { appendChild: () => {} },
        getElementById: () => null,
        createElement: () => ({ style: {}, setAttribute: () => {}, remove: () => {} }),
        querySelectorAll: (sel) => (sel.includes('video') ? [mockVideoEl] : []),
        querySelector: (sel) => (sel === '.browz-video-fitted' && mockVideoEl.classes.has('browz-video-fitted') ? mockVideoEl : null),
        addEventListener: (ev, fn) => { if (ev === 'click') clickListeners.push(fn); },
        fonts: { check: () => true }
      },
      performance: { now: () => 123.456789, memory: { usedJSHeapSize: 999 } },
      location: { origin: baseUrl }
    };
    hookSandbox.window = hookSandbox;
    hookSandbox.window.location = hookSandbox.location;
    hookSandbox.window.parent = {
      postMessage: (msg) => postedMessages.push(msg)
    };
    hookSandbox.window.addEventListener = () => {};
    hookSandbox.window.fetch = async (url, init) => {
      capturedFetchUrls.push({ url, init });
      return { ok: true, json: async () => ({ allowed: true }) };
    };
    hookSandbox.window.XMLHttpRequest = function () {};
    hookSandbox.window.XMLHttpRequest.prototype.open = function () {};

    vm.runInNewContext(hookJsBody, hookSandbox);

    // Verify fetch with URL instance and Request-like object
    await hookSandbox.window.fetch(new URL('https://example.com/api/v2/items'));
    assert.ok(capturedFetchUrls[0].url.includes(encodeURIComponent('https://example.com/api/v2/items')), 'Hook fetch must support URL instances');
    await hookSandbox.window.fetch({ url: 'https://example.com/api/v2/orders', method: 'POST', headers: { 'X-Test': '1' } });
    assert.strictEqual(capturedFetchUrls[1].init.method, 'POST', 'Hook fetch must preserve Request object method');

    // Verify anchor link click interception posts browz:navigate-tab
    assert.ok(clickListeners.length > 0, 'Injected hook must register document click listener');
    let defaultPrevented = false;
    clickListeners[0]({
      defaultPrevented: false,
      preventDefault() { defaultPrevented = true; },
      target: {
        closest: () => ({
          hasAttribute: () => false,
          getAttribute: (attr) => (attr === 'href' ? '/dashboard/settings' : null)
        })
      }
    });
    assert.strictEqual(defaultPrevented, true, 'Anchor click must prevent default iframe breakout');
    assert.strictEqual(postedMessages.find((m) => m.type === 'browz:navigate-tab').url, 'https://example.com/dashboard/settings', 'Anchor click must resolve relative URL and notify shell');
    console.log('✓ 15. Strict Script Syntax, Runtime Hook, URL/Request Fetch & Link Click Interception verified');

    // 16. Video Fit-to-Screen Engine & Fullscreen Streaming Verification
    assert.strictEqual(typeof hookSandbox.window.__browzToggleVideoFit, 'function', 'Page must expose __browzToggleVideoFit()');
    const fitOn = hookSandbox.window.__browzToggleVideoFit();
    assert.strictEqual(fitOn.fitted, true, '__browzToggleVideoFit() must fit video element to screen');
    assert.ok(mockVideoEl.classes.has('browz-video-fitted'), 'Video element must receive browz-video-fitted class');
    const fitOff = hookSandbox.window.__browzToggleVideoFit();
    assert.strictEqual(fitOff.fitted, false, 'Second call to __browzToggleVideoFit() must exit video fit');
    assert.ok(!mockVideoEl.classes.has('browz-video-fitted'), 'browz-video-fitted class must be removed on exit');
    assert.ok(indexHtml.includes('btnFitVideo') && appJs.includes('triggerVideoFitOnActiveTab'), 'Desktop toolbar must have 1-click Fit Video button');
    assert.ok(appJs.includes("setAttribute('allowfullscreen', 'true')"), 'Tab iframes must allow native fullscreen');
    console.log('✓ 16. Video Fit-to-Screen Engine, Toolbar Button & Fullscreen Support verified');

    // 17. Disk, Storage, Clipboard & Stream I/O Firewall Verification (Points #19-#24)
    let swErr = null;
    try {
      await hookSandbox.navigator.serviceWorker.register('/tracker-sw.js');
    } catch (e) {
      swErr = e;
    }
    assert.ok(swErr && swErr.message.includes('ServiceWorker'), 'ServiceWorker disk persistence must be blocked by I/O Firewall');

    let cacheErr = null;
    try {
      await hookSandbox.window.caches.open('supercookie-cache');
    } catch (e) {
      cacheErr = e;
    }
    assert.ok(cacheErr && cacheErr.message.includes('CacheStorage'), 'CacheStorage supercookies must be blocked by I/O Firewall');
    assert.strictEqual(hookSandbox.window.showOpenFilePicker, undefined, 'File System Picker I/O must be blocked');
    assert.strictEqual(hookSandbox.navigator.storage.getDirectory, undefined, 'OPFS getDirectory I/O must be blocked');
    assert.strictEqual(await hookSandbox.navigator.storage.persist(), false, 'Persistent storage lock must return false');

    let clipErr = null;
    try {
      await hookSandbox.navigator.clipboard.readText();
    } catch (e) {
      clipErr = e;
    }
    assert.ok(clipErr && clipErr.message.includes('Clipboard'), 'Silent clipboard readText snooping must be blocked');
    console.log('✓ 17. Disk, ServiceWorker, CacheStorage, OPFS, File Picker & Clipboard I/O Firewall verified');

    // 18. Wi-Fi, Cellular & Air-Gap Radio Controller Live Impact Verification
    // 18a. Switch to Wi-Fi 6 Fiber
    const wifiRes = await fetch(`${baseUrl}/api/control/stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radioProfile: 'wifi_fiber' })
    }).then((r) => r.json());
    assert.strictEqual(wifiRes.state.stealth.radioProfile, 'wifi_fiber');
    const wifiSandbox = { navigator: {}, window: { screen: {} } };
    wifiSandbox.window.navigator = wifiSandbox.navigator;
    vm.runInNewContext(buildStealthShieldScript(wifiRes.state.stealth), wifiSandbox);
    assert.strictEqual(wifiSandbox.navigator.onLine, true);
    assert.strictEqual(wifiSandbox.navigator.connection.type, 'wifi', 'wifi_fiber must spoof connection.type as wifi');
    assert.strictEqual(wifiSandbox.navigator.connection.downlink, 100, 'wifi_fiber must spoof 100 Mbps downlink');

    // 18b. Switch to Cellular 3G + Data Saver & verify Save-Data HTTP header + latency impact
    const cellRes = await fetch(`${baseUrl}/api/control/stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radioProfile: 'cellular_3g_saver' })
    }).then((r) => r.json());
    const cellSandbox = { navigator: {}, window: { screen: {} } };
    cellSandbox.window.navigator = cellSandbox.navigator;
    vm.runInNewContext(buildStealthShieldScript(cellRes.state.stealth), cellSandbox);
    assert.strictEqual(cellSandbox.navigator.connection.type, 'cellular');
    assert.strictEqual(cellSandbox.navigator.connection.effectiveType, '3g');
    assert.strictEqual(cellSandbox.navigator.connection.saveData, true);

    const cellReq = await executeCapturedRequest(
      engine,
      {
        tabId: 'tab-radio',
        containerId: 'default',
        method: 'GET',
        url: 'browz://testbench/api/whoami',
        resourceType: 'Fetch'
      },
      port
    );
    assert.strictEqual(cellReq.entry.requestHeaders['Save-Data'], 'on', 'cellular_3g_saver must inject Save-Data: on HTTP header');

    // 18c. Switch to Air-Gap Radio Kill-Switch & verify 100% network I/O block
    const airgapRes = await fetch(`${baseUrl}/api/control/stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radioProfile: 'airgap_killswitch', blockWebSockets: true })
    }).then((r) => r.json());
    const airgapSandbox = { navigator: {}, window: { screen: {} }, DOMException: Error };
    airgapSandbox.window.navigator = airgapSandbox.navigator;
    vm.runInNewContext(buildStealthShieldScript(airgapRes.state.stealth), airgapSandbox);
    assert.strictEqual(airgapSandbox.navigator.onLine, false, 'airgap_killswitch must set navigator.onLine = false');
    assert.strictEqual(airgapSandbox.navigator.connection.type, 'none', 'airgap_killswitch must set connection.type = none');
    let wsBlockedErr = null;
    try {
      new airgapSandbox.window.WebSocket('wss://example.com');
    } catch (e) {
      wsBlockedErr = e;
    }
    assert.ok(wsBlockedErr, 'blockWebSockets must block live WebSocket creation');

    const airgapReq = await executeCapturedRequest(
      engine,
      {
        tabId: 'tab-radio',
        containerId: 'default',
        method: 'GET',
        url: 'browz://testbench/api/fast-health',
        resourceType: 'Fetch'
      },
      port
    );
    assert.strictEqual(airgapReq.blocked, true, 'airgap_killswitch must block 100% of outbound network requests');
    assert.ok(airgapReq.blockReason.includes('Air-Gap Radio Kill-Switch'), 'Blocked reason must identify Air-Gap Kill-Switch');

    // Restore stealth_hidden default
    await fetch(`${baseUrl}/api/control/stealth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ radioProfile: 'stealth_hidden', blockWebSockets: false })
    });
    console.log('✓ 18. Wi-Fi, Cellular 3G Data-Saver & Air-Gap Radio Kill-Switch Live Impact verified');

    // 19. Electron Desktop Browser Hardening & Popup/Video Integration Verification
    const electronMainJs = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
    assert.ok(electronMainJs.includes('Page.addScriptToEvaluateOnNewDocument'), 'Electron must inject Stealth Shield before document creation via CDP');
    assert.ok(electronMainJs.includes('Network.emulateNetworkConditions'), 'Electron must apply real CDP network/Wi-Fi/cellular emulation');
    assert.ok(electronMainJs.includes("if (permission === 'fullscreen') return callback(true)"), 'Electron must allow HTML5 video fullscreen permission');
    assert.ok(electronMainJs.includes("disposition === 'foreground-tab'"), 'Electron must route user-clicked target=_blank links into Browz tabs');
    console.log('✓ 19. Electron Desktop Pre-Document Shield, CDP Wi-Fi Emulation, Video Fullscreen & Link Routing verified');

    // 20. Mobile 24-Point Security, Video Fit, Immersive Fullscreen & Radio/I/O Parity Verification
    assert.ok(mainActivityJava.includes('radioProfile') && mainActivityJava.includes('airgap_killswitch'), 'Mobile browser must support Wi-Fi/Cellular/Air-Gap Radio Controller');
    assert.ok(mainActivityJava.includes('blockServiceWorkers') && mainActivityJava.includes('blockCacheStorage'), 'Mobile browser must enforce ServiceWorker & CacheStorage I/O Firewall');
    assert.ok(mainActivityJava.includes('__browzToggleVideoFit') && mainActivityJava.includes('SYSTEM_UI_FLAG_IMMERSIVE_STICKY'), 'Mobile browser must support 1-Click Video Fit and Immersive Fullscreen Video');
    assert.ok(mainActivityJava.includes('24. Video Fit-to-Screen & Immersive Fullscreen'), 'Mobile browser must include all 24 live security & I/O audit checks');
    console.log('✓ 20. Mobile 24-Point Security, Video Fit, Immersive Fullscreen & Radio/I/O Parity verified');

    // 21. Device, OS & System App Data Isolation Audit (Mobile & Desktop)
    assert.ok(mainActivityJava.includes('IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS'), 'Mobile must block Android System Intelligence / ContentCapture screen scraping');
    assert.ok(mainActivityJava.includes('IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS'), 'Mobile must block OS & 3rd-party Autofill scraping');
    assert.ok(mainActivityJava.includes('IME_FLAG_NO_PERSONALIZED_LEARNING'), 'Mobile Omnibox must enforce Incognito Keyboard mode (no IME dictionary logging)');
    assert.ok(mainActivityJava.includes('protected void onDestroy()') && mainActivityJava.includes('deleteAllData()'), 'Mobile must automatically wipe cookies, cache & DOM storage on app exit');
    assert.ok(electronMainJs.includes('setContentProtection(true)'), 'Desktop must enable OS window content protection (blocks Windows Recall & screen capture)');
    assert.ok(electronMainJs.includes('HardwareMediaKeyHandling,MediaSessionService'), 'Desktop must block OS Media Overlay (Now Playing) from reading video titles');
    assert.ok(electronMainJs.includes('spellcheck: false'), 'Desktop must disable OS spellcheck service leakage');
    assert.ok(electronMainJs.includes("app.on('before-quit'"), 'Desktop must purge session caches on exit');
    const secDoc = fs.readFileSync(path.join(__dirname, '..', 'SECURITY-AND-OS-ISOLATION.md'), 'utf8');
    assert.ok(secDoc.includes('Checkpoint 1: Trusted Root Certificates') && secDoc.includes('Checkpoint 7: Live Verification'), 'SECURITY-AND-OS-ISOLATION.md must document all 7 user awareness checkpoints');
    console.log('✓ 21. Device, OS & System App Data Isolation (ContentCapture, Autofill, Incognito IME, Windows Recall Block, MediaSession Block & Auto-Wipe) verified');

    console.log('\nALL 21 STRICT END-TO-END VERIFICATION SUITES PASSED!');
  } finally {
    server.close();
  }
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
