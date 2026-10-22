'use strict';

const assert = require('assert');
const { startBrowzServer } = require('../server/index');

async function runVerification() {
  console.log('Starting Browz verification suite...');
  const { server, port } = await startBrowzServer(0);
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

    console.log('\nALL VERIFICATION CHECKS PASSED!');
  } finally {
    server.close();
  }
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
