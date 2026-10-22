'use strict';

const USER_AGENT_PRESETS = {
  default: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Browz/1.0.0 Chrome/130.0.0.0 Safari/537.36',
  chrome_win: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  firefox_mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0',
  safari_ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  k6_loadtest: 'k6/0.54.0 (https://k6.io/) Browz-PerfCapture/1.0'
};

const THROTTLING_PRESETS = {
  none: { label: 'No Throttling', latencyMs: 0, downloadKbps: 0, uploadKbps: 0, offline: false },
  fast4g: { label: 'Fast 4G (40ms, 9 Mbps)', latencyMs: 40, downloadKbps: 9000, uploadKbps: 3000, offline: false },
  slow3g: { label: 'Slow 3G (300ms, 400 Kbps)', latencyMs: 300, downloadKbps: 400, uploadKbps: 400, offline: false },
  high_latency: { label: 'High Latency WAN (180ms)', latencyMs: 180, downloadKbps: 25000, uploadKbps: 10000, offline: false },
  offline: { label: 'Offline Mode', latencyMs: 0, downloadKbps: 0, uploadKbps: 0, offline: true }
};

function createInitialState() {
  return {
    capture: {
      recording: true,
      preserveLog: true,
      disableCache: true,
      captureBodies: true,
      maxEntries: 3000,
      throttling: {
        preset: 'none',
        latencyMs: 0,
        downloadKbps: 0,
        uploadKbps: 0,
        offline: false
      }
    },
    networkControl: {
      adBlockEnabled: true,
      forceHttps: false,
      bypassCors: true,
      stripReferer: false,
      stripTrackingHeaders: true,
      userAgentPreset: 'default',
      customUserAgent: '',
      proxy: {
        mode: 'direct', // 'direct' | 'http' | 'socks5'
        rules: '',      // e.g. 'http://127.0.0.1:8080' or 'socks5://127.0.0.1:9050'
        bypassList: 'localhost,127.0.0.1',
        dohUrl: 'https://cloudflare-dns.com/dns-query'
      },
      customRequestHeaders: [
        { id: 'hdr-1', enabled: true, name: 'X-Browz-Capture', value: 'perf-session-1', domainFilter: '*' },
        { id: 'hdr-2', enabled: false, name: 'Authorization', value: 'Bearer demo-test-token', domainFilter: '*' }
      ],
      customResponseHeaders: [
        { id: 'rhdr-1', enabled: true, name: 'Access-Control-Allow-Origin', value: '*', domainFilter: '*' }
      ],
      blockRules: [
        { id: 'blk-1', enabled: true, pattern: 'doubleclick.net', resourceType: 'ALL', note: 'Built-in Ad Tracker' },
        { id: 'blk-2', enabled: true, pattern: 'google-analytics.com', resourceType: 'ALL', note: 'Analytics Telemetry' },
        { id: 'blk-3', enabled: true, pattern: 'facebook.net/en_US/fbevents', resourceType: 'Script', note: 'Meta Pixel' },
        { id: 'blk-4', enabled: false, pattern: '.woff2', resourceType: 'Font', note: 'Skip web fonts during API perf test' }
      ]
    },
    containers: [
      {
        id: 'default',
        name: 'Default',
        color: '#3b82f6',
        partition: 'persist:default',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 2,
        cookies: {
          'browz.local': { session_mode: 'standard', theme: 'dark' }
        },
        storageStats: { localStorageKeys: 3, cacheKb: 128, lastCleared: null }
      },
      {
        id: 'user-a',
        name: 'User A (Perf)',
        color: '#10b981',
        partition: 'persist:user-a',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 3,
        cookies: {
          'browz.local': { auth_user: 'user_alpha_01', role: 'customer', tenant: 'us-east' }
        },
        storageStats: { localStorageKeys: 2, cacheKb: 64, lastCleared: null }
      },
      {
        id: 'user-b',
        name: 'User B (Perf)',
        color: '#f59e0b',
        partition: 'persist:user-b',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 3,
        cookies: {
          'browz.local': { auth_user: 'user_beta_02', role: 'customer', tenant: 'eu-west' }
        },
        storageStats: { localStorageKeys: 2, cacheKb: 52, lastCleared: null }
      },
      {
        id: 'admin',
        name: 'Admin Session',
        color: '#a855f7',
        partition: 'persist:admin',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 2,
        cookies: {
          'browz.local': { auth_user: 'admin_root', role: 'superadmin' }
        },
        storageStats: { localStorageKeys: 4, cacheKb: 96, lastCleared: null }
      },
      {
        id: 'burner',
        name: 'Burner (RAM Only)',
        color: '#ef4444',
        partition: 'ephemeral:burner',
        ephemeral: true,
        proxyRules: '',
        userAgent: '',
        cookieCount: 0,
        cookies: {},
        storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
      }
    ],
    permissions: {
      globalDefaults: {
        media: 'deny',           // Camera & Microphone
        geolocation: 'deny',     // GPS / Location
        notifications: 'deny',   // Push / Web Notifications
        clipboard: 'allow',      // Clipboard read/write
        popups: 'deny',          // window.open / target=_blank popups
        midi: 'deny',            // WebMIDI hardware
        usb: 'deny',             // WebUSB / WebHID / WebSerial
        externalProtocol: 'deny',// mailto:, tel:, custom OS schemes
        fullscreen: 'allow'      // Fullscreen API
      },
      siteOverrides: {
        'https://github.com': { clipboard: 'allow', notifications: 'deny' },
        'browz://testbench': { clipboard: 'allow', media: 'deny', geolocation: 'deny' }
      },
      eventLog: [
        {
          id: 'perm-1',
          timestamp: new Date().toISOString(),
          origin: 'browz://testbench',
          permission: 'geolocation',
          decision: 'deny',
          reason: 'Global firewall policy'
        }
      ]
    },
    downloads: {
      autoBlockDangerous: true,
      blockedExtensions: ['.exe', '.bat', '.cmd', '.msi', '.scr', '.apk', '.vbs'],
      items: []
    },
    osControl: {
      alwaysOnTop: false,
      userAgentPresets: USER_AGENT_PRESETS,
      throttlingPresets: THROTTLING_PRESETS
    }
  };
}

function shouldBlockRequest(urlStr, resourceType, networkControl) {
  if (!urlStr) return { blocked: false, reason: null };
  for (const rule of networkControl.blockRules || []) {
    if (!rule.enabled || !rule.pattern) continue;
    const typeMatch =
      !rule.resourceType ||
      rule.resourceType === 'ALL' ||
      rule.resourceType.toLowerCase() === (resourceType || '').toLowerCase();
    if (typeMatch && urlStr.toLowerCase().includes(rule.pattern.toLowerCase())) {
      return { blocked: true, reason: `Rule matched: "${rule.pattern}" (${rule.note || rule.resourceType || 'Custom'})` };
    }
  }
  return { blocked: false, reason: null };
}

function getEffectiveUserAgent(networkControl, container) {
  if (container && container.userAgent && container.userAgent.trim()) {
    return container.userAgent.trim();
  }
  if (networkControl.userAgentPreset === 'custom' && networkControl.customUserAgent) {
    return networkControl.customUserAgent;
  }
  return USER_AGENT_PRESETS[networkControl.userAgentPreset] || USER_AGENT_PRESETS.default;
}

module.exports = {
  USER_AGENT_PRESETS,
  THROTTLING_PRESETS,
  createInitialState,
  shouldBlockRequest,
  getEffectiveUserAgent
};
