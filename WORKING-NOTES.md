# Browz — working notes

**Last updated:** 30 October 2026 · **Branch:** `arena/906ee2db-browz` · **Latest commit:** `git log -1 --oneline`

These are working notes, not marketing. Unticked boxes are things that are genuinely
not done. Everything ticked was run or observed, not assumed. If a claim here cannot
be reproduced from the repository, treat it as wrong and tell me.

---

## 0. Right now

- [x] Mobile builds, is installed on a device gate, and downloads work
- [x] Desktop builds with a supported Electron (45.1.0), installers produced
- [x] `npm audit` clean, lockfile committed, dependency policy enforced in CI
- [x] Shield hides fonts, touch, pixel ratio, plugins, network info, permissions
- [x] Clock and timezone agree everywhere (was a real leak)
- [ ] **Signing key is still the exposed historical one** — blocked on you
- [ ] Windows installer is still unsigned — blocked on you
- [ ] `targetSdk` still 34 (Play Store requires 35+ for updates)
- [ ] Two settings screens still duplicate five switches

### Download

| Item | Value |
| --- | --- |
| APK | https://github.com/tarungittarun/Browz/releases/download/v1.0.3-preview/Browz-Mobile-1.0.3-preview.apk |
| Size | 68,105 bytes |
| SHA-256 | `40f4c0a4d45b0d72174ab88d4c369a92d0646cf779515f4486392b50daa79e79` |
| Guide | `Browz-User-Guide.pdf`, 18 pages, 303,451 bytes, SHA-256 `0de592b8…` |
| Signing key | Historical key is **public** — preview only, not a trusted release |

---

## 1. Every customisation, with its default

Two settings screens exist on mobile. They write to the **same** underlying settings,
so they cannot contradict each other — but five protections appear on both, which is
confusing. See unfinished item **U1**.

### 1.1 Mobile → Menu → Privacy controls (21 switches)

Labels are copied verbatim from the app, so you can match them on screen. Defaults are
read from the code, not remembered.

| # | Switch (exact label) | Default | What it does | What it breaks |
| --- | --- | --- | --- | --- |
| 1 | Canvas 2D Noise (toDataURL & getImageData) | On | Perturbs canvas pixels | Some image editors |
| 2 | Hide Installed Fonts (document.fonts & measureText) | On | Fixed font allowlist; unknown fonts measure as fallback | Custom typography |
| 3 | WebGL Mobile GPU Spoofing | On | Rewrites GPU vendor/renderer | Sites that must know the GPU |
| 4 | AudioContext & AnalyserNode Noise | On | Slight noise in audio buffers | Audio fingerprinting tools |
| 5 | ClientRects Font-Measurement Jitter | On | Sub-pixel jitter on `getBoundingClientRect` | Precise layout from scripts |
| 6 | Attempt to block WebRTC in pages | On | `RTCPeerConnection` fails | Video calls, some players |
| 7 | Spoof High-Entropy Client Hints (userAgentData) | On | Fake `userAgentData`, Chromium personas only | Sites doing UA sniffing |
| 8 | Block Gyroscope, Accelerometer, Battery & USB | On | Removes those APIs | Motion games, device tools |
| 9 | Mask Storage Quota (10GB) & Speech Voices | On | Fake quota, empty voice list | Offline apps, dictation |
| 10 | Spoof Timezone (UTC) & Locale | On | Every date render uses the persona zone | Calendar apps expecting local time |
| 11 | Attempt to block ServiceWorkers in pages | On | Registration fails | Offline / PWA apps |
| 12 | Attempt to block CacheStorage in pages | On | Cache API unavailable | Same |
| 13 | Block Local File Picker & OPFS Disk I/O | On | File pickers blocked | Upload forms |
| 14 | Block Silent Clipboard Read Snooping | On | `readText` blocked | "Paste your code" flows |
| 15 | Attempt to block WebSockets in pages | **Off** | Stops `ws://` and `wss://` | **Leave off** unless needed: chat, live data |
| 16 | Reduce timer precision in pages | On | Coarsens `performance.now()` | Benchmarks, animations |
| 17 | Block 20+ Ad, Pixel & Mobile SDK Trackers | On | Domain rules + no third-party cookies | Some embedded widgets |
| 18 | Strip 35+ URL Tracking Params (utm_*, fbclid) | On | Removes tracking query parameters | Affiliate links |
| 19 | Auto-Retry Transient Network Errors (2x) | On | Retries failed loads | Doubles requests on flaky sites |
| 20 | Force HTTPS-Only Connections | On | Upgrades or refuses plain HTTP | Old intranet sites |
| 21 | Block OS Screenshots (FLAG_SECURE) | On | Blocks screenshots and recents thumbnail | You cannot screenshot pages |

### 1.2 Mobile → Menu → Hardware & permissions (7 switches)

Five of these appear on both screens and write to the same setting, so they cannot
disagree — see unfinished item **U1** for why that is still confusing.

| Switch (exact label) | Default | Also on Privacy controls? |
| --- | --- | --- |
| Block ad, pixel and SDK trackers | On | Yes (#17) |
| Measure real response status (extra HEAD request) | On | No — extra request per page |
| Block screenshots and Recent-apps preview (FLAG_SECURE) | On | Yes (#21) |
| Block file downloads | On | No |
| Block sensor, USB and Bluetooth JavaScript APIs | On | Yes (#8) |
| Block clipboard reads from pages | On | Yes (#14) |
| Block local file picker and OPFS disk access | On | Yes (#13) |

### 1.3 Mobile → personas (Menu → Stealth / persona)

| Persona | UA claims | Platform | Cores | Touch | DPR | Plugins |
| --- | --- | --- | --- | --- | --- | --- |
| Pixel 9, Android 15 | Chrome 131 mobile | Linux armv81 | 8 | 5 | 3 | 0 |
| iPhone 16 Pro, iOS 18.1 | Safari 18.1 | iPhone | 8 | 5 | 3 | 0 |
| Windows 11 desktop | Chrome 131 desktop | Win32 | 16 | 0 | 1 | 5 |
| Firefox-style mobile (not Tor) | Firefox 128 | Linux aarch64 | 8 | 5 | 3 | 0 |

Identity facts (vendor, `appVersion`, `productSub`, client hints) derive from the UA,
so a persona cannot contradict itself — enforced by a device test.

### 1.4 Mobile → other

| Feature | Limit / behaviour |
| --- | --- |
| Tabs | Up to 20; switching keeps them alive |
| Containers | Up to 12; separate cookie jars; switching wipes the old jar |
| Network rules | Block or allow by domain; allow beats the built-in tracker list |
| Bookmarks | Persistent; `browz://` internal pages denied as bookmarks |
| Downloads | Go to system Downloads; policy toggle above |
| Request log | Partial by design (WebView does not report every request); CSV export |
| Clear data | Wipes cookies, storage, cache for the container |

### 1.5 Desktop (Electron) — what is configurable

| Area | Detail |
| --- | --- |
| Stealth | `/api/stealth`, `/api/stealth/rotate` — rotate the profile |
| Interception | `/api/control/network`, `/api/control/block-rule`, `/api/control/header-rule` |
| Capture | `/api/entries`, `/api/entries/clear`, `/api/export/*` |
| Replay | `/api/replay` |
| Containers | `/api/containers` |
| Permissions | `/api/permissions`, `/api/permissions/check`, `/api/permissions/update` |
| Downloads | `/api/downloads`, `/api/downloads/config`, `/api/downloads/trigger` |
| Proxy | `/api/proxy` |
| Self-audit | `/api/security-audit` |
| Windows | `browz:toggleAlwaysOnTop`, `browz:captureScreenshot`, `browz:getLocalPort` |

Renderer hardening on desktop: `contextIsolation: true`, `nodeIntegration: false`,
`nodeIntegrationInWorker: false`, `sandbox: true`, `webSecurity: true`,
`allowRunningInsecureContent: false`.

---

## 2. Everything built, in order

### Mobile

- [x] Multi-tab browser (up to 20), toolbar, back/forward/reload/home
- [x] Containers — separate logins, up to 12, wiped on switch
- [x] Network rules — block/allow per domain, user rules beat built-in list
- [x] Request log with optional real status (HEAD probe) and CSV export
- [x] Bookmarks, share, find-in-page, zoom, video fit
- [x] Privacy controls (21 switches) and Hardware & permissions (7 switches)
- [x] Stealth personas ×4 with self-consistent identity
- [x] `browz://` internal pages: home, security self-check, settings
- [x] Clear-data, downloads policy, screenshot protection

### Mobile hardening, in the order it landed

- [x] SSRF guard: dotted/decimal/hex/IPv6/`*.localhost`/169.254/100.100.100.200
- [x] Loopback blocked before user rules; user block/allow restored ahead of trackers
- [x] 20-tab cap and cache trim under memory pressure
- [x] File picker blocked, media requires a gesture, Safe Browsing on
- [x] No account, no sync, no telemetry — proven by a preference-key allowlist
- [x] Shield markers removed (`__BROWZ_MOBILE_SHIELD_ACTIVE__`, `BrowzNative`)
- [x] Clock/timezone agree (`toString`, `toTimeString`, `toLocale*`, `Intl`)
- [x] Persona consistency: vendor, appVersion, productSub, client hints
- [x] Touch points, pixel ratio, plugin/mime list per persona
- [x] Network Information API, CSS pointer/hover, screen orientation masked
- [x] Permission states normalised, window outer size matched
- [x] Font enumeration closed (`document.fonts.check`, canvas `measureText`)

### Desktop

- [x] Electron shell with sandboxed webviews and context isolation
- [x] Request capture, header rewrite, block rules, replay, HAR/CSV export
- [x] Containers, proxy support, downloads manager, permissions panel
- [x] Stealth profile rotation and in-app self-audit

### Tooling and docs

- [x] Artifact gate (`test/verify-apk.sh`) — inspects the signed APK, not the source
- [x] Device gate — four instrumentation suites on an Android 34 emulator
- [x] 38-job audit matrix, release workflow, verification script for downloads
- [x] Dependency policy test; lockfile; current Actions majors
- [x] `docs/THREAT-MODEL.md`, `docs/DEPENDENCIES.md`, `docs/SIGNING.md`
- [x] `Browz-User-Guide.pdf` — 18 pages, plain language, site-visibility table

---

## 3. Bugs this project actually found (and how)

| Bug | Found by | Fix |
| --- | --- | --- |
| Shield announced itself in `window` | Reading the injection code | Marker removed; idempotence tracked in Java |
| `Intl` said UTC but `toString` printed the phone's zone | Writing a two-line probe | All date renders use the persona zone |
| `toLocaleTimeString` put options in the *locales* slot | The +05:30 device test | Argument shapes handled |
| iPhone persona kept `vendor: "Google Inc."` | Persona consistency test | Derived from UA |
| Chrome UAs contain `Safari/` — my vendor logic picked Apple | Writing the test | Test Chrome before Safari |
| `ua.substring("Mozilla/".length)` — JS habit in Java | CI javac | `length()` + policy guard |
| electron-builder 26 removed `${target}` | Windows build | Per-target artifact names |
| 14 npm advisories, 2 critical | `npm audit` on the old pins | Electron 45, builder 26, lockfile |
| `navigator.connection` left real (live radio type) | Reviewing the shield | Masked, with prototype fallback |

---

## 4. What each gate actually proves

| Gate | Proves | Does **not** prove |
| --- | --- | --- |
| `npm test` (36) | Source-level invariants, interception branch order, no stored credentials | Runtime behaviour |
| Artifact gate | The signed APK: permissions, debuggable, backup, cleartext, certs, no test classes | That the app behaves |
| Device gate (4 suites) | Real WebView behaviour: interception, cookies, crash wipe, shield, fonts, clock | Other Android versions, OEM builds, real phones |
| 38-job audit | Breadth: static + APK + combined suites | Independence — it is still this repo's own code |

**The honest line:** no external audit, no ARM or API 26–30 device, no real-phone run,
no pentest. WebView CVEs are Google's, not fixable here.

---

## 5. Unfinished — pick one

Ordered by value per hour of work.

### U1. Consolidate the two settings screens — *small, unblocks clarity*
21 switches and 7 switches overlap on five protections (trackers, screenshots,
clipboard, file picker, sensors). They share the same fields, so nothing contradicts
today, but a user can change a switch on one screen and not see it on the other.
**Fix:** one screen, grouped into "Identity", "Network", "Sensors & storage", each row
showing what breaks. **Risk:** low. **Effort:** half a day.

### U2. Windows installer signing — *small, but needs a certificate*
The `.exe` is unsigned, so SmartScreen warns and the hash is the only integrity signal.
**Fix:** an OV/EV code-signing certificate, then `signAndEditExecutable: true` plus
Azure Trusted Signing or `signtool`. **Blocked on:** you buying a certificate.
**Effort:** 2 hours once the cert exists.

### U3. `targetSdk` 34 → 36 — *medium, required for Play updates*
Play requires 35+ for updates. Raising it forces edge-to-edge and changes inset
behaviour, which will break the toolbar layout unless handled.
**Fix:** bump, handle `WindowInsets`, re-run the UX suite, screenshot both orientations.
**Risk:** medium — this is the classic "looks fine, toolbar under the notch" bug.

### U4. Owner signing key — *small, unblocks everything trusted*
Rotation cannot be signed with the old key (Android v3 lineage requires it to be
public-key-signed). The only safe path is a new key plus a one-time reinstall.
**Fix:** four repository secrets per `docs/SIGNING.md`, then `release-android.yml`
produces a separately signed APK and prints its fingerprint. **Blocked on:** you.
**Effort:** 20 minutes.

### U5. ARM / API-level device matrix — *medium, real coverage*
Only an API 34 x86_64 emulator has run the suite. ARM devices, API 26–30 WebViews and
low-memory phones are untested.
**Fix:** add matrix legs for API 30 arm64 and API 26 x86, accept slower runs.
**Value:** high — this is where real-world breakage lives.

### U6. Desktop artifact gate — *medium*
Android has `verify-apk.sh`; the `.exe` has nothing. **Fix:** a script that checks the
NSIS payload signature, `asar` integrity, absence of `nodeIntegration`, and produces
`SHA256SUMS`. **Value:** high, because the desktop app has no device gate at all.

### U7. Font layout sidecar — *small, closes the last font hole*
`measureText` and `document.fonts.check` are closed, but a site can still measure a
`<span>` via `offsetWidth`, which uses real layout and cannot be spoofed from JS.
**Fix:** inject a CSS `@font-face` override mapping unknown families to a generic,
so layout itself falls back. **Risk:** medium — can break real typography.

### U8. Tracker false-positive measurement — *medium*
The built-in list blocks 20+ domains but nobody has measured how often it blocks
something legitimate. **Fix:** run a seed list of popular sites, record blocks, review.
**Value:** high for trust; currently an unquantified promise.

### U9. Accessibility pass — *small*
48 dp targets and contrast are asserted, but TalkBack has never been run.
**Fix:** one TalkBack session on the toolbar, menu, tabs and privacy dialog.

### U10. Mobile feature gaps vs desktop
No request rewrite, no replay, no HAR export, no downloads manager, no history or tab
restore, no bookmark import/export, no per-site permissions.
**Pick one** rather than all: bookmark import/export is the cheapest real win.

---

## 6. Blocked on you (owner actions)

- [ ] Four signing secrets — README of `docs/SIGNING.md`
- [ ] Make the repository private (I get 403; it is owner-only in Settings)
- [ ] Delete branch `device-test-report` if it still exists (CI recreates it on failure)
- [ ] Decide whether the public APK keeps the "1.0.0" filename while reporting 1.0.3

---

## 7. Questions asked, short answers

| Question | Answer |
| --- | --- |
| Is my IP hidden? | No. No VPN or Tor inside Browz. |
| Does changing the device profile change my IP? | No. Networks assign IPs, not browsers. |
| Is everything else faked? | No — replaced, blocked, or left real. Fonts were the last real leak and are now closed; colour-scheme preference and WebGL limits are still real. |
| Does an iPhone profile mean only my IP is real? | No. It also still exposed vendor and client hints until this round; fixed. |
| How accurate is region from IP? | Country ~99%, state ~80–90%, city ~50–70%, never a street. |
| What does my ISP see? | Every domain (DNS + TLS SNI), timing, volume. Not page content over HTTPS. |
| What do I type in Private DNS? | `dns.adguard-dns.com` (blocks ads/trackers) or `dns.quad9.net` (malware). Hostname only. |
| Would an old phone be untraceable? | No — old phones were easier to trace: unencrypted calls/SMS, no HTTPS, KYC SIMs. |
| Does downgrading help? | No. It makes you rare, which is what trackers look for, and it is unpatched. |
| Are the dependencies current? | Now yes for Electron 45; `targetSdk` and the unsigned installer are not. |

---

## 8. Glossary for non-engineers

- **IP address** — the return address on your traffic, set by the network you use.
- **Fingerprint** — the combination of small details a page reads to recognise you
  even without cookies.
- **Persona/profile** — the identity Browz pretends to be.
- **Container** — a separate cookie jar, so two logins cannot see each other.
- **Shield** — the injected script that spoofs or blocks those details.
- **WebView** — Android's built-in browser engine; Browz renders pages with it.
- **DoT / Private DNS** — DNS queries wrapped in encryption so your ISP cannot read them.
- **SNI** — the hostname sent in the clear during the HTTPS handshake; hides nothing.
- **Keystore / signing key** — the private key that proves an update really came from us.
- **APK / NSIS** — the Android installer / the Windows installer.
