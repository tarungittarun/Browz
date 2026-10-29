# Mobile parity and testing notes

Browz Mobile uses Android System WebView. It is not the Electron desktop browser and cannot reproduce every desktop feature. The mobile menu provides tabs, session bookmarks, find/text zoom, video fit, privacy settings, an observed-request log, share and a confirmed clear-data action. The address bar and navigation controls are kept prominent, with 48 dp targets for the main controls. Home/normal browsing and security controls are separate from the page.

## Important limitations

- **Not anonymous:** Browz is not Tor or a VPN. Your IP address can be visible to sites and your network operator, and fingerprinting cannot be prevented completely. Choosing a Firefox-style profile does not route through Tor.
- **No isolated private tabs:** WebView cookies and storage are shared by tabs. Low-cache tabs are not RAM-only, private, or independent accounts. Bookmarks currently last only during the activity session.
- **Traffic is partial:** WebView does not expose every request to `shouldInterceptRequest` and does not supply response status, headers, bodies, or timing there. The mobile view is a request observation log, not HAR or the desktop's full capture/replay/composer. URLs and clipboard contents may contain secrets.
- **Shields are best-effort:** page-level scripts can run before the injected script, can bypass or undo it, and service workers and WebSockets may bypass request interception. Network profile values are simulations, not physical radio controls or a firewall. Do not rely on the attempted offline mode to block network access. Android, privileged apps, keyboards, and the OS may see data. Safe Browsing is enabled, subject to the device's WebView implementation and its privacy policy.
- Browser links to external app schemes and file uploads remain restricted; this can prevent certain sites from working. Camera, microphone, and location are denied.
- Clearing site data is global to WebView and asynchronous for cookies; it can sign you out. It is not a forensic secure erase, and already loaded pages or network requests may remain active. Exit-time cleanup is best effort and does not run after every crash or force-stop.

## Signing and updates: action required before distributing

The Android signing keystore and its password were previously committed to the repository. **Treat that signing key as compromised**: anyone with access can create APKs that Android accepts as updates to versions signed by that key. Keeping the package ID alone does not protect users. The build still uses that key for compatibility/testing only; automatic publishing of the Android APK to the shared release has been disabled. Do not install a newly built APK as a trusted security update. The owner needs a securely managed replacement key and an Android signing-key rotation/migration plan; depending on the installed version and distribution path, a fresh install and data loss may be necessary. Never assume deleting a committed key makes it secret again.

## Test status

`npm test` exercises JavaScript and checks Android source text; it is **not** an Android end-to-end or security audit. An Android instrumentation smoke test and an emulator workflow were added to check actual toolbar visibility, touch-target size and opening the menu and tabs. That is only a small device test; it does not establish privacy, security, website compatibility, fullscreen, or data isolation. Run the workflow or `gradle connectedDebugAndroidTest -p android` with an emulator, then manually test on real devices and supported WebView versions: navigation, tabs, back/forward, sharing, clear-data behavior, rotation, keyboard, accessibility, fullscreen video, common sites, and network failures. Security testing needs a separate independent review, adversarial web pages, and network observation; no score should be interpreted as a guarantee.
