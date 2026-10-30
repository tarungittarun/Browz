# Browz Mobile: threat model and verification record

This document separates **what is machine-verified** from **what is assumed** and
**what can still fail**. Nothing here is a security certification.

## How this build is verified

Two independent gates run on every push (`Build Android Mobile APK` and
`Android device UI smoke test`).

### 1. Artifact gate — inspects the signed release APK, not the source

`test/verify-apk.sh` fails the build unless all of the following hold:

| Check | Why it matters |
| --- | --- |
| Package `com.browz.mobile`, `versionName` 1.0.3, `targetSdk` 34 | Wrong identity breaks updates; low targetSdk weakens platform protections |
| Not debuggable | `run-as`/adb would expose app data on a compromised host |
| Only `android.permission.INTERNET` requested | No camera, microphone, location, contacts, SMS, storage or package-enumeration rights exist to be abused |
| `allowBackup=false`, `fullBackupContent=false` | Attacker with adb backup cannot extract app data |
| `usesCleartextTraffic=false` + bundled network security config with **system-only** trust anchors | Blocks HTTP downgrade and user-installed CA interception |
| Exactly one exported component | No hidden exported activity/service/receiver as an entry point |
| Safe Browsing enabled, WebView metrics opted out | Malware/phishing warnings on; no Google metrics profile |
| `apksigner verify` passes with v1+v2+**v3** | v3 carries key-lineage metadata needed for rotation |
| Exposed historical key tolerated **only** with `BROWZ_ALLOW_EXPOSED_KEY=1` | A trusted release cannot be cut with the leaked key by accident |
| No test classes, no bundled keystore | Test hooks and secrets cannot ship |

### 2. Device gate — runs the real code on Android 34 (four suites)

`AdversarialSecurityTest` — interception, bridge secrets, download policy,
container and session wiping, capture flags, manifest at runtime, shield.
`InputSafetyTest` — URL entry fuzzing (300 random inputs plus a hostile corpus),
error-page escaping, request-log bounds, clear-data completeness.
`UxContractTest` — 48 dp touch targets, WCAG AA contrast, rotation, start budget.
`BrowserUiTest` — menu, tabs, bookmarks and the newer screens.
The artifact gate in `test/verify-apk.sh` re-checks the packaged binary independently of all four.

`AdversarialSecurityTest` executes actual app objects (it does not grep source):

- **Interception**: a real `WebViewClient` blocks `google-analytics.com`, loopback
  (`127.0.0.1`, `[::1]`, `0x7f000001`, `2130706433`, `localhost.localdomain`),
  `169.254.169.254`, `100.100.100.200` and NUL-byte URLs, while forwarding an
  ordinary page request.
- **User rules**: a blocked domain stops a subresource; an allow rule exempts a
  tracker host.
- **Client certificates**: the request is cancelled, so a hostile server cannot
  pop the OS certificate picker.
- **Bridge authorisation**: a forged `BrowzNative` call cannot rotate identity or
  read audit data, while the genuine per-process secret still works.
- **Download policy**: the default blocks a download and records why.
- **Container switch**: a cookie planted for `example.com` is gone afterwards, and
  exactly one fresh page remains.
- **Screen capture**: `FLAG_SECURE` is set on the real window.
- **Manifest at runtime**: `allowBackup=false`, only `INTERNET`, one exported component.
- **Shield**: on the live page, `navigator.webdriver` is `false`, the platform and
  screen size are the persona values, `doNotTrack` is `1`, and `RTCPeerConnection`
  throws.

`BrowserUiTest` additionally proves the menu, tabs, bookmark persistence and the
container/network/hardware screens open without crashing.

## Attack scenarios

| Threat | Control | Verified by | Can still fail |
| --- | --- | --- | --- |
| Page tries to read the native bridge | Bridge only attached to internal `browz.local` pages, bound to a per-process random secret, removed on navigation | Static suite; bridge removal on navigation | A WebView engine bug, or a page that gains script execution in the internal origin, would break this |
| Page fingerprints the device | Canvas/audio noise, spoofed platform, screen, timezone, client hints, WebRTC blocked | Device probe of `navigator`, screen, WebRTC | Fingerprinting is not solvable; fonts, timing, sensors and TLS/JA3 still correlate users |
| Hostile network downgrades HTTPS | Mixed content `NEVER_ALLOW`, cleartext disabled, invalid certs cancelled, no user CAs | Artifact gate + static suite | A compromised CA in the system store, or a platform TLS bug, is outside the app |
| Malicious app starts Browz with a crafted link | Only `http`/`https` accepted, cleaned and HTTPS-upgraded; other schemes ignored | Static suite | A browser must accept web links; a malicious link can still open a real page |
| Malicious app reads the screen | `FLAG_SECURE`; content capture and autofill disabled | Device probe of window flags | Accessibility services, root, and screenshots after the toggle is off bypass this |
| Attacker with adb | Not debuggable, backup disabled, WebView debugging disabled | Artifact gate + static suite | An unlocked bootloader, root, or a vendor backdoor defeats it |
| Compromised update | None yet: the historical key is exposed | Artifact gate warns; `tools/verify-download.sh` prints the fingerprint; `release-android.yml` refuses to publish without an owner key | **This is why the APK is a preview.** See `docs/SIGNING.md` |
| Data left behind by a crash | Cookies and site storage are wiped at launch before the first page | Device test plants a cookie, simulates an unclean exit, relaunches and asserts it is gone | Filesystem forensics, backups taken before the wipe, or a compromised OS |
| Numeric/IPv6 spellings of loopback | Address parsing covers dotted, decimal, hex, IPv6 and `*.localhost` | Device matrix of 16 blocked and 8 allowed hosts | DNS rebinding to a public IP that later resolves internally |
| Memory exhaustion from many tabs | 20-tab cap; caches trimmed under memory pressure | Device test creates 30 tabs and asserts the count stays bounded | Large single pages, heavy media |
| Server asks for stored credentials / client cert | `HttpAuthHandler.cancel()`, `ClientCertRequest.cancel()` | Static suite (auth handler), device test (client cert) | Untested on real enterprise networks |
| Tracker or beacon requests | Built-in list + user rules + third-party cookies off | Device tests | First-party tracking, CNAME cloaking and server-side tagging survive |

## What a website learns, compared with an ordinary browser

This is the honest answer to "if I sign in somewhere, what does the site know about
me?" It separates three things that are easy to confuse: what Browz hides, what is
unavoidable, and what changes the moment you log in.

| The site can learn | Ordinary Android browser | Browz mobile | Why |
| --- | --- | --- | --- |
| Your public IP address and rough region from it | Yes | **Yes — not hidden** | There is no VPN or Tor in Browz. This is the strongest identifier and it survives every other control. |
| Device model, OS version, browser brand from the User-Agent | Yes | Masked to a chosen persona | Four personas; `navigator.platform`, screen size, WebGL vendor and renderer are rewritten to match. |
| Whether automation controls the browser (`navigator.webdriver`) | Exposed | Forced `false` | Static, not a behavioural model, so it cannot detect a determined page. |
| Drawing/audio fingerprint (canvas, WebGL, audio buffers) | Yes, stable | Noised per session seed | The noise uses a constant seed per persona, so the *same* persona looks consistent; a browser restart does not change it. |
| Real clock and timezone | Yes | Reported as the persona's UTC clock in `Intl` **and** in `Date.toString()`, `toDateString()`, `toLocaleString()` | Previously only `Intl` was spoofed, so one `new Date().toString()` exposed the phone's real zone. Fixed and now covered by a device test that runs on a +05:30 emulator. |
| Whether Browz itself is in use (a marker property) | n/a | **Not detectable by a marker any more** | The old shield left `window.__BROWZ_MOBILE_SHIELD_ACTIVE__` and a `BrowzNative` property on every page. Both are gone; injection is now tracked in Java. |
| Your installed fonts | Yes | **Not hidden** | Font enumeration is still readable. This is a known gap, not a claim. |
| `navigator.plugins` / `mimeTypes` list | Yes | **Not normalised** | Untouched, so it reflects the device WebView. Gap. |
| Number of CPU cores, RAM class | Yes | Fixed at 8 / 8 for every persona | Consistent, but identical across users — a weak but real shared value. |
| Third-party cookies from ad/tracker domains | Often yes | Blocked | `setAcceptThirdPartyCookies(false)` plus the interception list. |
| Requests to known tracker domains | Sent | Blocked before they leave | Rules are domain-suffix safe; first-party analytics and CNAME cloaking still pass. |
| WebRTC ability to reveal a local or real IP | Possible | Blocked | `RTCPeerConnection` fails on purpose, which can itself break video calls. |
| Service workers, cache storage, clipboard read, form autofill | Allowed | Blocked or disabled | This makes some offline-capable apps and "paste your code" flows not work; that is the trade. |
| Storage of what you typed in forms | Saved by the browser | Not saved (`setSaveFormData(false)`) | Passwords are still handled by whatever the site's page does; Browz stores no vault. |

### After you sign in, none of the above is the main problem

Logging in hands the site a **first-party identity**: a cookie or token that says
"this is account #12345". From that moment the site does not need to fingerprint
you, because you told it who you are. It also learns your e-mail, your password
(unless the page hashes client-side, which is rare), your recovery details, and
every page you visit **on that site** while signed in. No browser can hide that;
it is the purpose of signing in.

What Browz still buys you after login, and what it does not:

- **Still hidden:** other sites you visit in other tabs do not receive that cookie;
  third-party trackers embedded in the page are blocked; the fingerprint you present
  is stable-per-persona rather than your true device; your screen content is
  protected from capture.
- **Not hidden:** the site knows it is you. It can correlate this session with
  previous ones through the account, and it sees your IP.
- **The one thing that actually isolates logins is a container**, not the shield.
  Separate containers keep separate cookie jars, so a Google login in one container
  is invisible to a site opened in another. Use a different container per identity.

### Honest limits of this section

Everything above describes code in this repository, verified by this repository's
own tests. There is no independent audit, no network-level anonymity, and no
defence against a site that has your account. Names of specific gaps (fonts,
`navigator.plugins`, fixed core count) are listed because they are real, not to be
fixed by wording.

## Known-unverified areas

0. **The tests are the project's own.** Two CI gates and five device suites raise the
   bar; they do not replace an external reviewer. Every claim below is limited by that.
1. **No independent penetration test.** Every result here is self-reported by this
   repository's CI. An external reviewer with a different threat model is required.
2. **No real-device matrix.** Only an API 34 x86_64 emulator has run the suite. OEM
   WebView builds, older WebViews, ARM devices, low-memory behaviour and foldables
   are untested.
3. **WebView engine vulnerabilities** (for example the October 2026
   `CVE-2026-102327`) are patched by Google and land through the system WebView
   update. Browz cannot ship a fix; it inherits the device's WebView version.
4. **Nothing is a network anonymiser.** No VPN, no Tor: sites see the IP address and
   the operator sees connection metadata.
5. **Not verified against hostile pages in the wild.** The tests use synthetic
   requests; a deliberately crafted page has not been run against this build.
6. **Clipboard and keyboard exposure.** The Android keyboard sees typed text; the
   clipboard is shared with every app.

## What would raise confidence further

- A third-party audit with a published scope and findings.
- Device farm runs (real ARM hardware, Android 7 through 16, several OEMs).
- A corpus of live tracker- and fingerprint-heavy sites measured against the block
  list, with false-positive/negative rates recorded.
- Fuzz testing of `normalizeDomainRule`, URL cleaning and the injected shield.
- Reproducible builds and a hardware-backed signing key with a documented rotation.

Until those exist, treat Browz Mobile as an experimental preview. Do not rely on it
as your only protection for high-risk browsing.
