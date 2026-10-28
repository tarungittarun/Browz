'use strict';

const store = {
  state: null,
  entries: [],
  metrics: {},
  tabs: [],
  activeTabId: null,
  selectedEntryId: null,
  activeInspectorTab: 'headers',
  activeDrawerTab: 'stealth',
  dockOpen: false,
  dockMaximized: false,
  zoomLevel: 100,
  browsingHistory: [
    { title: 'Browz Home', url: 'browz://home' },
    { title: '18-Point Triple Security Audit', url: 'browz://security' },
    { title: 'API & Load Testbench', url: 'browz://testbench' }
  ],
  omniboxSelectedIdx: -1,
  omniboxCurrentItems: [],
  filters: {
    search: '',
    scope: 'all',
    method: 'ALL',
    type: 'ALL',
    status: 'ALL'
  }
};

let tabCounter = 1;
let toastTimer = null;
let renderTableScheduled = false;
let loadingProgressTimer = null;

function showToast(message) {
  const el = document.getElementById('browzToast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
  }, 2400);
}

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
    return { id: 'default', name: 'Default', color: '#3b82f6' };
  }
  return (
    store.state.containers.find((c) => c.id === containerId) ||
    store.state.containers[0]
  );
}

function isStandaloneElectron() {
  return Boolean(window.browzElectron && window.browzElectron.isElectron);
}

function getChromiumPartitionForContainer(containerId) {
  const c = getContainerById(containerId);
  if (!c || !c.partition) return 'persist:default';
  return c.partition.startsWith('ephemeral:')
    ? c.partition.replace(/^ephemeral:/, 'ram_')
    : c.partition;
}

async function apiPost(url, data = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return res.json();
}

function resolveInputToUrl(rawInput) {
  const input = (rawInput || '').trim();
  if (!input) return 'browz://home';
  if (
    input.startsWith('http://') ||
    input.startsWith('https://') ||
    input.startsWith('browz://') ||
    input.startsWith('/')
  ) {
    return input;
  }
  const looksLikeDomain =
    /^([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(:\d+)?(\/.*)?$/.test(input) ||
    /^localhost(:\d+)?(\/.*)?$/.test(input);
  if (looksLikeDomain && !input.includes(' ')) {
    return `https://${input}`;
  }
  const engine = store.state?.stealth?.searchEngine || 'duckduckgo';
  const q = encodeURIComponent(input);
  if (engine === 'google') return `https://www.google.com/search?q=${q}`;
  if (engine === 'startpage') return `https://www.startpage.com/sp/search?query=${q}`;
  if (engine === 'brave') return `https://search.brave.com/search?q=${q}`;
  return `https://duckduckgo.com/?q=${q}`;
}

function getFriendlyTabTitle(url) {
  if (!url || url.startsWith('browz://home') || url.endsWith('/home')) return 'New Tab';
  if (url.startsWith('browz://security') || url.endsWith('/security-audit')) return 'Security Audit';
  if (url.startsWith('browz://testbench') || url.endsWith('/testbench')) return 'API Testbench';
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').slice(0, 28);
}

function resolveElectronWebviewSrc(url) {
  if (!url || url.startsWith('browz://home')) {
    return `${location.origin}/home`;
  }
  if (url.startsWith('browz://security')) {
    return `${location.origin}/security-audit`;
  }
  if (url.startsWith('browz://testbench')) {
    const suffix = url.replace(/^browz:\/\/testbench/i, '') || '';
    return `${location.origin}/testbench${suffix}`;
  }
  if (url.startsWith('/')) {
    return `${location.origin}${url}`;
  }
  return url;
}

// --- LOADING PROGRESS BAR & NAVIGATION STATE ---
function startTabLoading(tab) {
  if (!tab) return;
  tab.loading = true;
  renderTabs();
  syncNavButtonsState();

  if (tab.id === store.activeTabId) {
    const bar = document.getElementById('browserLoadingBar');
    if (bar) {
      if (loadingProgressTimer) clearTimeout(loadingProgressTimer);
      bar.classList.add('active');
      bar.style.width = '28%';
      loadingProgressTimer = setTimeout(() => {
        if (tab.loading) bar.style.width = '74%';
      }, 180);
    }
  }
}

function finishTabLoading(tab) {
  if (!tab) return;
  tab.loading = false;
  renderTabs();
  syncNavButtonsState();

  if (tab.id === store.activeTabId) {
    const bar = document.getElementById('browserLoadingBar');
    if (bar) {
      if (loadingProgressTimer) clearTimeout(loadingProgressTimer);
      bar.style.width = '100%';
      loadingProgressTimer = setTimeout(() => {
        bar.classList.remove('active');
        bar.style.width = '0%';
      }, 220);
    }
  }
}

function syncNavButtonsState() {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  const backBtn = document.getElementById('btnBack');
  const fwdBtn = document.getElementById('btnForward');
  const reloadBtn = document.getElementById('btnReload');

  if (!tab) return;

  let canBack = tab.historyIndex > 0;
  let canFwd = tab.historyIndex < tab.history.length - 1;
  const frame = document.getElementById(`frame-${tab.id}`);
  if (isStandaloneElectron() && frame) {
    try {
      if (typeof frame.canGoBack === 'function') canBack = canBack || frame.canGoBack();
      if (typeof frame.canGoForward === 'function') canFwd = canFwd || frame.canGoForward();
    } catch {}
  }

  if (backBtn) backBtn.disabled = !canBack;
  if (fwdBtn) fwdBtn.disabled = !canFwd;

  if (reloadBtn) {
    if (tab.loading) {
      reloadBtn.title = 'Stop Loading';
      reloadBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
    } else {
      reloadBtn.title = 'Reload Page';
      reloadBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
    }
  }
}

// --- TAB MANAGEMENT ---
function createTab({ url = 'browz://home', containerId = 'default', switchTo = true } = {}) {
  const id = `tab-${tabCounter++}`;
  const tab = {
    id,
    title: getFriendlyTabTitle(url),
    url,
    containerId,
    loading: true,
    history: [url],
    historyIndex: 0
  };
  store.tabs.push(tab);

  const viewport = document.getElementById('browserViewport');
  let viewEl;

  if (isStandaloneElectron()) {
    viewEl = document.createElement('webview');
    viewEl.id = `frame-${id}`;
    viewEl.className = 'tab-frame';
    viewEl.style.width = '100%';
    viewEl.style.height = '100%';
    viewEl.style.flex = '1 1 auto';
    viewEl.setAttribute('partition', getChromiumPartitionForContainer(containerId));
    viewEl.setAttribute('allowpopups', 'false');
    viewEl.src = resolveElectronWebviewSrc(url);

    const ensureFullSize = () => {
      try {
        viewEl.style.width = '100%';
        viewEl.style.height = '100%';
        viewEl.style.flex = '1 1 auto';
        const shadowIframe = viewEl.shadowRoot && viewEl.shadowRoot.querySelector('iframe');
        if (shadowIframe) {
          shadowIframe.style.width = '100%';
          shadowIframe.style.height = '100%';
          shadowIframe.style.flex = '1 1 auto';
        }
      } catch {}
    };
    viewEl.addEventListener('did-start-loading', () => startTabLoading(tab));
    viewEl.addEventListener('dom-ready', ensureFullSize);
    viewEl.addEventListener('did-stop-loading', () => {
      ensureFullSize();
      finishTabLoading(tab);
    });
    viewEl.addEventListener('did-fail-load', () => finishTabLoading(tab));

    viewEl.addEventListener('page-title-updated', (e) => {
      if (e.title) {
        tab.title = e.title.slice(0, 28);
        renderTabs();
      }
    });

    const handleWebviewUrlChange = (navUrl) => {
      if (!navUrl) return;
      if (navUrl.startsWith(`${location.origin}/home`)) {
        tab.url = 'browz://home';
        tab.title = 'New Tab';
      } else if (navUrl.startsWith(`${location.origin}/security-audit`)) {
        tab.url = 'browz://security';
        tab.title = 'Security Audit';
      } else if (navUrl.startsWith(`${location.origin}/testbench`)) {
        tab.url = 'browz://testbench';
        tab.title = 'API Testbench';
      } else if (!navUrl.includes('/api/proxy')) {
        tab.url = navUrl;
        tab.title = getFriendlyTabTitle(navUrl);
      }
      if (store.activeTabId === tab.id) {
        syncAddressBar(tab.url);
      }
      renderTabs();
    };

    viewEl.addEventListener('did-navigate', (e) => handleWebviewUrlChange(e.url));
    viewEl.addEventListener('did-navigate-in-page', (e) => {
      if (e.isMainFrame) handleWebviewUrlChange(e.url);
    });
  } else {
    viewEl = document.createElement('iframe');
    viewEl.id = `frame-${id}`;
    viewEl.className = 'tab-frame';
    viewEl.setAttribute('allowfullscreen', 'true');
    viewEl.setAttribute('allow', 'fullscreen; autoplay; picture-in-picture; clipboard-write');
    viewEl.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-modals allow-popups');
    viewEl.addEventListener('load', () => finishTabLoading(tab));
    viewEl.src = buildProxyFrameSrc(tab);
  }

  viewport.appendChild(viewEl);
  startTabLoading(tab);

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

function syncAddressBar(url) {
  const urlInput = document.getElementById('urlInput');
  if (!urlInput) return;
  urlInput.value = url === 'browz://home' ? '' : url;
  updateSslBadge(url);
  syncBookmarkStar(url);
}

function syncBookmarkStar(url) {
  const starBtn = document.getElementById('btnBookmarkPage');
  if (!starBtn) return;
  const list = store.state?.bookmarks || [];
  const isBookmarked = list.some((b) => b.url === url);
  starBtn.textContent = isBookmarked ? '★' : '☆';
  starBtn.style.color = isBookmarked ? '#eab308' : '';
}

function activateTab(tabId) {
  store.activeTabId = tabId;
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  document.querySelectorAll('.tab-frame').forEach((el) => {
    el.classList.toggle('active', el.id === `frame-${tabId}`);
  });

  syncAddressBar(tab.url);
  syncNavButtonsState();
  applyZoomToActiveFrame();

  const activeContainerSelect = document.getElementById('activeTabContainerSelect');
  if (activeContainerSelect) {
    activeContainerSelect.value = tab.containerId;
  }

  renderTabs();
  if (store.filters.scope === 'active') {
    scheduleRequestsRender();
  }
}

function navigateTab(tabId, rawUrl, pushHistory = true) {
  const tab = store.tabs.find((t) => t.id === tabId);
  if (!tab) return;

  const url = resolveInputToUrl(rawUrl);
  tab.url = url;
  tab.title = getFriendlyTabTitle(url);

  if (pushHistory) {
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(url);
    tab.historyIndex = tab.history.length - 1;
  }

  // Record in-memory autocomplete history (skip Ghost/Burner tabs for untraceability)
  if (tab.containerId !== 'burner' && url && !url.startsWith('javascript:')) {
    store.browsingHistory = [
      { title: tab.title || getFriendlyTabTitle(url), url },
      ...store.browsingHistory.filter((h) => h.url !== url)
    ].slice(0, 30);
  }

  hideOmniboxSuggestions();
  startTabLoading(tab);

  const frame = document.getElementById(`frame-${tab.id}`);
  if (frame) {
    if (isStandaloneElectron()) {
      frame.setAttribute('partition', getChromiumPartitionForContainer(tab.containerId));
      frame.src = resolveElectronWebviewSrc(url);
    } else {
      frame.src = buildProxyFrameSrc(tab);
    }
  }

  if (store.activeTabId === tab.id) {
    syncAddressBar(tab.url);
  }
  renderTabs();
}

function closeTab(tabId, event) {
  if (event) event.stopPropagation();
  if (store.tabs.length <= 1) {
    navigateTab(tabId, 'browz://home');
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
  if (!url || url.startsWith('browz://')) {
    badge.textContent = 'Stealth';
  } else if (url.startsWith('https://')) {
    badge.textContent = 'Secure';
  } else {
    badge.textContent = 'HTTP';
  }
}

function renderTabs() {
  const container = document.getElementById('tabsContainer');
  if (!container) return;

  container.innerHTML = store.tabs
    .map((tab, idx) => {
      const c = getContainerById(tab.containerId);
      const isActive = tab.id === store.activeTabId;
      const prefix = c.id !== 'default' ? `${c.name.split(' ')[0]} · ` : '';
      const indicator = tab.loading
        ? `<span class="tab-spinner" title="Loading..."></span>`
        : `<span class="container-dot" style="background:${c.color}" title="Session: ${escapeHtml(c.name)}"></span>`;
      return `
        <div class="tab-item ${isActive ? 'active' : ''}" onclick="activateTab('${tab.id}')" onauxclick="if(event.button===1)closeTab('${tab.id}',event)" title="${escapeHtml(tab.url)} (Ctrl+${idx + 1})">
          ${indicator}
          <span class="tab-title" title="${escapeHtml(tab.url)}">${escapeHtml(prefix + tab.title)}</span>
          <button class="tab-close" onclick="closeTab('${tab.id}', event)" title="Close Tab (Ctrl+W / Middle-Click)">×</button>
        </div>
      `;
    })
    .join('');
}

// --- OMNIBOX LIVE AUTOCOMPLETE & FIND-IN-PAGE ---
function hideOmniboxSuggestions() {
  const box = document.getElementById('omniboxSuggestions');
  if (!box) return;
  box.classList.remove('open');
  store.omniboxSelectedIdx = -1;
}

function selectOmniboxSuggestion(url) {
  hideOmniboxSuggestions();
  if (store.activeTabId) {
    navigateTab(store.activeTabId, url, true);
  } else {
    createTab({ url, containerId: 'default', switchTo: true });
  }
}

function renderOmniboxSuggestions(rawQuery) {
  const box = document.getElementById('omniboxSuggestions');
  if (!box) return;
  const q = String(rawQuery || '').trim().toLowerCase();

  const items = [];
  const seenUrls = new Set();

  const addCandidate = (badge, title, url) => {
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);
    items.push({ badge, title, url });
  };

  // 1. Direct navigation or search suggestion if typing
  if (q) {
    const resolved = resolveInputToUrl(rawQuery);
    const isSearch = resolved.includes('duckduckgo.com') || resolved.includes('search');
    addCandidate(
      isSearch ? 'Search' : 'Go To',
      isSearch ? `Search privately for "${rawQuery.trim()}"` : `Open ${resolved}`,
      resolved
    );
  }

  // 2. Bookmarks matching query
  for (const bm of store.state?.bookmarks || []) {
    if (!q || bm.title.toLowerCase().includes(q) || bm.url.toLowerCase().includes(q)) {
      addCandidate('Bookmark', bm.title, bm.url);
    }
  }

  // 3. Built-in pages & recent in-memory history matching query
  for (const h of store.browsingHistory || []) {
    if (!q || (h.title || '').toLowerCase().includes(q) || h.url.toLowerCase().includes(q)) {
      addCandidate(h.url.startsWith('browz://') ? 'Built-in' : 'History', h.title, h.url);
    }
  }

  store.omniboxCurrentItems = items.slice(0, 7);
  if (store.omniboxCurrentItems.length === 0) {
    hideOmniboxSuggestions();
    return;
  }

  if (store.omniboxSelectedIdx >= store.omniboxCurrentItems.length) {
    store.omniboxSelectedIdx = 0;
  }

  box.innerHTML = store.omniboxCurrentItems
    .map(
      (item, idx) => `
      <div class="omnibox-item ${idx === store.omniboxSelectedIdx ? 'selected' : ''}" onmousedown="selectOmniboxSuggestion('${escapeHtml(item.url)}')">
        <div class="omnibox-item-left">
          <span class="omnibox-badge">${escapeHtml(item.badge)}</span>
          <span class="omnibox-title">${escapeHtml(item.title)}</span>
        </div>
        <span class="omnibox-url">${escapeHtml(item.url)}</span>
      </div>
    `
    )
    .join('');
  box.classList.add('open');
}

function toggleFindBar(forceState) {
  const bar = document.getElementById('findBar');
  const input = document.getElementById('findInput');
  if (!bar || !input) return;
  const shouldOpen = forceState !== undefined ? forceState : !bar.classList.contains('open');
  bar.classList.toggle('open', shouldOpen);
  if (shouldOpen) {
    input.focus();
    input.select();
  } else {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    const frame = tab && document.getElementById(`frame-${tab.id}`);
    if (isStandaloneElectron() && frame && typeof frame.stopFindInPage === 'function') {
      try {
        frame.stopFindInPage('clearSelection');
      } catch {}
    }
  }
}

function findInActiveTab(backwards = false) {
  const input = document.getElementById('findInput');
  if (!input || !input.value.trim()) return;
  const query = input.value.trim();
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (!tab) return;
  const frame = document.getElementById(`frame-${tab.id}`);
  if (!frame) return;

  if (isStandaloneElectron() && typeof frame.findInPage === 'function') {
    try {
      frame.findInPage(query, { forward: !backwards, findNext: true });
      return;
    } catch {}
  }

  try {
    if (frame.contentWindow && typeof frame.contentWindow.find === 'function') {
      frame.contentWindow.find(query, false, backwards, true, false, true, false);
    }
  } catch {}
}

// --- BOOKMARKS BAR & PAGE ZOOM ---
function renderBookmarksBar() {
  const bar = document.getElementById('bookmarksBar');
  if (!bar) return;
  const list = store.state?.bookmarks || [];
  bar.innerHTML = list
    .map(
      (bm) => `
      <div class="bookmark-chip" onclick="openBookmark('${escapeHtml(bm.url)}')" title="${escapeHtml(bm.url)}">
        <span>${escapeHtml(bm.title)}</span>
        <span class="bookmark-del" onclick="removeBookmark('${escapeHtml(bm.id)}', event)" title="Remove Bookmark">×</span>
      </div>
    `
    )
    .join('');
}

function openBookmark(url) {
  if (store.activeTabId) {
    navigateTab(store.activeTabId, url, true);
  } else {
    createTab({ url, containerId: 'default', switchTo: true });
  }
}

async function toggleBookmarkCurrentPage() {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (!tab) return;
  const list = store.state?.bookmarks || [];
  const existing = list.find((b) => b.url === tab.url);
  if (existing) {
    const res = await apiPost('/api/bookmarks', { action: 'delete', id: existing.id });
    if (res.state) store.state = res.state;
    showToast('Removed from Bookmarks');
  } else {
    const res = await apiPost('/api/bookmarks', {
      action: 'add',
      title: tab.title || getFriendlyTabTitle(tab.url),
      url: tab.url
    });
    if (res.state) store.state = res.state;
    showToast(`Bookmarked "${tab.title}"`);
  }
  renderBookmarksBar();
  syncBookmarkStar(tab.url);
}

async function removeBookmark(id, event) {
  if (event) event.stopPropagation();
  const res = await apiPost('/api/bookmarks', { action: 'delete', id });
  if (res.state) store.state = res.state;
  renderBookmarksBar();
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (tab) syncBookmarkStar(tab.url);
}

function setPageZoom(delta, reset = false) {
  if (reset) {
    store.zoomLevel = 100;
  } else {
    store.zoomLevel = Math.min(200, Math.max(50, store.zoomLevel + delta));
  }
  const lbl = document.getElementById('zoomLabel');
  if (lbl) lbl.textContent = `${store.zoomLevel}%`;
  applyZoomToActiveFrame();
}

function applyZoomToActiveFrame() {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (!tab) return;
  const frame = document.getElementById(`frame-${tab.id}`);
  if (!frame) return;
  const factor = store.zoomLevel / 100;
  if (isStandaloneElectron() && typeof frame.setZoomFactor === 'function') {
    try {
      frame.setZoomFactor(factor);
    } catch {}
  } else {
    frame.style.zoom = String(factor);
  }
}

function renderContainerSelects() {
  if (!store.state) return;
  const optionsHtml = store.state.containers
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`)
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

// --- METRICS & REQUEST CAPTURE TABLE (BATCHED ZERO-LAG RENDERING) ---
function scheduleRequestsRender() {
  if (renderTableScheduled) return;
  renderTableScheduled = true;
  setTimeout(() => {
    renderTableScheduled = false;
    renderMetricsStrip();
    renderRequestsTable();
  }, 80);
}

function renderMetricsStrip() {
  const m = store.metrics || {};
  const total = m.total || 0;
  document.getElementById('mTotal').textContent = total;
  const navCount = document.getElementById('navCaptureCount');
  if (navCount) navCount.textContent = total;

  document.getElementById('m2xx').textContent = m.status2xx || 0;
  const errCount = (m.status4xx || 0) + (m.status5xx || 0);
  document.getElementById('mErr').textContent = `${errCount} (${m.errorRate || 0}%)`;
  document.getElementById('mBlocked').textContent = m.blocked || 0;
  document.getElementById('mAvg').textContent = `${m.avgDurationMs || 0} ms`;
  document.getElementById('mP50').textContent = `${m.p50Ms || 0} ms`;
  document.getElementById('mP95').textContent = `${m.p95Ms || 0} ms`;
  document.getElementById('mP99').textContent = `${m.p99Ms || 0} ms`;
  document.getElementById('mRps').textContent = `${m.rps || 0}/s`;
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
          No captured requests matching current filters.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = list
    .slice(-250)
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
          <td>${escapeHtml(c.name.split(' ')[0])}</td>
          <td><span class="method-pill">${escapeHtml(e.method)}</span></td>
          <td><span class="status-pill ${statusClass(e)}">${e.blocked ? 'BLOCKED' : e.status}</span></td>
          <td class="col-url" title="${escapeHtml(e.url)}">${escapeHtml(e.url)}</td>
          <td>${escapeHtml(e.resourceType || 'XHR')}</td>
          <td>${formatBytes(e.transferSize || e.responseBodySize || 0)}</td>
          <td>${e.timings?.total ?? 0} ms</td>
          <td>${renderWaterfallMini(e.timings)}</td>
          <td onclick="event.stopPropagation()">
            <button class="btn btn-sm" onclick="quickReplay('${e.id}')" title="Replay">Replay</button>
            <button class="btn btn-sm btn-danger" onclick="quickBlockDomain('${e.id}')" title="Block Domain">Block</button>
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
        <button class="btn btn-sm btn-primary" onclick="quickReplay('${entry.id}')">Replay Request</button>
        <button class="btn btn-sm" onclick="copyCurl('${entry.id}')">Copy cURL</button>
        <button class="btn btn-sm" onclick="switchInspectorTab('replay')">Edit / Load Burst</button>
        <button class="btn btn-sm btn-danger" onclick="quickBlockDomain('${entry.id}')">Block ${escapeHtml(entry.domain)}</button>
      </div>

      <div class="kv-section">
        <h4>General</h4>
        <div class="kv-row"><div class="kv-key">Request URL</div><div class="kv-val">${escapeHtml(entry.url)}</div></div>
        <div class="kv-row"><div class="kv-key">Method</div><div class="kv-val">${escapeHtml(entry.method)}</div></div>
        <div class="kv-row"><div class="kv-key">Status</div><div class="kv-val">${entry.blocked ? 'BLOCKED (' + escapeHtml(entry.blockReason) + ')' : entry.status + ' ' + escapeHtml(entry.statusText)}</div></div>
        <div class="kv-row"><div class="kv-key">Remote Address</div><div class="kv-val">${escapeHtml(entry.remoteAddress || '-')}</div></div>
        <div class="kv-row"><div class="kv-key">Session</div><div class="kv-val">${escapeHtml(c.name)}</div></div>
        <div class="kv-row"><div class="kv-key">Duration</div><div class="kv-val">${entry.timings?.total || 0} ms</div></div>
      </div>

      ${queryRows ? `<div class="kv-section"><h4>Query Parameters</h4>${queryRows}</div>` : ''}
      <div class="kv-section"><h4>Response Headers</h4>${resHdrRows || '<div style="color:var(--text-muted)">None</div>'}</div>
      <div class="kv-section"><h4>Request Headers</h4>${reqHdrRows || '<div style="color:var(--text-muted)">None</div>'}</div>
    `;
  } else if (tab === 'payload') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Request Payload (${formatBytes(entry.requestBodySize || 0)})</h4>
        <pre class="code-block">${escapeHtml(formatPrettyBody(entry.requestBody))}</pre>
      </div>
      <div class="kv-section">
        <h4>cURL Command</h4>
        <pre class="code-block">${escapeHtml(buildCurlForEntry(entry))}</pre>
      </div>
    `;
  } else if (tab === 'response') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Response Body (${escapeHtml(entry.mimeType || 'text/plain')} — ${formatBytes(entry.responseBodySize || 0)})</h4>
        <pre class="code-block">${escapeHtml(formatPrettyBody(entry.responseBody))}</pre>
      </div>
    `;
  } else if (tab === 'timings') {
    const t = entry.timings || {};
    const total = Math.max(1, t.total || 1);
    const stages = [
      { label: 'Queueing', val: t.blocked || 0, color: '#64748b' },
      { label: 'DNS Lookup', val: t.dns || 0, color: '#94a3b8' },
      { label: 'TCP Connect', val: t.connect || 0, color: '#60a5fa' },
      { label: 'TLS Handshake', val: t.ssl || 0, color: '#818cf8' },
      { label: 'Request Sent', val: t.send || 0, color: '#38bdf8' },
      { label: 'Waiting (TTFB)', val: t.wait || 0, color: '#22c55e' },
      { label: 'Content Download', val: t.receive || 0, color: '#3b82f6' }
    ];

    content.innerHTML = `
      <div class="kv-section">
        <h4>Timing Breakdown (Total: ${t.total || 0} ms)</h4>
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
        <h4>Request Cookies (${escapeHtml(c.name)})</h4>
        ${reqC || '<div style="color:var(--text-muted)">None</div>'}
      </div>
      <div class="kv-section">
        <h4>Response Set-Cookie</h4>
        ${resC || '<div style="color:var(--text-muted)">None</div>'}
      </div>
    `;
  } else if (tab === 'replay') {
    content.innerHTML = `
      <div class="kv-section">
        <h4>Request Composer &amp; Load Burst</h4>
        <div class="form-row">
          <select id="compMethod" class="select-input">
            ${['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => `<option value="${m}" ${entry.method === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <input type="text" id="compUrl" class="text-input" style="flex:1;" value="${escapeHtml(entry.url)}" />
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:11px;color:var(--text-muted);">Headers (JSON):</label>
          <textarea id="compHeaders" class="text-input" style="width:100%;height:70px;margin-top:4px;font-family:var(--font-mono);">${escapeHtml(JSON.stringify(entry.requestHeaders || {}, null, 2))}</textarea>
        </div>
        <div style="margin-top:8px;">
          <label style="font-size:11px;color:var(--text-muted);">Body:</label>
          <textarea id="compBody" class="text-input" style="width:100%;height:70px;margin-top:4px;font-family:var(--font-mono);">${escapeHtml(entry.requestBody || '')}</textarea>
        </div>
        <div class="form-row" style="margin-top:10px;align-items:center;">
          <button class="btn btn-primary" onclick="executeComposerReplay()">Send Request</button>
          <span style="color:var(--text-muted);font-size:11px;margin-left:6px;">Requests:</span>
          <input type="number" id="compBurstCount" class="text-input" value="10" min="1" max="50" style="width:55px;" />
          <span style="color:var(--text-muted);font-size:11px;">Concurrency:</span>
          <input type="number" id="compBurstConc" class="text-input" value="5" min="1" max="25" style="width:50px;" />
          <button class="btn" onclick="executeComposerBurst()">Run Burst</button>
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
  showToast(`Replaying ${entry.method} ${entry.domain}...`);
  await apiPost('/api/replay', {
    tabId: entry.tabId,
    containerId: entry.containerId,
    method: entry.method,
    url: entry.url,
    headers: entry.requestHeaders,
    body: entry.requestBody,
    resourceType: 'Replay'
  });
  showToast(`Replay completed (${entry.method} ${entry.domain})`);
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
  showToast(`Blocked domain: ${entry.domain}`);
}

async function copyCurl(entryId) {
  const entry = store.entries.find((e) => e.id === entryId);
  if (!entry) return;
  const cmd = buildCurlForEntry(entry);
  try {
    await navigator.clipboard.writeText(cmd);
  } catch {}
  showToast('Copied cURL command to clipboard');
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

  showToast(`Sending ${method} request...`);
  await apiPost('/api/replay', {
    tabId: store.activeTabId || 'tab-1',
    containerId: activeTab ? activeTab.containerId : 'default',
    method,
    url,
    headers,
    body,
    resourceType: 'Replay'
  });
  showToast('Request completed');
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

  showToast(`Running ${count}-request load burst...`);
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
  showToast(`Completed ${count}-request load burst!`);
}

function exportCapture(format) {
  const tabQuery =
    store.filters.scope === 'active' && store.activeTabId
      ? `?tabId=${encodeURIComponent(store.activeTabId)}`
      : '';
  showToast(`Exporting ${format.toUpperCase()} capture file...`);
  window.open(`/api/export/${format}${tabQuery}`, '_blank');
}

// --- SHIELDS & SETTINGS DRAWER (FOCUS-SAFE) ---
function renderControlDrawer(forceRender = true) {
  if (!store.state) return;
  const body = document.getElementById('drawerBody');
  if (!body) return;

  // Do not overwrite DOM if user is actively typing into an input inside the drawer
  if (
    !forceRender &&
    document.activeElement &&
    body.contains(document.activeElement) &&
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)
  ) {
    return;
  }

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dtab === store.activeDrawerTab);
  });

  const st = store.state.stealth || {};
  const persona = st.persona || {};
  const personasMap = store.state.osControl?.stealthPersonas || {};
  const dohMap = store.state.osControl?.dohProviders || {};
  const nc = store.state.networkControl;
  const cap = store.state.capture;

  if (store.activeDrawerTab === 'stealth') {
    body.innerHTML = `
      <div class="ctrl-card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h3 style="margin:0;">Identity Profile (What Websites See)</h3>
          <button class="btn btn-sm btn-primary" onclick="rotateIdentityAndReload()">Rotate Now</button>
        </div>
        <select class="select-input" style="width:100%;margin-bottom:8px;" onchange="updateStealthSetting({ activePersonaId: this.value })">
          ${Object.values(personasMap)
            .map(
              (p) =>
                `<option value="${escapeHtml(p.id)}" ${st.activePersonaId === p.id ? 'selected' : ''}>${escapeHtml(p.label)}</option>`
            )
            .join('')}
        </select>
        <div class="code-block" style="font-size:11px;line-height:1.5;">
          <div>Platform: ${escapeHtml(persona.platform || 'Win32')}</div>
          <div>GPU: ${escapeHtml(persona.webglVendor)} (${escapeHtml(persona.webglRenderer)})</div>
          <div>Timezone: ${escapeHtml(persona.timezone)} (${escapeHtml(persona.language)})</div>
          <div>Screen: ${persona.screenWidth}×${persona.screenHeight} · ${persona.hardwareConcurrency} Cores · ${persona.deviceMemory}GB</div>
          <div>Session Seed: #${st.noiseSeed}</div>
        </div>
      </div>

      <div class="ctrl-card">
        <h3>Triple-Layer Anti-Fingerprinting</h3>
        <label class="toggle-line">
          <span>Canvas 2D Pixel Noise (toDataURL &amp; getImageData)</span>
          <input type="checkbox" ${st.canvasNoise ? 'checked' : ''} onchange="updateStealthSetting({ canvasNoise: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>WebGL GPU Vendor &amp; Model Spoofing</span>
          <input type="checkbox" ${st.webglSpoof ? 'checked' : ''} onchange="updateStealthSetting({ webglSpoof: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>AudioContext &amp; AnalyserNode Noise</span>
          <input type="checkbox" ${st.audioNoise ? 'checked' : ''} onchange="updateStealthSetting({ audioNoise: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block WebRTC IP Leak (STUN/ICE Kill-Switch)</span>
          <input type="checkbox" ${st.blockWebRTCLeak ? 'checked' : ''} onchange="updateStealthSetting({ blockWebRTCLeak: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Spoof High-Entropy Client Hints (userAgentData)</span>
          <input type="checkbox" ${st.spoofClientHints !== false ? 'checked' : ''} onchange="updateStealthSetting({ spoofClientHints: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Spoof Timezone (UTC) &amp; Locale</span>
          <input type="checkbox" ${st.spoofTimezone ? 'checked' : ''} onchange="updateStealthSetting({ spoofTimezone: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Mask Screen Resolution &amp; Taskbar</span>
          <input type="checkbox" ${st.maskScreenResolution ? 'checked' : ''} onchange="updateStealthSetting({ maskScreenResolution: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Mask CPU Cores, RAM &amp; Disk Quota (10GB)</span>
          <input type="checkbox" ${st.maskHardware ? 'checked' : ''} onchange="updateStealthSetting({ maskHardware: this.checked, spoofStorageQuota: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block Battery, Motion, Bluetooth, USB &amp; Voices</span>
          <input type="checkbox" ${st.blockBatteryAndSensors ? 'checked' : ''} onchange="updateStealthSetting({ blockBatteryAndSensors: this.checked, blockMediaEnumeration: this.checked, blockSpeechVoices: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block SendBeacon Background Telemetry</span>
          <input type="checkbox" ${st.blockSendBeacon ? 'checked' : ''} onchange="updateStealthSetting({ blockSendBeacon: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Strip URL Tracking Params (utm_*, fbclid, gclid)</span>
          <input type="checkbox" ${st.stripTrackingParams ? 'checked' : ''} onchange="updateStealthSetting({ stripTrackingParams: this.checked })" />
        </label>
      </div>

      <div class="ctrl-card">
        <h3>Network Operator Privacy (Encrypted DNS &amp; Proxy)</h3>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:5px;">DNS-over-HTTPS Provider:</div>
        <select class="select-input" style="width:100%;margin-bottom:10px;" onchange="updateDohProvider(this.value)">
          ${Object.entries(dohMap)
            .map(
              ([key, item]) =>
                `<option value="${escapeHtml(key)}" ${nc.proxy.dohProvider === key ? 'selected' : ''}>${escapeHtml(item.label)}</option>`
            )
            .join('')}
        </select>

        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Proxy / Tor Routing:</div>
        <div class="form-row">
          <select id="stealthProxyMode" class="select-input" onchange="saveStealthProxy()">
            <option value="direct" ${nc.proxy.mode === 'direct' ? 'selected' : ''}>Direct</option>
            <option value="socks5" ${nc.proxy.mode === 'socks5' ? 'selected' : ''}>SOCKS5 / Tor</option>
            <option value="http" ${nc.proxy.mode === 'http' ? 'selected' : ''}>HTTP Proxy</option>
          </select>
          <input type="text" id="stealthProxyRules" class="text-input" style="flex:1;" placeholder="socks5://127.0.0.1:9050" value="${escapeHtml(nc.proxy.rules || '')}" onchange="saveStealthProxy()" />
        </div>
      </div>

      <div class="ctrl-card">
        <h3>Default Search Engine</h3>
        <select class="select-input" style="width:100%;" onchange="updateStealthSetting({ searchEngine: this.value })">
          <option value="duckduckgo" ${st.searchEngine === 'duckduckgo' ? 'selected' : ''}>DuckDuckGo (Private)</option>
          <option value="brave" ${st.searchEngine === 'brave' ? 'selected' : ''}>Brave Search</option>
          <option value="startpage" ${st.searchEngine === 'startpage' ? 'selected' : ''}>Startpage</option>
          <option value="google" ${st.searchEngine === 'google' ? 'selected' : ''}>Google</option>
        </select>
      </div>
    `;
  } else if (store.activeDrawerTab === 'io') {
    const radioMap = store.state.osControl?.radioProfiles || {};
    const curRadioKey = st.radioProfile || 'stealth_hidden';
    const curRadio = radioMap[curRadioKey] || { label: 'Stealth Mask', type: 'hidden', effectiveType: '4g', downlink: 10, rtt: 0, online: true, saveData: false };
    body.innerHTML = `
      <div class="ctrl-card">
        <h3>Wi-Fi, Cellular &amp; Radio Adapter Control</h3>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">
          Control how websites &amp; network APIs see your Wi-Fi/Cellular radio, bandwidth, RTT latency, or engage the Air-Gap Kill-Switch:
        </div>
        <select class="select-input" style="width:100%;margin-bottom:8px;" onchange="updateStealthSetting({ radioProfile: this.value })">
          ${Object.values(radioMap)
            .map(
              (rp) =>
                `<option value="${escapeHtml(rp.id)}" ${curRadioKey === rp.id ? 'selected' : ''}>${escapeHtml(rp.label)}</option>`
            )
            .join('')}
        </select>
        <div class="code-block" style="font-size:11px;line-height:1.5;">
          <div>Radio State: <strong>${curRadio.online === false ? '🔴 AIR-GAPPED (OFFLINE)' : '🟢 ONLINE'}</strong></div>
          <div>navigator.connection: <strong>${curRadio.hideConnectionApi ? 'undefined (Stealth Masked)' : `${curRadio.type} (${curRadio.effectiveType}, ${curRadio.downlink} Mbps)`}</strong></div>
          <div>Added RTT Latency: <strong>+${curRadio.latencyMs || 0} ms</strong> · Save-Data Header: <strong>${curRadio.saveData ? 'ON' : 'OFF'}</strong></div>
        </div>
      </div>

      <div class="ctrl-card">
        <h3>Disk, Storage &amp; File System I/O Firewall</h3>
        <label class="toggle-line">
          <span>Block ServiceWorker Disk Persistence</span>
          <input type="checkbox" ${st.blockServiceWorkers !== false ? 'checked' : ''} onchange="updateStealthSetting({ blockServiceWorkers: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block CacheStorage Supercookie I/O</span>
          <input type="checkbox" ${st.blockCacheStorage !== false ? 'checked' : ''} onchange="updateStealthSetting({ blockCacheStorage: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block Local File Picker &amp; OPFS Disk I/O</span>
          <input type="checkbox" ${st.blockFileSystemAccess !== false ? 'checked' : ''} onchange="updateStealthSetting({ blockFileSystemAccess: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Block Persistent Storage Quota Lock</span>
          <input type="checkbox" ${st.blockPersistentStorage !== false ? 'checked' : ''} onchange="updateStealthSetting({ blockPersistentStorage: this.checked })" />
        </label>
      </div>

      <div class="ctrl-card">
        <h3>Stream, Clipboard &amp; Side-Channel I/O</h3>
        <label class="toggle-line">
          <span>Block Silent Clipboard Read Snooping</span>
          <input type="checkbox" ${st.blockClipboardRead !== false ? 'checked' : ''} onchange="updateStealthSetting({ blockClipboardRead: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Kill-Switch: Block Live WebSockets &amp; SSE</span>
          <input type="checkbox" ${st.blockWebSockets === true ? 'checked' : ''} onchange="updateStealthSetting({ blockWebSockets: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>High-Resolution Timer Jitter (Anti-Spectre)</span>
          <input type="checkbox" ${st.timerJitter !== false ? 'checked' : ''} onchange="updateStealthSetting({ timerJitter: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>OS Font Enumeration Fingerprint Guard</span>
          <input type="checkbox" ${st.fontFingerprintProtection !== false ? 'checked' : ''} onchange="updateStealthSetting({ fontFingerprintProtection: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Auto Video Fit-to-Screen Engine</span>
          <input type="checkbox" ${st.fitVideosToScreen !== false ? 'checked' : ''} onchange="updateStealthSetting({ fitVideosToScreen: this.checked })" />
        </label>
      </div>
    `;
  } else if (store.activeDrawerTab === 'network') {
    body.innerHTML = `
      <div class="ctrl-card">
        <h3>Network, Retry &amp; Header Controls</h3>
        <label class="toggle-line">
          <span>Auto-Retry Failed Network Requests (2x Backoff)</span>
          <input type="checkbox" ${nc.autoRetryFailedRequests !== false ? 'checked' : ''} onchange="updateNetworkSetting({ autoRetryFailedRequests: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Disable Browser Cache</span>
          <input type="checkbox" ${cap.disableCache ? 'checked' : ''} onchange="updateCaptureSetting({ disableCache: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Capture Request/Response Bodies</span>
          <input type="checkbox" ${cap.captureBodies ? 'checked' : ''} onchange="updateCaptureSetting({ captureBodies: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Force HTTPS Upgrade</span>
          <input type="checkbox" ${nc.forceHttps ? 'checked' : ''} onchange="updateNetworkSetting({ forceHttps: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Strip Referer &amp; Origin Header</span>
          <input type="checkbox" ${nc.stripReferer ? 'checked' : ''} onchange="updateNetworkSetting({ stripReferer: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Strip Client-Hints &amp; ETag Cache Trackers</span>
          <input type="checkbox" ${nc.stripTrackingHeaders ? 'checked' : ''} onchange="updateNetworkSetting({ stripTrackingHeaders: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Bypass CORS (Access-Control-Allow-Origin: *)</span>
          <input type="checkbox" ${nc.bypassCors ? 'checked' : ''} onchange="updateNetworkSetting({ bypassCors: this.checked })" />
        </label>
        <label class="toggle-line">
          <span>Allow Self-Signed SSL Certs (Local Dev)</span>
          <input type="checkbox" ${nc.allowSelfSignedCerts ? 'checked' : ''} onchange="updateNetworkSetting({ allowSelfSignedCerts: this.checked })" />
        </label>
      </div>

      <div class="ctrl-card">
        <h3>Custom Request Headers</h3>
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
          <input type="text" id="newHdrName" class="text-input" placeholder="Header" style="width:110px;" />
          <input type="text" id="newHdrVal" class="text-input" placeholder="Value" style="flex:1;" />
          <button class="btn btn-sm btn-primary" onclick="addHeaderRule('request')">Add</button>
        </div>
      </div>

      <div class="ctrl-card">
        <h3>Domain &amp; Tracker Block Rules</h3>
        ${(nc.blockRules || [])
          .map(
            (r) => `
            <div class="rule-item">
              <input type="checkbox" ${r.enabled ? 'checked' : ''} onchange="toggleBlockRule('${r.id}')" />
              <span style="flex:1;">[${escapeHtml(r.resourceType)}] ${escapeHtml(r.pattern)}</span>
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
          <button class="btn btn-sm btn-primary" onclick="addBlockRule()">Block</button>
        </div>
      </div>
    `;
  } else if (store.activeDrawerTab === 'containers') {
    body.innerHTML = `
      <div class="ctrl-card">
        <h3>Create Isolated Session Container</h3>
        <div class="form-row">
          <input type="text" id="newCntName" class="text-input" placeholder="Container Name" style="flex:1;" />
          <input type="color" id="newCntColor" value="#3b82f6" style="width:32px;height:30px;border:none;background:transparent;" />
        </div>
        <div class="form-row" style="align-items:center;justify-content:space-between;">
          <label style="font-size:11.5px;color:var(--text-secondary);">
            <input type="checkbox" id="newCntEphemeral" checked /> Ghost (RAM-only, zero disk trace)
          </label>
          <button class="btn btn-sm btn-primary" onclick="createNewContainer()">Create</button>
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
                <span style="font-weight:600;display:flex;align-items:center;gap:6px;">
                  <span class="container-dot" style="background:${c.color}"></span>
                  ${escapeHtml(c.name)}
                </span>
                <span style="font-size:10.5px;color:var(--text-muted);font-family:var(--font-mono);">${escapeHtml(c.partition)}</span>
              </div>
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">
                Cookies: ${cookieEntries.length}
                ${c.storageStats?.lastCleared ? ` · Cleared ${new Date(c.storageStats.lastCleared).toLocaleTimeString()}` : ''}
              </div>
              <div class="form-row">
                <button class="btn btn-sm" onclick="createTab({ url: 'browz://home', containerId: '${c.id}', switchTo: true }); showToast('Opened tab in ${escapeHtml(c.name)}')">New Tab</button>
                <button class="btn btn-sm btn-danger" onclick="clearContainerStorage('${c.id}')">Clear Data</button>
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
        <h3>Site Permissions Firewall</h3>
        ${Object.entries(perms.globalDefaults)
          .map(
            ([perm, dec]) => `
            <div class="toggle-line">
              <span style="text-transform:capitalize;">${escapeHtml(perm)}</span>
              <select class="select-input" onchange="updateGlobalPermission('${perm}', this.value)">
                <option value="allow" ${dec === 'allow' ? 'selected' : ''}>Allow</option>
                <option value="deny" ${dec === 'deny' ? 'selected' : ''}>Block</option>
              </select>
            </div>
          `
          )
          .join('')}
      </div>

      <div class="ctrl-card">
        <h3>Download Protection</h3>
        <label class="toggle-line">
          <span>Block Executable Downloads (.exe, .bat, .msi)</span>
          <input type="checkbox" ${dls.autoBlockDangerous ? 'checked' : ''} onchange="updateDownloadConfig(this.checked)" />
        </label>
        ${(dls.items || [])
          .slice(0, 6)
          .map(
            (item) => `
            <div class="rule-item">
              <span style="flex:1;">${escapeHtml(item.filename)} (${formatBytes(item.totalBytes)})</span>
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
function refreshActiveTabForLiveImpact() {
  const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
  if (activeTab && !activeTab.loading) {
    navigateTab(activeTab.id, activeTab.url, false);
  }
}

async function triggerVideoFitOnActiveTab() {
  const tab = store.tabs.find((t) => t.id === store.activeTabId);
  if (!tab) return;
  const frame = document.getElementById(`frame-${tab.id}`);
  if (!frame) return;

  if (isStandaloneElectron() && typeof frame.executeJavaScript === 'function') {
    try {
      const res = await frame.executeJavaScript(
        `window.__browzToggleVideoFit ? window.__browzToggleVideoFit() : { fitted: false }`
      );
      if (res && res.fitted) {
        showToast('Fitted video to full screen — press Esc to exit');
        return;
      }
    } catch {}
  } else {
    try {
      if (frame.contentWindow && typeof frame.contentWindow.__browzToggleVideoFit === 'function') {
        const res = frame.contentWindow.__browzToggleVideoFit();
        if (res && res.fitted) {
          showToast('Fitted video to full screen — press Esc to exit');
          return;
        }
      }
      if (frame.contentWindow) {
        frame.contentWindow.postMessage({ type: 'browz:toggle-video-fit' }, '*');
      }
    } catch {}
  }

  // If current page has no <video>, open the Testbench Video Player and fit it automatically
  if (tab.url === 'browz://home' || tab.url === 'browz://security') {
    navigateTab(tab.id, 'browz://testbench', true);
    showToast('Opening Video Fit & API Testbench...');
    setTimeout(() => {
      try {
        const f = document.getElementById(`frame-${tab.id}`);
        if (f && f.contentWindow && typeof f.contentWindow.__browzToggleVideoFit === 'function') {
          f.contentWindow.__browzToggleVideoFit(true);
        }
      } catch {}
    }, 450);
  } else {
    showToast('Toggled Video Fit-to-Screen on active tab');
  }
}

async function updateStealthSetting(patch) {
  const res = await apiPost('/api/control/stealth', patch);
  if (res.state) {
    store.state = res.state;
    syncTopBarControls();
    renderControlDrawer(true);
    refreshActiveTabForLiveImpact();
    showToast('Applied Stealth / Radio / I/O control to active tab');
  }
}

async function rotateIdentityAndReload() {
  const res = await apiPost('/api/stealth/rotate', {});
  if (res.state) {
    store.state = res.state;
    syncTopBarControls();
    renderControlDrawer(true);
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId);
    if (activeTab) {
      navigateTab(activeTab.id, activeTab.url, false);
    }
    const pLabel = res.state.stealth?.persona?.label || 'New Persona';
    showToast(`Identity Rotated: ${pLabel} (Seed #${res.state.stealth?.noiseSeed})`);
  }
}

async function updateDohProvider(providerKey) {
  const dohMap = store.state.osControl?.dohProviders || {};
  const dohUrl = dohMap[providerKey]?.url || 'https://cloudflare-dns.com/dns-query';
  await updateNetworkSetting({
    proxy: {
      ...store.state.networkControl.proxy,
      dohProvider: providerKey,
      dohUrl
    }
  });
  showToast(`DNS-over-HTTPS switched to ${providerKey.toUpperCase()}`);
}

async function saveStealthProxy() {
  const mode = document.getElementById('stealthProxyMode').value;
  const rules = document.getElementById('stealthProxyRules').value.trim();
  await updateNetworkSetting({
    proxy: {
      ...store.state.networkControl.proxy,
      mode,
      rules
    }
  });
  showToast(`Proxy routing updated (${mode.toUpperCase()})`);
}

async function updateCaptureSetting(patch) {
  const res = await apiPost('/api/control/capture', patch);
  if (res.state) {
    store.state = res.state;
    syncTopBarControls();
    renderControlDrawer(true);
  }
}

async function updateNetworkSetting(patch) {
  const res = await apiPost('/api/control/network', patch);
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
  }
}

async function addHeaderRule(target) {
  const nameEl = document.getElementById('newHdrName');
  const valEl = document.getElementById('newHdrVal');
  const name = nameEl ? nameEl.value.trim() : '';
  const value = valEl ? valEl.value.trim() : '';
  if (!name) return;
  const res = await apiPost('/api/control/header-rule', { action: 'add', target, name, value });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast(`Added custom header: ${name}`);
  }
}

async function toggleHeaderRule(target, id) {
  const res = await apiPost('/api/control/header-rule', { action: 'toggle', target, id });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
  }
}

async function deleteHeaderRule(target, id) {
  const res = await apiPost('/api/control/header-rule', { action: 'delete', target, id });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast('Removed custom header rule');
  }
}

async function addBlockRule() {
  const patEl = document.getElementById('newBlkPattern');
  const typeEl = document.getElementById('newBlkType');
  const pattern = patEl ? patEl.value.trim() : '';
  const resourceType = typeEl ? typeEl.value : 'ALL';
  if (!pattern) return;
  const res = await apiPost('/api/control/block-rule', { action: 'add', pattern, resourceType });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast(`Added block rule: ${pattern}`);
  }
}

async function toggleBlockRule(id) {
  const res = await apiPost('/api/control/block-rule', { action: 'toggle', id });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
  }
}

async function deleteBlockRule(id) {
  const res = await apiPost('/api/control/block-rule', { action: 'delete', id });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast('Removed block rule');
  }
}

async function createNewContainer() {
  const nameEl = document.getElementById('newCntName');
  const colorEl = document.getElementById('newCntColor');
  const ephEl = document.getElementById('newCntEphemeral');
  const name = nameEl ? nameEl.value.trim() : '';
  const color = colorEl ? colorEl.value : '#3b82f6';
  const ephemeral = ephEl ? ephEl.checked : true;
  if (!name) return;
  const res = await apiPost('/api/containers', { action: 'create', name, color, ephemeral });
  if (res.state) {
    store.state = res.state;
    renderContainerSelects();
    renderControlDrawer(true);
    showToast(`Created isolated container: ${name}`);
  }
}

async function clearContainerStorage(containerId) {
  const res = await apiPost('/api/containers', { action: 'clear-storage', containerId });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast('Cleared container cookies & storage');
  }
}

async function updateGlobalPermission(permission, decision) {
  const res = await apiPost('/api/permissions/update', { scope: 'global', permission, decision });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast(`Permission "${permission}" set to ${decision.toUpperCase()}`);
  }
}

async function updateDownloadConfig(autoBlockDangerous) {
  const res = await apiPost('/api/downloads/config', { autoBlockDangerous });
  if (res.state) {
    store.state = res.state;
    renderControlDrawer(true);
    showToast(`Executable download blocker ${autoBlockDangerous ? 'enabled' : 'disabled'}`);
  }
}

function toggleCaptureDock(forceState) {
  store.dockOpen = typeof forceState === 'boolean' ? forceState : !store.dockOpen;
  store.dockMaximized = false;
  const stack = document.getElementById('centerStack');
  const btn = document.getElementById('btnToggleCaptureDock');
  stack.classList.remove('dock-maximized', 'viewport-maximized');
  if (!store.dockOpen) {
    stack.classList.add('viewport-maximized');
  }
  if (btn) btn.classList.toggle('active-toggle', store.dockOpen);
}

function syncTopBarControls() {
  if (!store.state) return;
  const recBtn = document.getElementById('btnRecordToggle');
  const recTxt = document.getElementById('recStatusText');
  const isRec = store.state.capture.recording;
  if (recBtn) recBtn.classList.toggle('paused', !isRec);
  if (recTxt) recTxt.textContent = isRec ? 'REC' : 'PAUSED';

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
  renderBookmarksBar();
  syncTopBarControls();
  renderMetricsStrip();
  renderControlDrawer(true);

  // Start with a single clean New Tab
  createTab({ url: 'browz://home', containerId: 'default', switchTo: true });

  renderRequestsTable();

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'entry:new') {
        store.entries.push(msg.payload.entry);
        store.metrics = msg.payload.metrics;
        scheduleRequestsRender();
      } else if (msg.type === 'entries:cleared') {
        store.entries = msg.payload.entries || [];
        store.metrics = msg.payload.metrics || {};
        store.selectedEntryId = null;
        renderMetricsStrip();
        renderRequestsTable();
        renderInspector();
      } else if (msg.type === 'state:updated') {
        store.state = msg.payload;
        renderContainerSelects();
        renderBookmarksBar();
        syncTopBarControls();
        renderControlDrawer(false);
      } else if (msg.type === 'permission:event') {
        if (store.state && store.state.permissions) {
          store.state.permissions.eventLog.unshift(msg.payload);
          if (store.activeDrawerTab === 'permissions') renderControlDrawer(false);
        }
      }
    } catch {}
  };

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;
    if (data.type === 'browz:page-meta') {
      const tab = store.tabs.find((t) => t.id === data.tabId);
      if (tab && data.title) {
        tab.title = data.title.slice(0, 28);
        renderTabs();
      }
    } else if (data.type === 'browz:navigate-tab') {
      navigateTab(data.tabId, data.url, true);
    } else if (data.type === 'browz:navigate-active') {
      if (store.activeTabId) navigateTab(store.activeTabId, data.url, true);
    } else if (data.type === 'browz:open-tab') {
      createTab({ url: data.url, containerId: data.containerId || 'default', switchTo: true });
    } else if (data.type === 'browz:rotate-identity') {
      rotateIdentityAndReload();
    }
  });

  document.getElementById('btnNewTab').addEventListener('click', () => {
    const containerId = document.getElementById('newTabContainerSelect').value || 'default';
    createTab({ url: 'browz://home', containerId, switchTo: true });
  });

  document.getElementById('btnNewGhostTab').addEventListener('click', () => {
    createTab({ url: 'browz://home', containerId: 'burner', switchTo: true });
    showToast('Opened Ghost Tab (RAM-Only Session)');
  });

  document.getElementById('activeTabContainerSelect').addEventListener('change', (e) => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    tab.containerId = e.target.value;
    navigateTab(tab.id, tab.url, false);
    const c = getContainerById(tab.containerId);
    showToast(`Switched tab session to ${c.name}`);
  });

  document.getElementById('addressForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const urlInput = document.getElementById('urlInput');
    if (
      store.omniboxSelectedIdx >= 0 &&
      store.omniboxCurrentItems[store.omniboxSelectedIdx]
    ) {
      selectOmniboxSuggestion(store.omniboxCurrentItems[store.omniboxSelectedIdx].url);
      urlInput.blur();
      return;
    }
    const val = urlInput.value;
    hideOmniboxSuggestions();
    urlInput.blur();
    if (store.activeTabId) navigateTab(store.activeTabId, val, true);
  });

  const urlInputEl = document.getElementById('urlInput');
  urlInputEl.addEventListener('click', () => {
    urlInputEl.select();
    store.omniboxSelectedIdx = -1;
    renderOmniboxSuggestions(urlInputEl.value);
  });
  urlInputEl.addEventListener('input', () => {
    store.omniboxSelectedIdx = -1;
    renderOmniboxSuggestions(urlInputEl.value);
  });
  urlInputEl.addEventListener('blur', () => {
    setTimeout(() => hideOmniboxSuggestions(), 120);
  });
  document.addEventListener('mousedown', (e) => {
    const form = document.getElementById('addressForm');
    if (form && !form.contains(e.target)) {
      hideOmniboxSuggestions();
    }
  });
  urlInputEl.addEventListener('keydown', (e) => {
    const items = store.omniboxCurrentItems || [];
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      store.omniboxSelectedIdx = (store.omniboxSelectedIdx + 1) % items.length;
      renderOmniboxSuggestions(urlInputEl.value);
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      store.omniboxSelectedIdx =
        (store.omniboxSelectedIdx - 1 + items.length) % items.length;
      renderOmniboxSuggestions(urlInputEl.value);
    } else if (e.key === 'Escape') {
      hideOmniboxSuggestions();
      urlInputEl.blur();
    }
  });

  // Find in Page Bar (Ctrl+F)
  document.getElementById('btnFindInPage').addEventListener('click', () => {
    toggleFindBar();
  });
  document.getElementById('btnFindClose').addEventListener('click', () => {
    toggleFindBar(false);
  });
  document.getElementById('btnFindNext').addEventListener('click', () => {
    findInActiveTab(false);
  });
  document.getElementById('btnFindPrev').addEventListener('click', () => {
    findInActiveTab(true);
  });
  document.getElementById('findInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findInActiveTab(e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      toggleFindBar(false);
    }
  });

  // Double-click empty tab strip space to open a new tab
  document.getElementById('tabsContainer').addEventListener('dblclick', (e) => {
    if (e.target.id === 'tabsContainer') {
      const containerId = document.getElementById('newTabContainerSelect').value || 'default';
      createTab({ url: 'browz://home', containerId, switchTo: true });
    }
  });

  // 60fps Drag-to-Resize Handle for Network Capture Dock
  const resizeHandle = document.getElementById('dockResizeHandle');
  const captureDock = document.getElementById('captureDock');
  if (resizeHandle && captureDock) {
    let isResizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isResizing = true;
      resizeHandle.classList.add('dragging');
      document.body.classList.add('resizing-dock');
    });
    window.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      requestAnimationFrame(() => {
        const viewportH = window.innerHeight;
        const newHeight = Math.max(170, Math.min(viewportH * 0.78, viewportH - e.clientY));
        captureDock.style.height = `${Math.round(newHeight)}px`;
      });
    });
    window.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizeHandle.classList.remove('dragging');
      document.body.classList.remove('resizing-dock');
    });
  }

  // Standard Browser Keyboard Shortcuts (Ctrl/Cmd+T, W, L, R, F, 1..9, Esc)
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === 't') {
      e.preventDefault();
      const containerId = document.getElementById('newTabContainerSelect').value || 'default';
      createTab({ url: 'browz://home', containerId, switchTo: true });
      urlInputEl.focus();
      urlInputEl.select();
    } else if (mod && key === 'w') {
      e.preventDefault();
      if (store.activeTabId) closeTab(store.activeTabId);
    } else if (mod && key === 'l') {
      e.preventDefault();
      urlInputEl.focus();
      urlInputEl.select();
    } else if ((mod && key === 'r') || e.key === 'F5') {
      e.preventDefault();
      document.getElementById('btnReload').click();
    } else if (mod && key === 'f') {
      e.preventDefault();
      toggleFindBar(true);
    } else if (mod && /^[1-9]$/.test(key)) {
      e.preventDefault();
      const idx = Number(key) - 1;
      const targetTab =
        idx === 8 ? store.tabs[store.tabs.length - 1] : store.tabs[idx];
      if (targetTab) activateTab(targetTab.id);
    } else if (e.key === 'Escape') {
      hideOmniboxSuggestions();
      toggleFindBar(false);
    }
  });

  document.getElementById('btnBookmarkPage').addEventListener('click', () => {
    toggleBookmarkCurrentPage();
  });

  document.getElementById('btnZoomOut').addEventListener('click', () => setPageZoom(-10));
  document.getElementById('btnZoomIn').addEventListener('click', () => setPageZoom(10));
  document.getElementById('zoomLabel').addEventListener('click', () => setPageZoom(0, true));

  const fitVideoBtn = document.getElementById('btnFitVideo');
  if (fitVideoBtn) {
    fitVideoBtn.addEventListener('click', () => {
      triggerVideoFitOnActiveTab();
    });
  }

  document.getElementById('btnSecurityAudit').addEventListener('click', () => {
    if (store.activeTabId) {
      navigateTab(store.activeTabId, 'browz://security', true);
    } else {
      createTab({ url: 'browz://security', containerId: 'default', switchTo: true });
    }
    showToast('Running 24-Point Security, I/O & Untraceability Audit...');
  });

  document.getElementById('btnHome').addEventListener('click', () => {
    if (store.activeTabId) navigateTab(store.activeTabId, 'browz://home', true);
  });

  document.getElementById('btnBack').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    const frame = document.getElementById(`frame-${tab.id}`);
    if (isStandaloneElectron() && frame && typeof frame.canGoBack === 'function' && frame.canGoBack()) {
      frame.goBack();
      return;
    }
    if (tab.historyIndex > 0) {
      tab.historyIndex--;
      navigateTab(tab.id, tab.history[tab.historyIndex], false);
    }
  });

  document.getElementById('btnForward').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    const frame = document.getElementById(`frame-${tab.id}`);
    if (isStandaloneElectron() && frame && typeof frame.canGoForward === 'function' && frame.canGoForward()) {
      frame.goForward();
      return;
    }
    if (tab.historyIndex < tab.history.length - 1) {
      tab.historyIndex++;
      navigateTab(tab.id, tab.history[tab.historyIndex], false);
    }
  });

  document.getElementById('btnReload').addEventListener('click', () => {
    const tab = store.tabs.find((t) => t.id === store.activeTabId);
    if (!tab) return;
    const frame = document.getElementById(`frame-${tab.id}`);
    if (tab.loading) {
      if (isStandaloneElectron() && frame && typeof frame.stop === 'function') {
        frame.stop();
      }
      finishTabLoading(tab);
      showToast('Stopped loading page');
      return;
    }
    if (isStandaloneElectron() && frame && typeof frame.reload === 'function') {
      startTabLoading(tab);
      frame.reload();
      return;
    }
    navigateTab(tab.id, tab.url, false);
  });

  document.getElementById('btnRotateIdentity').addEventListener('click', () => {
    rotateIdentityAndReload();
  });

  document.getElementById('btnToggleCaptureDock').addEventListener('click', () => {
    toggleCaptureDock();
  });

  document.getElementById('btnCloseDock').addEventListener('click', () => {
    toggleCaptureDock(false);
  });

  document.getElementById('btnMaximizeDock').addEventListener('click', () => {
    const stack = document.getElementById('centerStack');
    store.dockMaximized = !store.dockMaximized;
    stack.classList.toggle('dock-maximized', store.dockMaximized);
  });

  document.getElementById('btnRecordToggle').addEventListener('click', () => {
    const next = !store.state.capture.recording;
    updateCaptureSetting({ recording: next });
    showToast(next ? 'Traffic capture resumed' : 'Traffic capture paused');
  });

  document.getElementById('throttleSelect').addEventListener('change', (e) => {
    updateCaptureSetting({ throttlingPreset: e.target.value });
    showToast(`Network throttling: ${e.target.value}`);
  });

  const openStealthDrawer = () => {
    const drawer = document.getElementById('controlDrawer');
    drawer.classList.toggle('hidden');
    document.getElementById('btnToggleDrawer').classList.toggle('active-toggle', !drawer.classList.contains('hidden'));
  };

  document.getElementById('btnToggleDrawer').addEventListener('click', openStealthDrawer);
  document.getElementById('stealthBadge').addEventListener('click', () => {
    store.activeDrawerTab = 'stealth';
    renderControlDrawer(true);
    document.getElementById('controlDrawer').classList.remove('hidden');
    document.getElementById('btnToggleDrawer').classList.add('active-toggle');
  });

  document.getElementById('btnCloseDrawer').addEventListener('click', () => {
    document.getElementById('controlDrawer').classList.add('hidden');
    document.getElementById('btnToggleDrawer').classList.remove('active-toggle');
  });

  document.querySelectorAll('.drawer-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      store.activeDrawerTab = btn.dataset.dtab;
      renderControlDrawer(true);
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
    showToast('Cleared captured traffic log');
  });

  document.getElementById('filterSearch').addEventListener('input', (e) => {
    store.filters.search = e.target.value;
    scheduleRequestsRender();
  });
  document.getElementById('filterScope').addEventListener('change', (e) => {
    store.filters.scope = e.target.value;
    scheduleRequestsRender();
  });
  document.getElementById('filterMethod').addEventListener('change', (e) => {
    store.filters.method = e.target.value;
    scheduleRequestsRender();
  });
  document.getElementById('filterType').addEventListener('change', (e) => {
    store.filters.type = e.target.value;
    scheduleRequestsRender();
  });
  document.getElementById('filterStatus').addEventListener('change', (e) => {
    store.filters.status = e.target.value;
    scheduleRequestsRender();
  });
}

window.addEventListener('DOMContentLoaded', initApp);
