# Changelog

## 1.0.3 preview (current)

### Added
- **Containers** for separate account spaces; switching closes every page and wipes
  cookies plus site storage.
- **Network rules**: block or allow any domain, with an allow entry overriding the
  built-in tracker list.
- **Real status measuring**: an optional cookie-less HEAD probe for top-level pages,
  shown honestly in the request log.
- **Hardware & permissions** screen: enforced-state report, screenshot protection,
  download policy, sensor/clipboard/file-picker toggles.
- Persistent bookmarks, share, find/zoom/fit-video, new menu.
- CSV request-log export with a real status column.

### Security
- **The persona can no longer contradict itself.** Selecting the iPhone profile used to
  leave `navigator.userAgentData`, `navigator.vendor` ("Google Inc.") and
  `navigator.appVersion` real, so one line of JavaScript revealed an Android Chromium
  WebView behind a Safari user agent. These now derive from the persona's user agent.
- **Device facts follow the persona**: `maxTouchPoints`, `devicePixelRatio`, the plugin
  and mime lists, and the core count (previously a constant 8 for every visitor).
- **The shield no longer identifies itself.** It used to define
  `window.__BROWZ_MOBILE_SHIELD_ACTIVE__` and a `BrowzNative` property on every page,
  so a single `'BrowzNative' in window` check revealed Browz. Both are gone; injection
  is tracked natively per page.
- **The clock now agrees with the announced timezone.** `Intl` reported the persona
  zone (UTC) while `Date.prototype.toString`, `toTimeString` and `toLocale*` still
  printed the phone's real local time — a two-line fingerprint. All renderings,
  including `new Intl.DateTimeFormat()` without an explicit zone, now use the persona
  clock. Covered by a device test that runs on an emulator forced to +05:30, so a
  regression cannot pass on a UTC device.
- Mixed content is never allowed; an HTTPS page cannot load HTTP subresources.
- Invalid TLS certificates are always cancelled and logged; client-certificate and
  HTTP-auth prompts are refused.
- Network security config: cleartext refused, system trust anchors only.
- WebView remote debugging disabled; external intents restricted to http/https.
- Session cookies and site storage are wiped at launch, so a crash cannot leak a
  previous session into the next run.
- Domain rules reject credentials, scripts, ports and malformed hosts.
- APK Signature Scheme v3 enabled for future key rotation.

### Verification
- New artifact gate (`test/verify-apk.sh`) inspects the signed APK itself.
- New adversarial device suite covering interception, bridge secrets, download
  policy, container and session wiping, capture flags and the injected shield.
- New UX contract suite: 48 dp touch targets, WCAG AA contrast, rotation and start
  budget.
- `THREAT-MODEL.md` documents controls, evidence and residual risk.

## 1.0.0
- First public Windows installer and Android APK. Experimental; Android APK signed
  with a key that was later found to be public.
