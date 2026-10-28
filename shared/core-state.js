'use strict';

const USER_AGENT_PRESETS = {
  win_chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  mac_safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  linux_firefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0',
  ios_safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  tor_browser: 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0',
  default: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
};

const STEALTH_PERSONAS = {
  win_generic: {
    id: 'win_generic',
    label: 'Windows 11 — Generic Intel PC (Stealth Default)',
    userAgent: USER_AGENT_PRESETS.win_chrome,
    platform: 'Win32',
    vendor: 'Google Inc.',
    webglVendor: 'Intel Inc.',
    webglRenderer: 'Intel(R) Iris(R) Xe Graphics',
    screenWidth: 1920,
    screenHeight: 1080,
    colorDepth: 24,
    pixelRatio: 1,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    timezone: 'UTC',
    tzOffsetMin: 0,
    language: 'en-US',
    languages: ['en-US', 'en']
  },
  mac_pro: {
    id: 'mac_pro',
    label: 'macOS Sonoma — Apple M3 Silicon',
    userAgent: USER_AGENT_PRESETS.mac_safari,
    platform: 'MacIntel',
    vendor: 'Apple Computer, Inc.',
    webglVendor: 'Apple Inc.',
    webglRenderer: 'Apple M3',
    screenWidth: 1728,
    screenHeight: 1117,
    colorDepth: 30,
    pixelRatio: 2,
    hardwareConcurrency: 8,
    deviceMemory: 8,
    timezone: 'UTC',
    tzOffsetMin: 0,
    language: 'en-US',
    languages: ['en-US', 'en']
  },
  linux_workstation: {
    id: 'linux_workstation',
    label: 'Linux Ubuntu — Privacy Workstation',
    userAgent: USER_AGENT_PRESETS.linux_firefox,
    platform: 'Linux x86_64',
    vendor: '',
    webglVendor: 'Mesa',
    webglRenderer: 'Mesa Intel(R) UHD Graphics (CML GT2)',
    screenWidth: 1920,
    screenHeight: 1080,
    colorDepth: 24,
    pixelRatio: 1,
    hardwareConcurrency: 4,
    deviceMemory: 8,
    timezone: 'UTC',
    tzOffsetMin: 0,
    language: 'en-US',
    languages: ['en-US', 'en']
  },
  tor_standard: {
    id: 'tor_standard',
    label: 'Tor Browser Standard — High Anonymity Profile',
    userAgent: USER_AGENT_PRESETS.tor_browser,
    platform: 'Win32',
    vendor: '',
    webglVendor: 'Mozilla',
    webglRenderer: 'Mozilla',
    screenWidth: 1000,
    screenHeight: 1000,
    colorDepth: 24,
    pixelRatio: 1,
    hardwareConcurrency: 2,
    deviceMemory: 4,
    timezone: 'UTC',
    tzOffsetMin: 0,
    language: 'en-US',
    languages: ['en-US', 'en']
  }
};

const DOH_PROVIDERS = {
  cloudflare: { label: 'Cloudflare 1.1.1.1 (Encrypted DoH)', url: 'https://cloudflare-dns.com/dns-query' },
  quad9: { label: 'Quad9 9.9.9.9 (Malware Blocking + Encrypted)', url: 'https://dns.quad9.net/dns-query' },
  mullvad: { label: 'Mullvad Privacy DNS (Zero-Log Encrypted)', url: 'https://dns.mullvad.net/dns-query' },
  adguard: { label: 'AdGuard DNS (Ad/Tracker Blocking DoH)', url: 'https://dns.adguard-dns.com/dns-query' }
};

const THROTTLING_PRESETS = {
  none: { label: 'No Throttling', latencyMs: 0, downloadKbps: 0, uploadKbps: 0, offline: false },
  fast4g: { label: 'Fast 4G (40ms, 9 Mbps)', latencyMs: 40, downloadKbps: 9000, uploadKbps: 3000, offline: false },
  slow3g: { label: 'Slow 3G (300ms, 400 Kbps)', latencyMs: 300, downloadKbps: 400, uploadKbps: 400, offline: false },
  high_latency: { label: 'High Latency WAN (180ms)', latencyMs: 180, downloadKbps: 25000, uploadKbps: 10000, offline: false },
  offline: { label: 'Offline Mode', latencyMs: 0, downloadKbps: 0, uploadKbps: 0, offline: true }
};

const RADIO_PROFILES = {
  stealth_hidden: {
    id: 'stealth_hidden',
    label: 'Stealth Mask (Hide Wi-Fi / Radio Type)',
    hideConnectionApi: true,
    online: true,
    type: 'unknown',
    effectiveType: '4g',
    downlink: 10,
    rtt: 50,
    saveData: false,
    latencyMs: 0
  },
  wifi_fiber: {
    id: 'wifi_fiber',
    label: 'Wi-Fi 6 Fiber (100 Mbps, 5ms RTT)',
    hideConnectionApi: false,
    online: true,
    type: 'wifi',
    effectiveType: '4g',
    downlink: 100,
    rtt: 5,
    saveData: false,
    latencyMs: 0
  },
  cellular_4g: {
    id: 'cellular_4g',
    label: 'Cellular 4G LTE (12 Mbps, 45ms RTT)',
    hideConnectionApi: false,
    online: true,
    type: 'cellular',
    effectiveType: '4g',
    downlink: 12,
    rtt: 45,
    saveData: false,
    latencyMs: 45
  },
  cellular_3g_saver: {
    id: 'cellular_3g_saver',
    label: 'Cellular 3G + Data Saver (1.2 Mbps, 220ms RTT)',
    hideConnectionApi: false,
    online: true,
    type: 'cellular',
    effectiveType: '3g',
    downlink: 1.2,
    rtt: 220,
    saveData: true,
    latencyMs: 220
  },
  airgap_killswitch: {
    id: 'airgap_killswitch',
    label: 'Air-Gap Radio Kill-Switch (Cut All Network I/O)',
    hideConnectionApi: false,
    online: false,
    type: 'none',
    effectiveType: 'slow-2g',
    downlink: 0,
    rtt: 0,
    saveData: true,
    latencyMs: 0,
    offline: true
  }
};

const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_viz_id',
  'utm_pubreferrer',
  'fbclid',
  'gclid',
  'gclsrc',
  'msclkid',
  'dclid',
  'twclid',
  'ttclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  'igshid',
  'si',
  'spm',
  'vero_id',
  'mkt_tok',
  'oly_enc_id',
  'oly_anon_id',
  'rb_clickid',
  's_kwcid',
  'zanpid',
  'wickedid'
]);

function createInitialState() {
  const defaultPersona = STEALTH_PERSONAS.win_generic;
  return {
    stealth: {
      enabled: true,
      activePersonaId: 'win_generic',
      noiseSeed: Math.floor(Math.random() * 900000) + 100000,
      canvasNoise: true,
      webglSpoof: true,
      audioNoise: true,
      clientRectsNoise: true,
      blockWebRTCLeak: true,
      maskScreenResolution: true,
      maskHardware: true,
      spoofTimezone: true,
      spoofLanguage: true,
      spoofClientHints: true,
      spoofStorageQuota: true,
      blockSpeechVoices: true,
      blockBatteryAndSensors: true,
      blockMediaEnumeration: true,
      blockSendBeacon: true,
      stripTrackingParams: true,
      radioProfile: 'stealth_hidden', // 'stealth_hidden' | 'wifi_fiber' | 'cellular_4g' | 'cellular_3g_saver' | 'airgap_killswitch'
      blockServiceWorkers: true,
      blockCacheStorage: true,
      blockFileSystemAccess: true,
      blockPersistentStorage: true,
      blockClipboardRead: true,
      blockWebSockets: false,
      timerJitter: true,
      fontFingerprintProtection: true,
      fitVideosToScreen: true,
      searchEngine: 'duckduckgo', // 'duckduckgo' | 'google' | 'startpage' | 'brave'
      persona: { ...defaultPersona }
    },
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
      forceHttps: true,
      bypassCors: false,
      allowSelfSignedCerts: false,
      stripReferer: true,
      stripTrackingHeaders: true,
      autoRetryFailedRequests: true,
      maxRetries: 2,
      userAgentPreset: 'win_chrome',
      customUserAgent: '',
      proxy: {
        mode: 'direct', // 'direct' | 'http' | 'socks5'
        rules: '',      // e.g. 'socks5://127.0.0.1:9050' (Tor) or 'http://127.0.0.1:8080'
        bypassList: 'localhost,127.0.0.1',
        dohProvider: 'cloudflare',
        dohUrl: 'https://cloudflare-dns.com/dns-query'
      },
      customRequestHeaders: [
        { id: 'hdr-1', enabled: false, name: 'X-Browz-Capture', value: 'perf-session-1', domainFilter: '*' },
        { id: 'hdr-2', enabled: false, name: 'Authorization', value: 'Bearer demo-test-token', domainFilter: '*' }
      ],
      customResponseHeaders: [],
      blockRules: [
        { id: 'blk-1', enabled: true, pattern: 'doubleclick.net', resourceType: 'ALL', note: 'Google Ad Tracker' },
        { id: 'blk-2', enabled: true, pattern: 'google-analytics.com', resourceType: 'ALL', note: 'Google Analytics Telemetry' },
        { id: 'blk-3', enabled: true, pattern: 'googletagmanager.com', resourceType: 'ALL', note: 'Google Tag Manager' },
        { id: 'blk-4', enabled: true, pattern: 'facebook.net/en_US/fbevents', resourceType: 'Script', note: 'Meta Pixel Tracker' },
        { id: 'blk-5', enabled: true, pattern: 'hotjar.com', resourceType: 'ALL', note: 'Session Recording Tracker' },
        { id: 'blk-6', enabled: true, pattern: 'clarity.ms', resourceType: 'ALL', note: 'Behavioral Fingerprinting' },
        { id: 'blk-7', enabled: true, pattern: 'googlesyndication.com', resourceType: 'ALL', note: 'AdSense Network' },
        { id: 'blk-8', enabled: true, pattern: 'scorecardresearch.com', resourceType: 'ALL', note: 'Cross-Site Beacon' },
        { id: 'blk-9', enabled: true, pattern: 'mixpanel.com', resourceType: 'ALL', note: 'Event Telemetry' },
        { id: 'blk-10', enabled: true, pattern: 'amplitude.com', resourceType: 'ALL', note: 'Product Analytics' },
        { id: 'blk-11', enabled: false, pattern: '.woff2', resourceType: 'Font', note: 'Skip web fonts during API perf test' }
      ],
      strippedParamsCount: 0,
      blockedTrackersCount: 0
    },
    containers: [
      {
        id: 'default',
        name: 'Default',
        color: '#38bdf8',
        partition: 'persist:default',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 0,
        cookies: {},
        storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
      },
      {
        id: 'burner',
        name: 'Ghost / Burner (RAM Only)',
        color: '#ef4444',
        partition: 'ephemeral:burner',
        ephemeral: true,
        proxyRules: '',
        userAgent: '',
        cookieCount: 0,
        cookies: {},
        storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
      },
      {
        id: 'user-a',
        name: 'User A (Isolated)',
        color: '#10b981',
        partition: 'persist:user-a',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 0,
        cookies: {},
        storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
      },
      {
        id: 'user-b',
        name: 'User B (Isolated)',
        color: '#f59e0b',
        partition: 'persist:user-b',
        ephemeral: false,
        proxyRules: '',
        userAgent: '',
        cookieCount: 0,
        cookies: {},
        storageStats: { localStorageKeys: 0, cacheKb: 0, lastCleared: null }
      },
      {
        id: 'admin',
        name: 'Admin Session',
        color: '#a855f7',
        partition: 'persist:admin',
        ephemeral: false,
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
      siteOverrides: {},
      eventLog: []
    },
    downloads: {
      autoBlockDangerous: true,
      blockedExtensions: ['.exe', '.bat', '.cmd', '.msi', '.scr', '.apk', '.vbs', '.ps1', '.hta', '.jar'],
      items: []
    },
    bookmarks: [
      { id: 'bm-1', title: 'New Tab', url: 'browz://home' },
      { id: 'bm-2', title: 'Security Audit (18 Checks)', url: 'browz://security' },
      { id: 'bm-3', title: 'API & Load Testbench', url: 'browz://testbench' },
      { id: 'bm-4', title: 'GitHub', url: 'https://github.com' },
      { id: 'bm-5', title: 'NPM Registry API', url: 'https://registry.npmjs.org/express/latest' },
      { id: 'bm-6', title: 'PyPI API', url: 'https://pypi.org/pypi/requests/json' }
    ],
    osControl: {
      alwaysOnTop: false,
      userAgentPresets: USER_AGENT_PRESETS,
      stealthPersonas: STEALTH_PERSONAS,
      dohProviders: DOH_PROVIDERS,
      throttlingPresets: THROTTLING_PRESETS,
      radioProfiles: RADIO_PROFILES
    }
  };
}

function stripUrlTrackingParams(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { url: urlStr, strippedCount: 0 };
    }
    let strippedCount = 0;
    for (const key of [...u.searchParams.keys()]) {
      const low = key.toLowerCase();
      if (TRACKING_QUERY_PARAMS.has(low) || low.startsWith('utm_')) {
        u.searchParams.delete(key);
        strippedCount++;
      }
    }
    return { url: strippedCount > 0 ? u.toString() : urlStr, strippedCount };
  } catch {
    return { url: urlStr, strippedCount: 0 };
  }
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

function getEffectiveUserAgent(networkControl, container, stealth) {
  if (container && container.userAgent && container.userAgent.trim()) {
    return container.userAgent.trim();
  }
  if (networkControl.userAgentPreset === 'custom' && networkControl.customUserAgent) {
    return networkControl.customUserAgent;
  }
  if (stealth && stealth.enabled && stealth.persona && stealth.persona.userAgent) {
    return stealth.persona.userAgent;
  }
  return USER_AGENT_PRESETS[networkControl.userAgentPreset] || USER_AGENT_PRESETS.default;
}

module.exports = {
  USER_AGENT_PRESETS,
  STEALTH_PERSONAS,
  DOH_PROVIDERS,
  THROTTLING_PRESETS,
  RADIO_PROFILES,
  TRACKING_QUERY_PARAMS,
  createInitialState,
  stripUrlTrackingParams,
  shouldBlockRequest,
  getEffectiveUserAgent
};
