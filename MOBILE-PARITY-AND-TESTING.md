# Mobile parity and testing

## Where the 1.0.3 preview APK lives

The current mobile source is built by `.github/workflows/build-android-apk.yml`.
Each push uploads `Browz-Mobile-1.0.3-preview.apk` and `SHA256SUMS.txt` to the
**pre-release** `v1.0.3-preview`
(https://github.com/tarungittarun/Browz/releases/tag/v1.0.3-preview), together
with a workflow artifact. It is signed with the exposed historical key, so it is a
preview for testing, not a trusted security update. See `docs/SIGNING.md` for
the owner-key path that produces a separately signed APK. The start page title
shows the version, so the build in use can be identified on-device.

Browz Mobile uses Android System WebView. It is not the Electron desktop browser and cannot reproduce every desktop feature. The mobile menu provides tabs, bookmarks saved on the device, find/text zoom, video fit, privacy settings, containers for separate accounts, network allow/block rules, a hardware and permission report, a request log with optional real status probes, share and a confirmed clear-data action.

### No account, no sync, no telemetry

Browz has no account system: no sign-up, no login, no sync endpoint, no analytics.
The only state written to disk is a fixed allowlist - `bookmarks`, `containers`,
`netRules`, `sessionOpen` (and `sessionCrashed`) - in the app's private
preferences, and a device test fails if any other key or account-shaped file
appears. The single third-party lookup is Android WebView Safe Browsing, which may
ask Google whether an address is dangerous; it involves no account and is
controlled by the platform.

### Containers (separate website logins)

WebView has no per-container storage partition. Browz therefore implements containers by destroying every open page, wiping cookies and site storage, and then opening a fresh page when you switch. Consequences worth stating plainly:

- Two containers do not share cookies while Browz runs, and container data is not persisted to disk.
- Tabs *inside* one container still share cookies with each other.
- Switching containers ends the previous container's session, so you can be signed out of it.
- Clearing is not a forensic erase; Android and WebView internals may retain memory or cached bytes until they are reclaimed.

### Network interception rules

`shouldInterceptRequest` can block a request before it reaches the network and can exempt a domain from the built-in tracker list. It cannot rewrite, delay or replay request bodies, and it does not see every socket the WebView opens (for example some media and WebSocket traffic). The optional status probe issues a separate cookie-less HEAD request for top-level pages; it measures that HEAD response, not the page load, and servers may answer the two differently.

### Hardware, permissions and OS integration

The app declares no camera, microphone or location permission, and page permission requests are denied. Screenshot/Recent-apps protection, download blocking, sensor and clipboard blocking are toggleable. Browz cannot control the system keyboard, accessibility services, device administrators, rooted or compromised devices, other apps' screenshots once protection is off, or the network operator. Downloads, when enabled, are written to Browz's own app-specific downloads folder rather than shared storage. The address bar and navigation controls are kept prominent, with 48 dp targets for the main controls. Home/normal browsing and security controls are separate from the page.

## Important limitations

- **Not anonymous:** Browz is not Tor or a VPN. Your IP address can be visible to sites and your network operator, and fingerprinting cannot be prevented completely. Choosing a Firefox-style profile does not route through Tor.
- **Accounts are separated by container, not by tab:** switching containers wipes cookies and storage, so it also clears the session you were using. Low-cache tabs are not private or independent accounts. Bookmarks persist in app-private storage and are not encrypted; they can contain sensitive URLs. Clear browsing data does not delete them; remove individual bookmarks using the star.
- **Traffic is observed, not completed intercepted:** WebView does not expose every request to `shouldInterceptRequest` and does not supply response status, headers, bodies, or timing there. The log now names forwarded and blocked requests honestly and can add a real HEAD status for top-level pages. It is not HAR, cannot rewrite requests, and is not the desktop's capture/replay/composer. URLs and clipboard contents may contain secrets.
- **Shields are best-effort:** page-level scripts can run before the injected script, can bypass or undo it, and service workers and WebSockets may bypass request interception. Network profile values are simulations, not physical radio controls or a firewall. Do not rely on the attempted offline mode to block network access. Android, privileged apps, keyboards, and the OS may see data. Safe Browsing is enabled, subject to the device's WebView implementation and its privacy policy.
- Browser links to external app schemes and file uploads remain restricted; this can prevent certain sites from working. Camera, microphone, and location are denied.
- Clearing site data is global to WebView and asynchronous for cookies; it can sign you out. It is not a forensic secure erase, and already loaded pages or network requests may remain active. Exit-time cleanup is best effort and does not run after every crash or force-stop.

## Signing and updates: action required before distributing

The Android signing keystore and its password were previously committed to the repository. **Treat that signing key as compromised**: anyone with access can create APKs that Android accepts as updates to versions signed by that key. Keeping the package ID alone does not protect users. The build still uses that key for compatibility/testing only; automatic publishing of the Android APK to the shared release has been disabled. Do not install a newly built APK as a trusted security update. The owner needs a securely managed replacement key and an Android signing-key rotation/migration plan; depending on the installed version and distribution path, a fresh install and data loss may be necessary. Never assume deleting a committed key makes it secret again.

## Test status

On commit `00f6ece` the APK still built and the Android 34 emulator test passed, now covering the container, network-rule and hardware screens plus domain normalisation. `npm test` exercises JavaScript and checks Android source text; it is **not** an Android end-to-end or security audit. The [Android 34 emulator run 40832118663](https://github.com/tarungittarun/Browz/actions/runs/40832118663) passed at commit `fe06b41`: toolbar visibility, menu height, opening menu/tabs and bookmark removal persisting across Activity relaunch. The [APK build](https://github.com/tarungittarun/Browz/actions/runs/40832118685) also passed at that commit. These are small tests; it does not establish privacy, security, website compatibility, fullscreen, or data isolation. Run the workflow or `gradle connectedDebugAndroidTest -p android` with an emulator, then manually test on real devices and supported WebView versions: navigation, tabs, back/forward, sharing, clear-data behavior, rotation, keyboard, accessibility, fullscreen video, common sites, and network failures. Security testing needs a separate independent review, adversarial web pages, and network observation; no score should be interpreted as a guarantee.
