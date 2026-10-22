'use strict';

const store = {
  state: null,
  entries: [],
  metrics: {},
  tabs: [],
  activeTabId: null,
  selectedEntryId: null,
  activeInspectorTab: 'headers',
  activeDrawerTab: 'network',
  filters: {
    search: '',
    scope: 'all',
    method: 'ALL',
    type: 'ALL',
    status: 'ALL'
  }
};

let tabCounter = 1;

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getContainerById(containerId) {
  if (!store.state || !store.state.containers) {
    return { id: 'default', name: 'Default', color: '#38bdf8' };
  }
  return (
    store.state.containers.find((c) => c.id === containerId) ||
    store.state.containers[0]
  );
}

// --- API HELPER ---
async function apiPost(url, data = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

// --- TAB MANAGEMENT ---
function createTab({ url = 'browz://testbench', containerId = 'default', switchTo = true } = {}) {
  const id = `tab-${tabCounter++}`;
  const tab = {
    id,
    title: url === 'browz://testbench' ? 'Perf Testbench' : url,
    url,
    containerId,
    history: [url],
    historyIndex: 0
  };
  store.tabs.push(tab);

  const viewport = document.getElementById('browserViewport');
  const iframe = document.createElement('iframe');
  iframe.id = `frame-${id}`;
  iframe.className = 'tab-frame';
  iframe.src = buildProxyFrameSrc(tab);
  viewport.appendChild(iframe);

  if (switchTo || !store.activeTabId) {
    activateTab(id);
  } else {
    renderTabs();
  }
  return tab;
}

function buildProxyFrameSrc(tab) {
  return `/api/proxy?url=${encodeURIComponent(tab.url)}&tabId=${encodeURIComponent(
    tab.id
  )}&containerId=${encodeURIComponent(tab.containerId)}&resourceType=Document&_t=${Date.now()}`;
}

function activateTab(tabId) {
  store.activeTabId = tabId;
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  document.querySelectorAll('.tab-frame').forEach((el) => {
    el.classList.toggle('active', el.id === `frame-${tabId}`);
  });

  const urlInput = document.getElementById('urlInput');
  urlInput.value = tab.url;
  updateSslBadge(tab.url);

  const activeContainerSelect = document.getElementById('activeTabContainerSelect');
  if (activeContainerSelect) {
    activeContainerSelect.value = tab.containerId;
  }

  renderTabs();
  if (store.filters.scope === 'active') {
    renderRequestsTable();
  }
}

function navigateTab(tabId, rawUrl, pushHistory = true) {
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  let url = (rawUrl || '').trim();
  if (!url) url = 'browz://testbench';
  if (
    !url.startsWith('http://') &&
    !url.startsWith('https://') &&
    !url.startsWith('browz://') &&
    !url.startsWith('/')
  ) {
    url = `https://${url}`;
  }

  tab.url = url;
  tab.title = url === 'browz://testbench' ? 'Perf Testbench' : url.replace(/^https?:\/\//, '').slice(0, 32);

  if (pushHistory) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(url);
    tab.historyIndex = tab.history.length - 1;
  }

  const frame = document.getElementById(`frame-${tab.id}`);
  if (frame) {
    frame.src = buildProxyFrameSrc(tab);
  }

  if (store.activeTabId === tab.id) {
    document.getElementById('urlInput').value = tab.url;
    updateSslBadge(tab.url);
  }
  renderTabs();
}

function closeTab(tabId, event) {
  if (event) event.stopPropagation();
  if (store.tabs.length <= 1) {
    navigateTab(tabId, 'browz://testbench');
    return;
  }
  const idx = store.tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  store.tabs.splice(idx, 1);

  const frame = document.getElementById(`frame-${tabId}`);
  if (frame) frame.remove();

  if (store.activeTabId === tabId) {
    const nextTab = store.tabs[Math.max(0, idx - 1)];
    activateTab(nextTab.id);
  } else {
    renderTabs();
  }
}

function updateSslBadge(url) {
  const badge = document.getElementById('sslBadge');
  if (!badge) return;
  if (url.startsWith('browz://')) {
    badge.textContent = '⚡ Internal';
    badge.style.color = '#38bdf8';
  } else if (url.startsWith('https://')) {
    badge.textContent = '🔒 HTTPS';
    badge.style.color = '#10b981';
  } else {
    badge.textContent = '⚠️ HTTP';
    badge.style.color = '#f59e0b';
  }
}

function renderTabs() {
  const container = document.getElementById('tabsContainer');
  if (!container) return;

  container.innerHTML = store.tabs
    .map((tab) => {
      const c = getContainerById(tab.containerId);
      const reqCount = store.entries.filter((e) => e.tabId === tab.id).length;
      const isActive = tab.id === store.activeTabId;
      return `
        <div class="tab-item ${isActive ? 'active' : ''}" onclick="activateTab('${tab.id}')">
          <span class="container-dot" style="background:${c.color}" title="Container: ${escapeHtml(c.name)}"></span>
          <span class="tab-title" title="${escapeHtml(tab.url)}">[${escapeHtml(c.name)}] ${escapeHtml(tab.title)}</span>
          <span class="tab-req-badge" title="${reqCount} captured requests in this tab">${reqCount}</span>
          <button class="tab-close" onclick="closeTab('${tab.id}', event)" title="Close Tab">×</button>
        </div>
      `;
    })
    .join('');
}

function renderContainerSelects() {
  if (!store.state) return;
  const optionsHtml = store.state.containers
    .map((c) => `<option value="${escapeHtml(c.id)}">📦 ${escapeHtml(c.name)}</option>`)
    .join('');

  const newTabSel = document.getElementById('newTabContainerSelect');
  const activeTabSel = document.getElementById('activeTabContainerSelect');
  const prevNew = newTabSel.value;
  newTabSel.innerHTML = optionsHtml;
  if (prevNew) newTabSel.value = prevNew;

  activeTabSel.innerHTML = optionsHtml;
  const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
  if (activeTab) {
    activeTabSel.value = activeTab.containerId;
  }
}

// --- METRICS & REQUEST CAPTURE TABLE ---
function renderMetricsStrip() {
  const m = store.metrics || {};
  document.getElementById('mTotal').textContent = m.total || 0;
  document.getElementById('m2xx').textContent = m.status2xx || 0;
  const errCount = (m.status4xx || 0) + (m.status5xx || 0);
  document.getElementById('mErr').textContent = `${errCount} (${m.errorRate || 0}%)`;
  document.getElementById('mBlocked').textContent = m.blocked || 0;
  document.getElementById('mAvg').textContent = `${m.avgDurationMs || 0} ms`;
  document.getElementById('mP50').textContent = `${m.p50Ms || 0} ms`;
  document.getElementById('mP95').textContent = `${m.p95Ms || 0} ms`;
  document.getElementById('mP99').textContent = `${m.p99Ms || 0} ms`;
  document.getElementById('mRps').textContent = `${m.rps || 0} req/s`;
  document.getElementById('mBytes').textContent = formatBytes(m.totalBytes || 0);
}

function getFilteredEntries() {
  const f = store.filters;
  const q = f.search.trim().toLowerCase();

  return store.entries.filter((e) => {
    if (f.scope === 'active' && e.tabId !== store.activeTabId) return false;
    if (f.method !== 'ALL' && e.method !== f.method) return false;
    if (f.type !== 'ALL' && (e.resourceType || '').toLowerCase() !== f.type.toLowerCase()) return false;

    if (f.status !== 'ALL') {
      if (f.status === 'BLOCKED' && !e.blocked) return false;
      if (f.status === '2xx' && (e.blocked || e.status < 200 || e.status >= 300)) return false;
      if (f.status === '3xx' && (e.blocked || e.status < 300 || e.status >= 400)) return false;
      if (f.status === '4xx' && (e.blocked || e.status < 400 || e.status >= 500)) return false;
      if (f.status === '5xx' && (e.blocked || e.status < 500)) return false;
    }

    if (q) {
      const hay = `${e.url} ${e.method} ${e.status} ${e.requestBody || ''} ${e.responseBody || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function statusClass(e) {
  if (e.blocked || e.status === 0) return 's-blocked';
  if (e.status >= 200 && e.status < 300) return 's-2xx';
  if (e.status >= 300 && e.status < 400) return 's-3xx';
  if (e.status >= 400 && e.status < 500) return 's-4xx';
  return 's-5xx';
}

function renderWaterfallMini(timings) {
  const t = timings || {};
  const total = Math.max(1, t.total || 1);
  const pDns = Math.min(100, ((t.dns || 0) / total) * 100);
  const pConn = Math.min(100, ((t.connect || 0) / total) * 100);
  const pSsl = Math.min(100, ((t.ssl || 0) / total) * 100);
  const pWait = Math.min(100, ((t.wait || 0) / total) * 100);
  const pRecv = Math.max(5, 100 - (pDns + pConn + pSsl + pWait));

  return `
    <div class="waterfall-bar" title="DNS: ${t.dns || 0}ms | Connect: ${t.connect || 0}ms | TLS: ${t.ssl || 0}ms | TTFB: ${t.wait || 0}ms | Download: ${t.receive || 0}ms">
      <div class="wf-seg wf-dns" style="width:${pDns}%"></div>
      <div class="wf-seg wf-conn" style="width:${pConn}%"></div>
      <div class="wf-seg wf-ssl" style="width:${pSsl}%"></div>
      <div class="wf-seg wf-wait" style="width:${pWait}%"></div>
      <div class="wf-seg wf-recv" style="width:${pRecv}%"></div>
    </div>
  `;
}

function renderRequestsTable() {
  const tbody = document.getElementById('requestsTableBody');
  if (!tbody) return;

  const list = getFilteredEntries();
  if (list.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" style="text-align:center;padding:24px;color:var(--text-muted);">
          No captured requests matching current filters. Click buttons in the Testbench above or navigate to any URL to capture live traffic.
        </td>
      </tr>
    `;
    return;
  }

  // Show newest at bottom, render cleanly
  tbody.innerHTML = list
    .map((e) => {
      const c = getContainerById(e.containerId);
      const isSelected = e.id === store.selectedEntryId;
      const rowCls = [
        isSelected ? 'selected' : '',
        e.blocked ? 'row-blocked' : e.status >= 400 ? 'row-error' : ''
      ]
        .filter(Boolean)
        .join(' ');

      return `
        <tr class="${rowCls}" onclick="selectEntry('${e.id}')">
          <td>${e.seq}</td>
          <td>
            <span class="container-dot" style="display:inline-block;background:${c.color};margin-right:4px;"></span>
            ${escapeHtml(c.name)}
          </td>
          <td><span class="method-pill m-${escapeHtml(e.method)}">${escapeHtml(e.method)}</span></td>
          <td><span class="status-pill ${statusClass(e)}">${e.blocked ? 'BLOCKED' : e.status}</span></td>
          <td class="col-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</td>
          <td>${escapeHtml(e.resourceType || 'XHR')}</td>
          <td>${formatBytes(e.transferSize || e.responseBodySize || 0)}</td>
          <td><strong>${e.timings?.total ?? 0} ms</strong></td>
          <td>${renderWaterfallMini(e.timings)}</td>
          <td onclick="event.stopPropagation()">
            <button class="btn btn-sm" onclick="quickReplay('${e.id}')" title="Replay this request">↻</button>
            <button class="btn btn-sm btn-danger" onclick="quickBlockDomain('${e.id}')" title="Block this domain">🛑</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

// --- DEEP REQUEST / RESPONSE INSPECTOR ---
function selectEntry(entryId) {
  store.selectedEntryId = entryId;
  const pane = document.getElementById('inspectorPane');
  pane.classList.remove('hidden');
  renderRequestsTable();
  renderInspector();
}

function formatPrettyBody(raw) {
  if (!raw) return '(Empty Body)';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(raw);
  }
}

function buildCurlForEntry(e) {
  const parts = [`curl -X ${e.method} '${e.url}'`];
  for (const [k, v] of Object.entries(e.requestHeaders || {})) {
    parts.push(`  -H '${k}: ${v}'`);
  }
  if (e.requestBody && !['GET', 'HEAD'].includes(e.method)) {
    parts.push(`  --data-raw '${String(e.requestBody).replace(/'/g, "\\'")}'`);
  }
  return parts.join(' \\\n');
}

function renderInspector() {
  const pane = document.getElementById('inspectorPane');
  const content = document.getElementById('inspectorContent');
  const entry = store.entries.find((e) => e.id === store.selectedEntryId);

  if (!entry) {
    pane.classList.add('hidden');
    return;
  }

  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.itab === store.activeInspectorTab);
  });

  const c = getContainerById(entry.containerId);
  const tab = store.activeInspectorTab;

  if (tab === 'headers') {
    const reqHdrRows = Object.entries(entry.requestHeaders || {})
      .map(([k, v]) => `<div class="kv-row"><div class="kv-key">${escapeHtml(k)}</div><div class="kv-val">${escapeHtml(v)}</div></div>`)
      .join('');
    const resHdrRows = Object.entries(entry.responseHeaders || {})
      .map(([k, v]) => `<div class="kv-row"><div class="kv-key">${escapeHtml(k)}</div><div class="kv-val">${escapeHtml(Array.isArray(v) ? v.join('; ') : v)}</div></div>`)
      .join('');
    const queryRows = (entry.queryString || [])
      .map((q) => `<div class="kv-row"><div class="kv-key">${escapeHtml(q.name)}</div><div class="kv-val">${escapeHtml(q.value)}</div></div>`)
      .join('');

    content.innerHTML = `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">
        <button class="btn btn-sm btn-primary" onclick="quickReplay('${entry.id}')">↻ Replay Request</button>
        <button class="btn btn-sm" onclick="copyCurl('${entry.id}')">📋 Copy as cURL</button>
        <button class="btn btn-sm" onclick="switchInspectorTab('replay')">⚡ Open in Burst / Editor</button>
        <button class="btn btn-sm btn-danger" onclick="quickBlockDomain('${entry.id}')">🛑 Block Domain (${escapeHtml(entry.domain)})</button>
      </div>

      <div class="kv-section">
        <h4>General Overview</h4>
        <div class="kv-row"><div class="kv-key">Request URL</div><div class="kv-val">${escapeHtml(entry.url)}</div></div>
        <div class="kv-row"><div class="kv-key">Request Method</div><div class="kv-val">${escapeHtml(entry.method)}</div></div>
        <div class="kv-row"><div class="kv-key">Status Code</div><div class="kv-val">${entry.blocked ? 'BLOCKED (' + escapeHtml(entry.blockReason) + ')' : entry.status + ' ' + escapeHtml(entry.statusText)}</div></div>
        <div class="kv-row"><div class="kv-key">Remote Address</div><div class="kv-val">${escapeHtml(entry.remoteAddress || '-')}</div></div>
        <div class="kv-row"><div class="kv-key">Container Session</div><div class="kv-val">${escapeHtml(c.name)} (${escapeHtml(entry.containerId)})</div></div>
        <div class="kv-row"><div class="kv-key">Total Duration</div><div class="kv-val">${entry.timings?.total || 0} ms</div></div>
      </div>

      ${queryRows ? `<div class="kv-section"><h4>Query String Parameters</h4>${queryRows}</div>` : ''}
      <div class="kv-section"><h4>Response Headers</h4>${resHdrRows || '<div style="color:var(--text-muted)">None</div>'}</div>
      <div class="kv-section"><h4>Request Headers</h4>${reqHdrRows || '<div style="color:var(--text-muted)">None</div>'}</div>
    `;
  } else if (tab === 'payload') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Request Payload / POST Body (${formatBytes(entry.requestBodySize || 0)})</h4>
        <pre class="code-block">${escapeHtml(formatPrettyBody(entry.requestBody))}</pre>
      </div>
      <div class="kv-section">
        <h4>Equivalent cURL Command</h4>
        <pre class="code-block">${escapeHtml(buildCurlForEntry(entry))}</pre>
      </div>
    `;
  } else if (tab === 'response') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Response Body (${escapeHtml(entry.mimeType || 'text/plain')} — Decoded: ${formatBytes(entry.responseBodySize || 0)}, Transferred: ${formatBytes(entry.transferSize || 0)})</h4>
        <pre class="code-block">${escapeHtml(formatPrettyBody(entry.responseBody))}</pre>
      </div>
    `;
  } else if (tab === 'timings') {
    const t = entry.timings || {};
    const total = Math.max(1, t.total || 1);
    const stages = [
      { label: 'Queueing / Blocked', val: t.blocked || 0, color: '#64748b' },
      { label: 'DNS Lookup', val: t.dns || 0, color: '#06b6d4' },
      { label: 'TCP Connection', val: t.connect || 0, color: '#f59e0b' },
      { label: 'TLS Handshake', val: t.ssl || 0, color: '#a855f7' },
      { label: 'Request Sent', val: t.send || 0, color: '#38bdf8' },
      { label: 'Waiting (TTFB)', val: t.wait || 0, color: '#10b981' },
      { label: 'Content Download', val: t.receive || 0, color: '#3b82f6' }
    ];

    content.innerHTML = `
      <div class="kv-section">
        <h4>Performance Timing Breakdown (Total: ${t.total || 0} ms)</h4>
        ${stages
          .map((s) => {
            const pct = Math.min(100, Math.max(2, (s.val / total) * 100));
            return `
              <div class="timing-row">
                <span>${s.label}</span>
                <div class="timing-track">
                  <div class="timing-fill" style="width:${pct}%;background:${s.color};"></div>
                </div>
                <strong style="text-align:right;font-family:var(--font-mono);">${s.val} ms</strong>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  } else if (tab === 'cookies') {
    const reqC = (entry.requestCookies || [])
      .map((ck) => `<div class="kv-row"><div class="kv-key">${escapeHtml(ck.name)}</div><div class="kv-val">${escapeHtml(ck.value)}</div></div>`)
      .join('');
    const resC = (entry.responseCookies || [])
      .map((ck) => `<div class="kv-row"><div class="kv-key">${escapeHtml(ck.name)}</div><div class="kv-val">${escapeHtml(ck.value)}</div></div>`)
      .join('');

    content.innerHTML = `
      <div class="kv-section">
        <h4>Request Cookies Sent (Container: ${escapeHtml(c.name)})</h4>
        ${reqC || '<div style="color:var(--text-muted)">No cookies sent with request.</div>'}
      </div>
      <div class="kv-section">
        <h4>Response Set-Cookie Stored in Container</h4>
        ${resC || '<div style="color:var(--text-muted)">No Set-Cookie headers in response.</div>'}
      </div>
    `;
  } else if (tab === 'replay') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Edit & Replay Request / Run Concurrent Load Burst</h4>
        <div class="form-row">
          <select id="compMethod" class="select-input">
            ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `<option value="${m}" ${entry.method === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <input type="text" id="compUrl" class="text-input" style="flex:1;" value="${escapeHtml(entry.url)}" />
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:11px;color:var(--text-muted);">Request Headers (JSON):</label>
          <textarea id="compHeaders" class="text-input" style="width:100%;height:70px;margin-top:4px;font-family:var(--font-mono);">${escapeHtml(JSON.stringify(entry.requestHeaders || {}, null, 2))}</textarea>
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:11px;color:var(--text-muted);">Request Body / Payload:</label>
          <textarea id="compBody" class="text-input" style="width:100%;height:70px;margin-top:4px;font-family:var(--font-mono);">${escapeHtml(entry.requestBody || '')}</textarea>
        </div>
        <div class="form-row" style="margin-top:10px;align-items:center;">
          <button class="btn btn-primary" onclick="executeComposerReplay()">▶ Send Single Request</button>
          <span style="color:var(--text-muted);font-size:11px;margin-left:6px;">Burst Count:</span>
          <input type="number" id="compBurstCount" class="text-input" value="10" min="1" max="50" style="width:58px;" />
          <span style="color:var(--text-muted);font-size:11px;">Concurrency:</span>
          <input type="number" id="compBurstConc" class="text-input" value="5" min="1" max="25" style="width:52px;" />
          <button class="btn btn-success" onclick="executeComposerBurst()">🔥 Run Load Burst</button>
        </div>
      </div>
    `;
  }
}

function switchInspectorTab(tabName) {
  store.activeInspectorTab = tabName;
  renderInspector();
}

async function quickReplay(entryId) {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return;
  await apiPost('/api/replay', {
    tabId: entry.tabId,
    containerId: entry.containerId,
    method: entry.method,
    url: entry.url,
    headers: entry.requestHeaders,
    body: entry.requestBody,
    resourceType: 'Replay'
  });
}

async function quickBlockDomain(entryId) {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry || !entry.domain) return;
  await apiPost('/api/control/block-rule', {
    action: 'add',
    pattern: entry.domain,
    resourceType: 'ALL',
    note: `Blocked from Capture Table`
  });
}

async function copyCurl(entryId) {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return;
  const cmd = buildCurlForEntry(entry);
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {
    // fallback
  }
}

async function executeComposerReplay() {
  const method = document.getElementById('compMethod').value;
  const url = document.getElementById('compUrl').value;
  let headers = {};
  try {
    headers = JSON.parse(document.getElementById('compHeaders').value || '{}');
  } catch {}
  const body = document.getElementById('compBody').value;
  const activeTab = store.tabs.find((t) => t.id === store.activeTabId);

  await apiPost('/api/replay', {
    tabId: store.activeTabId || 'tab-1',
    containerId: activeTab ? activeTab.containerId : 'default',
    method,
    url,
    headers,
    body,
    resourceType: 'Replay'
  });
}

async function executeComposerBurst() {
  const method = document.getElementById('compMethod').value;
  const url = document.getElementById('compUrl').value;
  let headers = {};
  try {
    headers = JSON.parse(document.getElementById('compHeaders').value || '{}');
  } catch {}
  const body = document.getElementById('compBody').value;
  const count = Number(document.getElementById('compBurstCount').value || 10);
  const concurrency = Number(document.getElementById('compBurstConc').value || 5);
  const activeTab = store.tabs.find((t) => t.id === store.activeTabId);

  await apiPost('/api/burst', {
    tabId: store.activeTabId || 'tab-1',
    containerId: activeTab ? activeTab.containerId : 'default',
    method,
    url,
    headers,
    body,
    count,
    concurrency
  });
}

// --- EXPORTS ---
function exportCapture(format) {
  const tabQuery =
    store.filters.scope === 'active' && store.activeTabId
      ? `?tabId=${encodeURIComponent(store.activeTabId)}`
      : '';
  window.open(`/api/export/${format}${tabQuery}`, '_blank');
}

// --- GOD-MODE CONTROL DRAWER (#2, #4, #5) ---
function renderControlDrawer() {
  if (!store.state) return;
  const body = document.getElementById('drawerBody');
  if (!body) return;

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dtab === store.activeDrawerTab);
  });

  const nc = store.state.networkControl;
  const cap = store.state.capture;

  if (store.activeDrawerTab === 'network') {
    body.innerHTML = `
      <div class="ctrl-card">
        <h3>1. Interception & Privacy Switches (#2)</h3>
        <label class="toggle-line">
          <span>Disable Browser Cache (Accurate Perf Timings)</span>
          <input type="checkbox" ${cap.disableCache ? 'checked' : ''} onchange="updateCaptureSetting({ disableCache: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Capture Full Request/Response Bodies</span>
          <input type="checkbox" ${cap.captureBodies ? 'checked' : ''} onchange="updateCaptureSetting({ captureBodies: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Bypass CORS (Inject Access-Control-Allow-Origin: *)</span>
          <input type="checkbox" ${nc.bypassCors ? 'checked' : ''} onchange="updateNetworkSetting({ bypassCors: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Force HTTPS Upgrade on External Requests</span>
          <input type="checkbox" ${nc.forceHttps ? 'checked' : ''} onchange="updateNetworkSetting({ forceHttps: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Strip Referer Header</span>
          <input type="checkbox" ${nc.stripReferer ? 'checked' : ''} onchange="updateNetworkSetting({ stripReferer: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Strip Sec-CH-UA Client-Hint Tracking Headers</span>
          <input type="checkbox" ${nc.stripTrackingHeaders ? 'checked' : ''} onchange="updateNetworkSetting({ stripTrackingHeaders: this.checked })" />
        </label>
      </div>

      <div class="ctrl-card">
        <h3>2. User-Agent & Identity Spoofing</h3>
        <select class="select-input" style="width:100%;" onchange="updateNetworkSetting({ userAgentPreset: this.value })">
          <option value="default" ${nc.userAgentPreset === 'default' ? 'selected' : ''}>Browz Default (Chromium 130)</option>
          <option value="chrome_win" ${nc.userAgentPreset === 'chrome_win' ? 'selected' : ''}>Chrome 131 (Windows 11)</option>
          <option value="firefox_mac" ${nc.userAgentPreset === 'firefox_mac' ? 'selected' : ''}>Firefox 132 (macOS)</option>
          <option value="safari_ios" ${nc.userAgentPreset === 'safari_ios' ? 'selected' : ''}>Safari Mobile (iPhone iOS 18)</option>
          <option value="googlebot" ${nc.userAgentPreset === 'googlebot' ? 'selected' : ''}>Googlebot Crawler</option>
          <option value="k6_loadtest" ${nc.userAgentPreset === 'k6_loadtest' ? 'selected' : ''}>k6 Load Test Agent</option>
        </select>
      </div>

      <div class="ctrl-card">
        <h3>3. Custom Request Header Injection</h3>
        ${(nc.customRequestHeaders || [])
          .map(
            (h) => `
            <div class="rule-item">
              <input type="checkbox" ${h.enabled ? 'checked' : ''} onchange="toggleHeaderRule('request', '${h.id}')" />
              <span style="flex:1;"><strong>${escapeHtml(h.name)}</strong>: ${escapeHtml(h.value)}</span>
              <button class="btn btn-sm btn-danger" onclick="deleteHeaderRule('request', '${h.id}')">×</button>
            </div>
          `
          )
          .join('')}
        <div class="form-row">
          <input type="text" id="newHdrName" class="text-input" placeholder="Header Name" style="width:115px;" />
          <input type="text" id="newHdrVal" class="text-input" placeholder="Header Value" style="flex:1;" />
          <button class="btn btn-sm btn-primary" onclick="addHeaderRule('request')">+ Add</button>
        </div>
      </div>

      <div class="ctrl-card">
        <h3>4. URL / Domain / Resource Block Rules</h3>
        ${(nc.blockRules || [])
          .map(
            (r) => `
            <div class="rule-item">
              <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleBlockRule('${r.id}')" />
              <span style="flex:1;">[${escapeHtml(r.resourceType)}] <strong>${escapeHtml(r.pattern)}</strong></span>
              <button class="btn btn-sm btn-danger" onclick="deleteBlockRule('${r.id}')">×</button>
            </div>
          `
          )
          .join('')}
        <div class="form-row">
          <input type="text" id="newBlkPattern" class="text-input" placeholder="Domain or URL pattern…" style="flex:1;" />
          <select id="newBlkType" class="select-input">
            <option value="ALL">ALL</option>
            <option value="Script">Script</option>
            <option value="Image">Image</option>
            <option value="Font">Font</option>
            <option value="Fetch">Fetch</option>
          </select>
          <button class="btn btn-sm btn-primary" onclick="addBlockRule()">+ Block</button>
        </div>
      </div>

      <div class="ctrl-card">
        <h3>5. Proxy & DNS-over-HTTPS Routing</h3>
        <div class="form-row">
          <select id="proxyMode" class="select-input" onchange="saveProxyConfig()">
            <option value="direct" ${nc.proxy.mode === 'direct' ? 'selected' : ''}>Direct Connection</option>
            <option value="http" ${nc.proxy.mode === 'http' ? 'selected' : ''}>HTTP/HTTPS Proxy</option>
            <option value="socks5" ${nc.proxy.mode === 'socks5' ? 'selected' : ''}>SOCKS5 / Tor Proxy</option>
          </select>
          <input type="text" id="proxyRules" class="text-input" style="flex:1;" placeholder="e.g. socks5://127.0.0.1:9050" value="${escapeHtml(nc.proxy.rules || '')}" onchange="saveProxyConfig()" />
        </div>
      </div>
    `;
  } else if (store.activeDrawerTab === 'containers') {
    body.innerHTML = `
      <div class="ctrl-card">
        <h3>Create Isolated Container Session (#4)</h3>
        <div class="form-row">
          <input type="text" id="newCntName" class="text-input" placeholder="Container Name (e.g. User C)" style="flex:1;" />
          <input type="color" id="newCntColor" value="#06b6d4" style="width:34px;height:30px;border:none;background:transparent;" />
        </div>
        <div class="form-row" style="align-items:center;justify-content:space-between;">
          <label style="font-size:11.5px;color:var(--text-secondary);">
            <input type="checkbox" id="newCntEphemeral" /> Burner (RAM-only, wipes on close)
          </label>
          <button class="btn btn-sm btn-primary" onclick="createNewContainer()">+ Create Container</button>
        </div>
      </div>

      ${store.state.containers
        .map((c) => {
          const cookieEntries = [];
          for (const [dom, jar] of Object.entries(c.cookies || {})) {
            for (const [k, v] of Object.entries(jar || {})) {
              cookieEntries.push(`${dom}: ${k}=${v}`);
            }
          }
          return `
            <div class="ctrl-card">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span style="font-weight:700;display:flex;align-items:center;gap:6px;">
                  <span class="container-dot" style="background:${c.color}"></span>
                  ${escapeHtml(c.name)}
                </span>
                <span style="font-size:10.5px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(c.partition)}</span>
              </div>
              <div style="font-size:11px;color:var(--text-secondary);margin-bottom:6px;">
                Isolated Cookies: <strong>${cookieEntries.length}</strong>
                ${c.storageStats?.lastCleared ? ` | Cleared: ${new Date(c.storageStats.lastCleared).toLocaleTimeString()}` : ''}
              </div>
              <div class="code-block" style="max-height:70px;font-size:10.5px;margin-bottom:8px;">${
                cookieEntries.length ? escapeHtml(cookieEntries.join('\n')) : '(Empty Cookie Jar)'
              }</div>
              <div class="form-row">
                <button class="btn btn-sm" onclick="createTab({ url: 'browz://testbench', containerId: '${c.id}', switchTo: true })">+ Open Tab</button>
                <button class="btn btn-sm btn-danger" onclick="clearContainerStorage('${c.id}')">🧹 Wipe Cookies & Storage</button>
              </div>
            </div>
          `;
        })
        .join('')}
    `;
  } else if (store.activeDrawerTab === 'permissions') {
    const perms = store.state.permissions;
    const dls = store.state.downloads;

    body.innerHTML = `
      <div class="ctrl-card">
        <h3>Hardware & Permission Firewall (#5)</h3>
        ${Object.entries(perms.globalDefaults)
          .map(
            ([perm, dec]) => `
            <div class="toggle-line">
              <span style="text-transform:capitalize;">${escapeHtml(perm)}</span>
              <select class="select-input" onchange="updateGlobalPermission('${perm}', this.value)">
                <option value="allow" ${dec === 'allow' ? 'selected' : ''}>✅ Allow</option>
                <option value="deny" ${dec === 'deny' ? 'selected' : ''}>🛑 Deny (Block)</option>
              </select>
            </div>
          `
          )
          .join('')}
      </div>

      <div class="ctrl-card">
        <h3>Intercepted Permission Firewall Log</h3>
        ${(perms.eventLog || [])
          .slice(0, 6)
          .map(
            (ev) => `
            <div class="rule-item">
              <span><strong>${escapeHtml(ev.permission)}</strong> @ ${escapeHtml(ev.origin)}</span>
              <span class="status-pill ${ev.decision === 'allow' ? 's-2xx' : 's-blocked'}">${escapeHtml(ev.decision.toUpperCase())}</span>
            </div>
          `
          )
          .join('')}
      </div>

      <div class="ctrl-card">
        <h3>Download Controller & Extension Blocker</h3>
        <label class="toggle-line">
          <span>Auto-Block Dangerous Extensions (.exe, .bat, .msi, .apk)</span>
          <input type="checkbox" ${dls.autoBlockDangerous ? 'checked' : ''} onchange="updateDownloadConfig(this.checked)" />
        </label>
        ${(dls.items || [])
          .slice(0, 6)
          .map(
            (item) => `
            <div class="rule-item">
              <span style="flex:1;"><strong>${escapeHtml(item.filename)}</strong> (${formatBytes(item.totalBytes)})</span>
              <span class="status-pill ${item.state === 'blocked-extension' ? 's-blocked' : 's-2xx'}">${escapeHtml(item.state)}</span>
            </div>
          `
          )
          .join('')}
      </div>
    `;
  }
}

// --- CONTROL HANDLERS ---
async function updateCaptureSetting(patch) {
  const res = await apiPost('/api/control/capture', patch);
  if (res.state) {
    store.state = res.state;
    syncTopBarControls();
    renderControlDrawer();
  }
}

async function updateNetworkSetting(patch) {
  const res = await apiPost('/api/control/network', patch);
  if (res.state) {
    store.state = res.state;
    renderControlDrawer();
  }
}

async function addHeaderRule(target) {
  const name = document.getElementById('newHdrName').value.trim();
  const value = document.getElementById('newHdrVal').value.trim();
  if (!name) return;
  await apiPost('/api/control/header-rule', { action: 'add', target, name, value });
}

async function toggleHeaderRule(target, id) {
  await apiPost('/api/control/header-rule', { action: 'toggle', target, id });
}

async function deleteHeaderRule(target, id) {
  await apiPost('/api/control/header-rule', { action: 'delete', target, id });
}

async function addBlockRule() {
  const pattern = document.getElementById('newBlkPattern').value.trim();
  const resourceType = document.getElementById('newBlkType').value;
  if (!pattern) return;
  await apiPost('/api/control/block-rule', { action: 'add', pattern, resourceType });
}

async function toggleBlockRule(id) {
  await apiPost('/api/control/block-rule', { action: 'toggle', id });
}

async function deleteBlockRule(id) {
  await apiPost('/api/control/block-rule', { action: 'delete', id });
}

async function saveProxyConfig() {
  const mode = document.getElementById('proxyMode').value;
  const rules = document.getElementById('proxyRules').value.trim();
  await updateNetworkSetting({
    proxy: { ...store.state.networkControl.proxy, mode, rules }
  });
}

async function createNewContainer() {
  const name = document.getElementById('newCntName').value.trim();
  const color = document.getElementById('newCntColor').value;
  const ephemeral = document.getElementById('newCntEphemeral').checked;
  if (!name) return;
  await apiPost('/api/containers', { action: 'create', name, color, ephemeral });
}

async function clearContainerStorage(containerId) {
  await apiPost('/api/containers', { action: 'clear-storage', containerId });
}

async function updateGlobalPermission(permission, decision) {
  await apiPost('/api/permissions/update', { scope: 'global', permission, decision });
}

async function updateDownloadConfig(autoBlockDangerous) {
  await apiPost('/api/downloads/config', { autoBlockDangerous });
}

function syncTopBarControls() {
  if (!store.state) return;
  const recBtn = document.getElementById('btnRecordToggle');
  const recTxt = document.getElementById('recStatusText');
  const isRec = store.state.capture.recording;
  recBtn.classList.toggle('paused', !isRec);
  recTxt.textContent = isRec ? 'REC' : 'PAUSED';

  const thr = document.getElementById('throttleSelect');
  if (thr && store.state.capture.throttling?.preset) {
    thr.value = store.state.capture.throttling.preset;
  }
}

// --- INITIALIZATION & WEBSOCKET ---
async function initApp() {
  const res = await fetch('/api/bootstrap').then((r) => r.json());
  store.state = res.state;
  store.entries = res.entries || [];
  store.metrics = res.metrics || {};

  renderContainerSelects();
  syncTopBarControls();
  renderMetricsStrip();
  renderControlDrawer();

  // Open 2 initial tabs in different isolated containers to showcase multi-tab + container isolation
  createTab({ url: 'browz://testbench', containerId: 'default', switchTo: true });
  createTab({ url: 'browz://testbench', containerId: 'user-a', switchTo: false });

  renderRequestsTable();

  // Connect real-time WebSocket stream
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'entry:new') {
        store.entries.push(msg.payload.entry);
        store.metrics = msg.payload.metrics;
        renderMetricsStrip();
        renderTabs();
        renderRequestsTable();
      } else if (msg.type === 'entries:cleared') {
        store.entries = msg.payload.entries || [];
        store.metrics = msg.payload.metrics || {};
        store.selectedEntryId = null;
        renderMetricsStrip();
        renderTabs();
        renderRequestsTable();
        renderInspector();
      } else if (msg.type === 'state:updated') {
        store.state = msg.payload;
        renderContainerSelects();
        syncTopBarControls();
        renderControlDrawer();
      } else if (msg.type === 'permission:event') {
        if (store.state && store.state.permissions) {
          store.state.permissions.eventLog.unshift(msg.payload);
          if (store.activeDrawerTab === 'permissions') renderControlDrawer();
        }
      }
    } catch {}
  };

  // Listen for postMessages from inside tab frames
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;
    if (data.type === 'browz:page-meta') {
      const tab = store.tabs.find((t) => t.id === data.tabId);
      if (tab && data.title) {
        tab.title = data.title.slice(0, 32);
        renderTabs();
      }
    } else if (data.type === 'browz:navigate-tab') {
      navigateTab(data.tabId, data.url, true);
    } else if (data.type === 'browz:open-tab') {
      createTab({ url: data.url, containerId: data.containerId || 'default', switchTo: true });
    }
  });

  // Bind UI Events
  document.getElementById('btnNewTab').addEventListener('click', () => {
    const containerId = document.getElementById('newTabContainerSelect').value || 'default';
    createTab({ url: 'browz://testbench', containerId, switchTo: true });
  });

  document.getElementById('activeTabContainerSelect').addEventListener('change', (e) => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    tab.containerId = e.target.value;
    navigateTab(tab.id, tab.url, false);
  });

  document.getElementById('addressForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = document.getElementById('urlInput').value;
    if (store.activeTabId) navigateTab(store.activeTabId, val, true);
  });

  document.getElementById('quickTargetSelect').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val && store.activeTabId) {
      navigateTab(store.activeTabId, val, true);
      e.target.value = '';
    }
  });

  document.getElementById('btnBack').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (tab && tab.historyIndex > 0) {
      tab.historyIndex--;
      navigateTab(tab.id, tab.history[tab.historyIndex], false);
    }
  });

  document.getElementById('btnForward').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (tab && tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      navigateTab(tab.id, tab.history[tab.historyIndex], false);
    }
  });

  document.getElementById('btnReload').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (tab) navigateTab(tab.id, tab.url, false);
  });

  document.getElementById('btnRecordToggle').addEventListener('click', () => {
    const next = !store.state.capture.recording;
    updateCaptureSetting({ recording: next });
  });

  document.getElementById('throttleSelect').addEventListener('change', (e) => {
    updateCaptureSetting({ throttlingPreset: e.target.value });
  });

  document.getElementById('layoutModeSelect').addEventListener('change', (e) => {
    const stack = document.getElementById('centerStack');
    stack.classList.remove('dock-maximized', 'viewport-maximized');
    if (e.target.value === 'dock') stack.classList.add('dock-maximized');
    if (e.target.value === 'viewport') stack.classList.add('viewport-maximized');
  });

  document.getElementById('btnToggleDrawer').addEventListener('click', () => {
    document.getElementById('controlDrawer').classList.toggle('hidden');
  });

  document.getElementById('btnCloseDrawer').addEventListener('click', () => {
    document.getElementById('controlDrawer').classList.add('hidden');
  });

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.activeDrawerTab = btn.dataset.dtab;
      renderControlDrawer();
    });
  });

  document.querySelectorAll('.insp-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.activeInspectorTab = btn.dataset.itab;
      renderInspector();
    });
  });

  document.getElementById('btnCloseInspector').addEventListener('click', () => {
    store.selectedEntryId = null;
    document.getElementById('inspectorPane').classList.add('hidden');
    renderRequestsTable();
  });

  document.getElementById('btnOpenComposer').addEventListener('click', () => {
    if (!store.selectedEntryId && store.entries.length > 0) {
      store.selectedEntryId = store.entries[store.entries.length - 1].id;
    }
    store.activeInspectorTab = 'replay';
    document.getElementById('inspectorPane').classList.remove('hidden');
    renderInspector();
  });

  document.getElementById('btnClearCapture').addEventListener('click', async () => {
    const tabId = store.filters.scope === 'active' ? store.activeTabId : null;
    await apiPost('/api/entries/clear', { tabId });
  });

  // Filter bindings
  document.getElementById('filterSearch').addEventListener('input', (e) => {
    store.filters.search = e.target.value;
    renderRequestsTable();
  });
  document.getElementById('filterScope').addEventListener('change', (e) => {
    store.filters.scope = e.target.value;
    renderRequestsTable();
  });
  document.getElementById('filterMethod').addEventListener('change', (e) => {
    store.filters.method = e.target.value;
    renderRequestsTable();
  });
  document.getElementById('filterType').addEventListener('change', (e) => {
    store.filters.type = e.target.value;
    renderRequestsTable();
  });
  document.getElementById('filterStatus').addEventListener('change', (e) => {
    store.filters.status = e.target.value;
    renderRequestsTable();
  });
}

window.addEventListener('DOMContentLoaded', initApp);
