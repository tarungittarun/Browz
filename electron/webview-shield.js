'use strict';

/**
 * Generates the executable JavaScript Triple-Layer Untraceability & Anti-Fingerprinting Shield
 * configured with the user's current `stealth` settings and `persona`.
 */
function buildStealthShieldScript(stealthConfig) {
  const cfg = stealthConfig || {
    enabled: true,
    noiseSeed: 482910,
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
    radioProfile: 'stealth_hidden',
    blockServiceWorkers: true,
    blockCacheStorage: true,
    blockFileSystemAccess: true,
    blockPersistentStorage: true,
    blockClipboardRead: true,
    blockWebSockets: false,
    timerJitter: true,
    fontFingerprintProtection: true,
    fitVideosToScreen: true,
    persona: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
    }
  };

  const safeCfgJson = JSON.stringify(cfg)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');

  return `(function applyBrowzStealthShield() {
  const CFG = ${safeCfgJson};
  if (!CFG || !CFG.enabled) return;
  const P = CFG.persona || {};
  const SEED = Number(CFG.noiseSeed || 482910);

  // 0. Native-Code Cloaking Engine (Defeats CreepJS / Cloudflare Turnstile / FingerprintJS Function.prototype.toString checks)
  const nativeStrings = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function markNative(fn, name) {
    if (typeof fn === 'function' && nativeStrings) {
      try {
        const cleanName = String(name !== undefined ? name : (fn.name || ''));
        nativeStrings.set(fn, 'function ' + cleanName + '() { [native code] }');
      } catch (e) {}
    }
    return fn;
  }
  try {
    const origFnToString = Function.prototype.toString;
    const cloakedToString = function() {
      if (nativeStrings && nativeStrings.has(this)) {
        return nativeStrings.get(this);
      }
      return origFnToString.apply(this, arguments);
    };
    markNative(cloakedToString, 'toString');
    const fnProtos = [Function.prototype];
    const realmFnProto = Object.getPrototypeOf(function() {});
    if (realmFnProto && realmFnProto !== Function.prototype) {
      fnProtos.push(realmFnProto);
    }
    for (const fp of fnProtos) {
      Object.defineProperty(fp, 'toString', {
        value: cloakedToString,
        writable: true,
        configurable: true
      });
    }
  } catch (e) {}

  function safeDefine(obj, prop, getterVal) {
    if (!obj) return;
    try {
      const getter = markNative(() => getterVal, 'get ' + prop);
      Object.defineProperty(obj, prop, {
        get: getter,
        configurable: true
      });
    } catch (e) {}
  }

  // 1. Hide Webdriver, Automation & Browser Instrumentation Traces
  safeDefine(navigator, 'webdriver', false);
  safeDefine(navigator, 'doNotTrack', '1');
  safeDefine(navigator, 'globalPrivacyControl', true);
  safeDefine(navigator, 'pdfViewerEnabled', true);

  // 2. Spoof Hardware, OS Platform, User-Agent & High-Entropy Client Hints (navigator.userAgentData)
  if (CFG.maskHardware) {
    if (P.userAgent) safeDefine(navigator, 'userAgent', P.userAgent);
    if (P.platform) safeDefine(navigator, 'platform', P.platform);
    if (P.vendor !== undefined) safeDefine(navigator, 'vendor', P.vendor);
    safeDefine(navigator, 'hardwareConcurrency', P.hardwareConcurrency || 8);
    safeDefine(navigator, 'deviceMemory', P.deviceMemory || 8);
    safeDefine(navigator, 'maxTouchPoints', 0);
  }

  if (CFG.spoofClientHints !== false) {
    const platName = (P.platform || 'Win32').includes('Mac')
      ? 'macOS'
      : (P.platform || '').includes('Linux')
        ? 'Linux'
        : 'Windows';
    const fakeUAData = {
      brands: Object.freeze([
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' }
      ]),
      mobile: false,
      platform: platName,
      getHighEntropyValues: markNative(async function(hints) {
        return {
          architecture: 'x86',
          bitness: '64',
          brands: this.brands,
          fullVersionList: this.brands,
          mobile: false,
          model: '',
          platform: platName,
          platformVersion: '10.0.0',
          uaFullVersion: '131.0.0.0',
          wow64: false
        };
      }, 'getHighEntropyValues'),
      toJSON: markNative(function() {
        return { brands: this.brands, mobile: false, platform: platName };
      }, 'toJSON')
    };
    safeDefine(navigator, 'userAgentData', fakeUAData);
  }

  // 3. Spoof Language & Locale
  if (CFG.spoofLanguage) {
    safeDefine(navigator, 'language', P.language || 'en-US');
    safeDefine(navigator, 'languages', Object.freeze(P.languages || ['en-US', 'en']));
  }

  // 4. Spoof Timezone & Offset (hides real country/city timezone like Asia/Calcutta)
  if (CFG.spoofTimezone && P.timezone) {
    try {
      const OrigDateTimeFormat = Intl.DateTimeFormat;
      const origResolvedOptions = OrigDateTimeFormat.prototype.resolvedOptions;
      OrigDateTimeFormat.prototype.resolvedOptions = markNative(function(...args) {
        const res = origResolvedOptions.apply(this, args);
        res.timeZone = P.timezone;
        res.locale = P.language || 'en-US';
        return res;
      }, 'resolvedOptions');
      Date.prototype.getTimezoneOffset = markNative(function() {
        return typeof P.tzOffsetMin === 'number' ? P.tzOffsetMin : 0;
      }, 'getTimezoneOffset');
    } catch (e) {}
  }

  // 5. Mask Screen Resolution, Taskbar Size & Pixel Ratio
  if (CFG.maskScreenResolution && typeof window !== 'undefined' && window.screen) {
    const w = P.screenWidth || 1920;
    const h = P.screenHeight || 1080;
    const cd = P.colorDepth || 24;
    safeDefine(window.screen, 'width', w);
    safeDefine(window.screen, 'height', h);
    safeDefine(window.screen, 'availWidth', w);
    safeDefine(window.screen, 'availHeight', h);
    safeDefine(window.screen, 'colorDepth', cd);
    safeDefine(window.screen, 'pixelDepth', cd);
    safeDefine(window, 'devicePixelRatio', P.pixelRatio || 1);
    safeDefine(window, 'outerWidth', w);
    safeDefine(window, 'outerHeight', h);
  }

  // 6. Spoof WebGL & WebGL2 GPU Vendor & Renderer (blocks exact GPU model tracking)
  if (CFG.webglSpoof) {
    function patchWebGL(proto) {
      if (!proto || !proto.getParameter) return;
      const origGetParam = proto.getParameter;
      proto.getParameter = markNative(function(parameter) {
        // UNMASKED_VENDOR_WEBGL = 0x9245 (37445), UNMASKED_RENDERER_WEBGL = 0x9246 (37446)
        if (parameter === 37445 || parameter === 7936) return P.webglVendor || 'Intel Inc.';
        if (parameter === 37446 || parameter === 7937) return P.webglRenderer || 'Intel(R) Iris(R) Xe Graphics';
        return origGetParam.apply(this, arguments);
      }, 'getParameter');
    }
    if (typeof WebGLRenderingContext !== 'undefined') patchWebGL(WebGLRenderingContext.prototype);
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext.prototype);
  }

  // 7. Canvas 2D Fingerprint Noise (toDataURL, toBlob, and getImageData)
  if (CFG.canvasNoise) {
    const lcgNoise = ((SEED * 1664525 + 1013904223) >>> 0);
    const d0 = ((lcgNoise & 0x7f) || 1);
    const d1 = (((lcgNoise >> 7) & 0x7f) || 1);
    const d2 = (((lcgNoise >> 14) & 0x7f) || 1);
    if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype.getImageData) {
      const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = markNative(function(...args) {
        const imgData = origGetImageData.apply(this, args);
        try {
          if (imgData && imgData.data && imgData.data.length >= 4) {
            imgData.data[0] = (imgData.data[0] + d0) & 0xff;
            imgData.data[1] = (imgData.data[1] + d1) & 0xff;
            imgData.data[2] = (imgData.data[2] + d2) & 0xff;
          }
        } catch (e) {}
        return imgData;
      }, 'getImageData');
    }
    if (typeof HTMLCanvasElement !== 'undefined') {
      const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = markNative(function(...args) {
        try {
          const ctx = this.getContext && this.getContext('2d');
          if (ctx && this.width > 0 && this.height > 0) {
            const imgData = ctx.getImageData(0, 0, Math.min(4, this.width), Math.min(4, this.height));
            imgData.data[0] = (imgData.data[0] + d0) & 0xff;
            imgData.data[1] = (imgData.data[1] + d1) & 0xff;
            imgData.data[2] = (imgData.data[2] + d2) & 0xff;
            ctx.putImageData(imgData, 0, 0);
          }
        } catch (e) {}
        return origToDataURL.apply(this, args);
      }, 'toDataURL');
    }
  }

  // 8. AudioContext & AnalyserNode Fingerprint Noise (prevents sound-card/oscillator hashing)
  if (CFG.audioNoise) {
    if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
      const origGetChannelData = AudioBuffer.prototype.getChannelData;
      AudioBuffer.prototype.getChannelData = markNative(function(...args) {
        const data = origGetChannelData.apply(this, args);
        try {
          const jitter = ((SEED % 97) + 1) * 1e-7;
          for (let i = 0; i < Math.min(data.length, 64); i += 8) {
            data[i] = data[i] + jitter;
          }
        } catch (e) {}
        return data;
      }, 'getChannelData');
    }
    if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype.getFloatFrequencyData) {
      const origGetFreq = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = markNative(function(array) {
        const res = origGetFreq.apply(this, arguments);
        try {
          if (array && array.length > 0) {
            const jitter = ((SEED % 53) + 1) * 1e-5;
            for (let i = 0; i < Math.min(array.length, 32); i += 4) {
              array[i] += jitter;
            }
          }
        } catch (e) {}
        return res;
      }, 'getFloatFrequencyData');
    }
  }

  // 9. ClientRects Sub-Pixel Jitter (prevents font-measurement fingerprinting)
  if (CFG.clientRectsNoise && typeof Element !== 'undefined' && Element.prototype.getBoundingClientRect) {
    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = markNative(function(...args) {
      const rect = origGetBoundingClientRect.apply(this, args);
      try {
        const delta = ((SEED % 19) + 1) * 1e-4;
        if (rect && typeof rect.width === 'number') {
          safeDefine(rect, 'width', rect.width + delta);
          safeDefine(rect, 'height', rect.height + delta);
        }
      } catch (e) {}
      return rect;
    }, 'getBoundingClientRect');
  }

  // 10. Block WebRTC STUN/ICE Local & ISP IP Leak
  if (CFG.blockWebRTCLeak) {
    const BlockedRTC = markNative(function() {
      throw new DOMException('WebRTC peer connections disabled by Browz Anonymity Shield to prevent IP leak.', 'NotAllowedError');
    }, 'RTCPeerConnection');
    try {
      window.RTCPeerConnection = BlockedRTC;
      window.webkitRTCPeerConnection = BlockedRTC;
      window.mozRTCPeerConnection = BlockedRTC;
      window.RTCDataChannel = undefined;
      window.RTCSessionDescription = undefined;
    } catch (e) {}
  }

  // 11. Block Battery, Motion Sensors, Gamepad, USB, Bluetooth, Speech Voices, Storage Quota & Beacons
  if (CFG.blockBatteryAndSensors) {
    safeDefine(navigator, 'getBattery', undefined);
    safeDefine(navigator, 'getGamepads', markNative(() => [], 'getGamepads'));
    safeDefine(navigator, 'bluetooth', undefined);
    safeDefine(navigator, 'usb', undefined);
    safeDefine(navigator, 'serial', undefined);
    safeDefine(navigator, 'hid', undefined);
    try {
      window.DeviceMotionEvent = undefined;
      window.DeviceOrientationEvent = undefined;
    } catch (e) {}
  }

  // 12. Wi-Fi / Cellular / Radio & Network Adapter Spoofing & Air-Gap Kill-Switch
  const radioMode = CFG.radioProfile || 'stealth_hidden';
  if (radioMode === 'stealth_hidden') {
    safeDefine(navigator, 'onLine', true);
    if (CFG.blockBatteryAndSensors !== false) {
      safeDefine(navigator, 'connection', undefined);
      safeDefine(navigator, 'mozConnection', undefined);
      safeDefine(navigator, 'webkitConnection', undefined);
    }
  } else {
    const radioPresets = {
      wifi_fiber: { online: true, type: 'wifi', effectiveType: '4g', downlink: 100, downlinkMax: 1000, rtt: 5, saveData: false },
      cellular_4g: { online: true, type: 'cellular', effectiveType: '4g', downlink: 12, downlinkMax: 50, rtt: 45, saveData: false },
      cellular_3g_saver: { online: true, type: 'cellular', effectiveType: '3g', downlink: 1.2, downlinkMax: 3.6, rtt: 220, saveData: true },
      airgap_killswitch: { online: false, type: 'none', effectiveType: 'slow-2g', downlink: 0, downlinkMax: 0, rtt: 0, saveData: true }
    };
    const rp = radioPresets[radioMode] || radioPresets.wifi_fiber;
    safeDefine(navigator, 'onLine', rp.online);
    const fakeConn = Object.freeze({
      type: rp.type,
      effectiveType: rp.effectiveType,
      downlink: rp.downlink,
      downlinkMax: rp.downlinkMax,
      rtt: rp.rtt,
      saveData: rp.saveData,
      onchange: null,
      addEventListener: markNative(function() {}, 'addEventListener'),
      removeEventListener: markNative(function() {}, 'removeEventListener'),
      dispatchEvent: markNative(function() { return true; }, 'dispatchEvent')
    });
    safeDefine(navigator, 'connection', fakeConn);
    safeDefine(navigator, 'mozConnection', fakeConn);
    safeDefine(navigator, 'webkitConnection', fakeConn);
  }

  if (CFG.blockSpeechVoices !== false && typeof window !== 'undefined' && window.speechSynthesis) {
    try {
      window.speechSynthesis.getVoices = markNative(() => [], 'getVoices');
    } catch (e) {}
  }

  if (CFG.spoofStorageQuota !== false && navigator.storage && navigator.storage.estimate) {
    try {
      navigator.storage.estimate = markNative(async () => ({
        usage: 0,
        quota: 10737418240
      }), 'estimate');
    } catch (e) {}
  }

  if (typeof performance !== 'undefined' && performance.memory) {
    safeDefine(performance, 'memory', {
      jsHeapSizeLimit: 2172649472,
      totalJSHeapSize: 35651584,
      usedJSHeapSize: 16777216
    });
  }

  // 13. High-Resolution Timer Jitter (Defeats Spectre / Clock-Skew Timing Side-Channels)
  if (CFG.timerJitter !== false && typeof performance !== 'undefined' && typeof performance.now === 'function') {
    try {
      const origPerfNow = performance.now.bind(performance);
      const jitterOffset = ((SEED % 37) + 1) * 0.001;
      performance.now = markNative(function() {
        const raw = origPerfNow();
        return Math.round(raw * 10) / 10 + jitterOffset;
      }, 'now');
    } catch (e) {}
  }

  if (CFG.blockMediaEnumeration && navigator.mediaDevices) {
    navigator.mediaDevices.enumerateDevices = markNative(async function() {
      return [];
    }, 'enumerateDevices');
  }

  if (CFG.blockSendBeacon && navigator.sendBeacon) {
    navigator.sendBeacon = markNative(function() {
      return true; // silently drop background analytics beacons
    }, 'sendBeacon');
  }

  // 14. Disk & Persistent Storage I/O Firewall (ServiceWorkers, CacheStorage, OPFS, File Picker, Persist)
  if (CFG.blockServiceWorkers !== false) {
    const blockedSW = {
      controller: null,
      ready: new Promise(() => {}),
      register: async function() {
        throw new DOMException('ServiceWorker disk persistence blocked by Browz I/O Firewall', 'SecurityError');
      },
      getRegistration: async function() { return undefined; },
      getRegistrations: async function() { return []; },
      addEventListener: function() {},
      removeEventListener: function() {}
    };
    safeDefine(navigator, 'serviceWorker', blockedSW);
  }

  if (CFG.blockCacheStorage !== false && typeof window !== 'undefined') {
    const blockedCaches = {
      open: async function() {
        throw new DOMException('CacheStorage supercookie I/O blocked by Browz I/O Firewall', 'SecurityError');
      },
      has: async function() { return false; },
      match: async function() { return undefined; },
      delete: async function() { return false; },
      keys: async function() { return []; }
    };
    safeDefine(window, 'caches', blockedCaches);
  }

  if (CFG.blockFileSystemAccess !== false && typeof window !== 'undefined') {
    safeDefine(window, 'showOpenFilePicker', undefined);
    safeDefine(window, 'showSaveFilePicker', undefined);
    safeDefine(window, 'showDirectoryPicker', undefined);
    if (navigator.storage) {
      safeDefine(navigator.storage, 'getDirectory', undefined);
    }
  }

  if (CFG.blockPersistentStorage !== false && navigator.storage) {
    try {
      navigator.storage.persist = markNative(async () => false, 'persist');
      navigator.storage.persisted = markNative(async () => false, 'persisted');
    } catch (e) {}
  }

  // 15. Clipboard Read Snooping & Live WebSocket Stream I/O Firewall
  if (CFG.blockClipboardRead !== false && navigator.clipboard) {
    try {
      navigator.clipboard.readText = markNative(async function() {
        throw new DOMException('Clipboard read blocked by Browz I/O Firewall', 'NotAllowedError');
      }, 'readText');
      navigator.clipboard.read = markNative(async function() {
        throw new DOMException('Clipboard read blocked by Browz I/O Firewall', 'NotAllowedError');
      }, 'read');
    } catch (e) {}
  }

  if (CFG.blockWebSockets === true && typeof window !== 'undefined') {
    const BlockedSocket = markNative(function() {
      throw new DOMException('WebSocket stream I/O disabled by Browz I/O Firewall', 'SecurityError');
    }, 'WebSocket');
    safeDefine(window, 'WebSocket', BlockedSocket);
    safeDefine(window, 'EventSource', BlockedSocket);
  }

  // 16. Font Enumeration Fingerprinting Protection
  if (CFG.fontFingerprintProtection !== false && typeof document !== 'undefined' && document.fonts) {
    try {
      const standardFonts = ['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'sans-serif', 'serif', 'monospace'];
      document.fonts.check = markNative(function(fontSpec) {
        const spec = String(fontSpec || '').toLowerCase();
        return standardFonts.some((f) => spec.includes(f.toLowerCase()));
      }, 'check');
    } catch (e) {}
  }

  // 17. Responsive Video Fit-to-Screen Engine & <a target="_blank"> Click Compatibility
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const injectMediaAndClickFixes = function() {
      try {
        if (document.head && !document.getElementById('browz-media-fit-style')) {
          const st = document.createElement('style');
          st.id = 'browz-media-fit-style';
          st.textContent = [
            'video { max-width: 100%; object-fit: contain; }',
            'video:fullscreen, video:-webkit-full-screen { width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; object-fit: contain !important; background: #000 !important; }',
            'video.browz-video-fitted, iframe.browz-video-fitted { position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; max-width: 100vw !important; max-height: 100vh !important; z-index: 2147483646 !important; background: #000 !important; object-fit: contain !important; margin: 0 !important; border: none !important; }',
            '#browz-video-fit-exit { position: fixed; top: 14px; right: 16px; z-index: 2147483647; background: rgba(24,24,28,0.88); color: #f4f4f5; border: 1px solid #3f3f4a; border-radius: 7px; padding: 6px 12px; font: 600 12px -apple-system, sans-serif; cursor: pointer; box-shadow: 0 4px 14px rgba(0,0,0,0.5); }'
          ].join('\\n');
          document.head.appendChild(st);
        }
        // Rewrite <a target="_blank"> so button/link clicks never get swallowed by popup blockers
        const blankLinks = document.querySelectorAll('a[target="_blank"]');
        for (let i = 0; i < blankLinks.length; i++) {
          blankLinks[i].removeAttribute('target');
        }
      } catch (e) {}
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectMediaAndClickFixes);
    } else {
      injectMediaAndClickFixes();
    }

    const toggleVideoFitFn = function(forceState) {
      try {
        const existingFitted = document.querySelector('.browz-video-fitted');
        const exitBtn = document.getElementById('browz-video-fit-exit');
        if (existingFitted && forceState !== true) {
          existingFitted.classList.remove('browz-video-fitted');
          if (exitBtn) exitBtn.remove();
          if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          }
          return { fitted: false };
        }
        const candidates = Array.from(document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"], iframe[src*="player"]'));
        let target = candidates.find((el) => el.tagName === 'VIDEO' && !el.paused) || candidates[0];
        if (!target) return { fitted: false, reason: 'No video element found on page' };
        target.classList.add('browz-video-fitted');
        if (target.tagName === 'VIDEO') {
          target.setAttribute('playsinline', 'true');
          target.setAttribute('controls', 'true');
        }
        if (!document.getElementById('browz-video-fit-exit') && document.body) {
          const btn = document.createElement('button');
          btn.id = 'browz-video-fit-exit';
          btn.textContent = '✕ Exit Video Fit (Esc)';
          btn.onclick = function() { window.__browzToggleVideoFit(false); };
          document.body.appendChild(btn);
        }
        return { fitted: true, tagName: target.tagName };
      } catch (e) {
        return { fitted: false, error: e.message };
      }
    };

    try {
      Object.defineProperty(window, '__browzToggleVideoFit', {
        value: toggleVideoFitFn,
        enumerable: false,
        configurable: true,
        writable: true
      });
    } catch (e) {
      window.__browzToggleVideoFit = toggleVideoFitFn;
    }

    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && typeof window.__browzToggleVideoFit === 'function') {
        const fitted = document.querySelector('.browz-video-fitted');
        if (fitted) window.__browzToggleVideoFit(false);
      }
    });

    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'browz:toggle-video-fit') {
        window.__browzToggleVideoFit();
      }
    });
  }

  const stealthStateObj = {
    seed: SEED,
    personaId: CFG.activePersonaId || P.id || 'win_generic',
    platform: P.platform || 'Win32',
    webglVendor: P.webglVendor || 'Intel Inc.',
    webglRenderer: P.webglRenderer || 'Intel(R) Iris(R) Xe Graphics',
    timezone: P.timezone || 'UTC',
    radioProfile: radioMode,
    nativeCloaking: true,
    ioFirewall: {
      serviceWorkersBlocked: CFG.blockServiceWorkers !== false,
      cacheStorageBlocked: CFG.blockCacheStorage !== false,
      fileSystemBlocked: CFG.blockFileSystemAccess !== false,
      clipboardReadBlocked: CFG.blockClipboardRead !== false,
      webSocketsBlocked: CFG.blockWebSockets === true
    }
  };
  try {
    Object.defineProperty(window, '__BROWZ_STEALTH_ACTIVE__', {
      value: stealthStateObj,
      enumerable: false,
      configurable: true,
      writable: true
    });
  } catch (e) {
    window.__BROWZ_STEALTH_ACTIVE__ = stealthStateObj;
  }
})();`;
}

if (typeof window !== 'undefined') {
  try {
    // eslint-disable-next-line no-eval
    eval(buildStealthShieldScript());
  } catch {}
}

module.exports = { buildStealthShieldScript };
