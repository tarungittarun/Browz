# Browz — Device, OS & System App Isolation Architecture Guide

This document explains **what data the Device, Operating System (Android / Windows / macOS / Linux), System Services, and Other Installed Apps can or cannot read** when you use Browz, and **every surface a user must stay aware of** for maximum operational security.

---

## 1. Quick Summary: Can Other Apps or the OS Read Your Browz Data?

| Threat Actor / Layer | Can It Read Your Browsing Data? | Why / How Browz Protects You | What the User Must Watch Out For |
| :--- | :--- | :--- | :--- |
| **Other Normal Apps (Mobile & Desktop)** | **NO (Blocked)** | • **Android**: Linux UID app sandbox (`/data/data/com.browz.mobile` is `0700` private) + `allowBackup="false"` + `FLAG_SECURE`.<br>• **Desktop**: Loopback `127.0.0.1` + `Sec-Fetch-Site: cross-site` CSRF block + `setContentProtection(true)` (`WDA_EXCLUDEFROMCAPTURE`). | Do not copy sensitive tokens/URLs into the shared **OS Clipboard** if untrusted apps are running in the foreground. |
| **System Screen Capture, Recent Apps & Windows Recall** | **NO (Blocked)** | • **Android**: `WindowManager.LayoutParams.FLAG_SECURE` blacks out Recent Apps thumbnails, screenshots, and screen recorders.<br>• **Desktop**: `mainWindow.setContentProtection(true)` blocks Windows Recall, Snipping Tool, Zoom/Teams screen capture, and screenshot spyware. | If you explicitly uncheck **"Block OS Screenshots (FLAG_SECURE)"** in Mobile Shields, the OS can take screenshots again. Keep it **ON**. |
| **Mobile Keyboard Apps (Gboard / SwiftKey / Samsung Keyboard)** | **Incognito Mode Forced (Keystrokes still pass through IME)** | Browz sets `IME_FLAG_NO_PERSONALIZED_LEARNING` (`0x01000000`) and `TYPE_TEXT_FLAG_NO_SUGGESTIONS`, forcing compliant keyboards into **Incognito Mode** (zero dictionary learning). | Because the keyboard app is the software you type on, a **malicious third-party keyboard** with internet access could still log raw keystrokes. **Use an offline/trusted keyboard (e.g., FlorisBoard, HeliBoard, or AOSP Keyboard with network access revoked).** |
| **OS Autofill, Screen Scrapers & Ambient AI (Android Intelligence / Accessibility)** | **NO (Blocked for Autofill & ContentCapture)** | Browz sets `IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS` and `IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS` on Android, and `spellcheck: false` + disabled `MediaSessionService` on Desktop. | On Android, check **Settings → Accessibility**: if you granted a third-party app full **Accessibility Service** permission (`canRetrieveWindowContent`), Android allows that accessibility tool to read any screen. Revoke untrusted Accessibility apps. |
| **Cloud Backups (`adb backup`, Google Drive Backup, iCloud/OneDrive)** | **NO (Blocked)** | • **Android**: `android:allowBackup="false"`, `android:fullBackupContent="false"`, `android:dataExtractionRules="@null"`.<br>• **Desktop & Mobile**: Automatic cache/cookie wipe on exit + RAM-only **Ghost/Burner Tabs**. | On Desktop, avoid installing Browz inside a folder synced to OneDrive/Dropbox. Use **Ghost / Burner (RAM Only)** tabs for zero-disk-trace sessions. |
| **Wi-Fi Router, ISP, Cellular Carrier & Public Hotspots** | **Domains & Content Encrypted (IP Visible Unless Proxied)** | • **DNS**: Encrypted via **DNS-over-HTTPS (DoH)** (Cloudflare / Quad9 / Mullvad / AdGuard) so ISP DNS resolvers cannot see domains.<br>• **HTTPS-Only**: Encrypts URL paths, headers, cookies, and page content.<br>• **WebRTC Kill-Switch**: Blocks STUN/ICE local & ISP IP leaks. | Without a Proxy/VPN/Tor, your ISP/Wi-Fi router can still see the **destination server IP address** and **TLS SNI hostname**. To hide destination IPs from your ISP/Wi-Fi operator, enable **SOCKS5 / Tor (`socks5://127.0.0.1:9050`)** in Browz Shields or run an OS-level VPN/Tor. |
| **OS Kernel / Rooted Phone / Enterprise MDM / Antivirus TLS Root Certs** | **YES (If Device Is Rooted or Has Corporate Root CA)** | Browz runs inside user space; the OS kernel owns physical RAM and the network card. | Check for custom **Trusted Root Certificates** installed by corporate MDM or antivirus SSL inspection (details in Section 3 below). |

---

## 2. Deep Dive: How Browz Isolates Your Data From the Device & System Apps

### A. Android Mobile (`Browz-Mobile-1.0.0.apk`)
1. **Zero OS Hardware Permissions (`AndroidManifest.xml`)**:
   - Requests **only** `android.permission.INTERNET`.
   - Does **not** request GPS (`ACCESS_FINE_LOCATION`), Camera, Microphone, Contacts, Phone State (`READ_PHONE_STATE`), Bluetooth, or External Storage. Even if a website compromises a renderer feature, the Android OS kernel denies hardware access at the UID level.
2. **OS Screenshot, Recent Apps & Screen-Recorder Lockdown (`FLAG_SECURE`)**:
   - Enabled by default (`WindowManager.LayoutParams.FLAG_SECURE`).
   - Prevents Android SystemUI from saving screenshots of your tabs into `/sdcard/Pictures/Screenshots` or caching page thumbnails in the Recent Apps switcher.
3. **Android System Intelligence, ContentCapture & Autofill Block**:
   - Sets `IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS` (API 29+) and `IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS` (API 26+) on the root view, Omnibox, and every `WebView`.
   - Prevents Android System Intelligence (Pixel Ambient Services) and third-party Autofill password managers from scraping DOM text or URLs.
4. **Incognito Keyboard Enforcement (`IME_FLAG_NO_PERSONALIZED_LEARNING`)**:
   - Sets `EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING` and `InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS` on the address bar.
   - Instructs Gboard, SwiftKey, and Samsung Keyboard not to store typed URLs or search terms in user history dictionaries.
5. **Cloud & ADB Backup Prohibition**:
   - Sets `android:allowBackup="false"`, `android:fullBackupContent="false"`, and `android:dataExtractionRules="@null"`, blocking Google Drive auto-backup and USB `adb backup` extraction.
6. **Automatic Wipe on App Exit (`onDestroy`) & Ghost Tabs**:
   - Ghost Tabs use `WebSettings.LOAD_NO_CACHE`.
   - Closing the app triggers `CookieManager.removeAllCookies()`, `WebStorage.deleteAllData()`, and `webView.clearCache(true)` so zero residual session data remains in `/data/data/com.browz.mobile/`.

### B. Windows / macOS / Linux Desktop (`Browz-Standalone-Installer-1.0.0.exe`)
1. **OS Window Capture & Windows Recall Block (`setContentProtection(true)`)**:
   - Calls `mainWindow.setContentProtection(true)` on startup (maps to Windows `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`).
   - Blocks Windows Recall AI snapshots, Snipping Tool, OBS, Discord/Zoom screen share, and background screenshot malware from reading the Browz window.
2. **OS Media Overlay ("Now Playing") & OS Spellcheck Suppression**:
   - Disables Chromium `HardwareMediaKeyHandling` and `MediaSessionService` so Windows SMTC / macOS Control Center never receives the title, URL, or thumbnail of videos playing inside Browz.
   - Sets `spellcheck: false` on both the main window and all `<webview>` guests so typed text is never transmitted to OS spellcheck daemons.
3. **RAM-Only Ephemeral Partitions & Exit Cache Wipe**:
   - Ghost/Burner containers use Chromium in-memory partitions (`ram_burner` without the `persist:` prefix), meaning cookies, IndexedDB, and cache live strictly in volatile RAM and are never written to `%APPDATA%`.
   - On `before-quit`, Browz purges session caches and auth caches across all partitions.
4. **Localhost Loopback & Cross-Site Request Forgery (CSRF) Lockdown**:
   - The local capture engine binds strictly to `127.0.0.1` (never `0.0.0.0` on desktop) on a randomized ephemeral port and rejects any request carrying `Sec-Fetch-Site: cross-site`, preventing malicious websites in other browsers from querying Browz's local API.

---

## 3. Checklist: Where the User Must Look on Their Device to Stay 100% Aware

No user-space browser can override a compromised OS kernel or a user-installed root spyware service. To ensure neither your device, OS, nor network can snoop on your activity, verify these **7 checkpoints** on your phone and PC:

### Checkpoint 1: Trusted Root Certificates (MITM SSL Inspection)
- **Why it matters**: Corporate MDM profiles, parental-control apps, and some desktop antivirus suites (e.g., Kaspersky, Avast HTTPS scanning, Zscaler) install a **Custom Root Certificate Authority (CA)** into the OS trust store, allowing them to decrypt `https://` traffic.
- **Where to look**:
  - **Android**: **Settings → Security & Privacy → More Security Settings → Encryption & Credentials → Trusted Credentials → User tab**. Verify the **User** tab is completely empty (unless you intentionally installed your own proxy CA).
  - **Windows**: Run `certmgr.msc` → **Trusted Root Certification Authorities → Certificates**. Ensure no unknown corporate or third-party proxy CAs are installed.

### Checkpoint 2: Android Accessibility Services (`Settings → Accessibility`)
- **Why it matters**: On Android, any app granted **Accessibility Service** permission with `canRetrieveWindowContent` can read the UI tree of *every* app on the phone, bypassing `FLAG_SECURE`.
- **Where to look**:
  - **Android**: **Settings → Accessibility → Downloaded Apps / Installed Services**. Turn **OFF** any third-party app you do not explicitly trust with full screen-reading rights.

### Checkpoint 3: Mobile Keyboard (IME) Network Access
- **Why it matters**: While Browz forces `IME_FLAG_NO_PERSONALIZED_LEARNING` (Incognito Keyboard Mode), every keystroke you type on a touchscreen passes through your active keyboard app before reaching Browz.
- **Where to look**:
  - **Android**: Go to **Settings → System → Keyboard → On-screen keyboard**. Avoid cloud-synced keyboards with telemetry enabled, or revoke cellular/Wi-Fi background data for your keyboard app (or use an offline open-source keyboard like **HeliBoard** or **FlorisBoard**).

### Checkpoint 4: OS Clipboard Awareness (`Copy / Paste`)
- **Why it matters**: While Browz blocks websites from silently reading your clipboard (`navigator.clipboard.readText()` throws `NotAllowedError`), once you copy text *out* to the OS clipboard, other foreground desktop/mobile apps can read the OS clipboard.
- **Where to look**:
  - **Android 12+**: Keep **Settings → Privacy → Show clipboard access** turned **ON** so Android alerts you whenever another app reads your clipboard.
  - **Windows 10/11**: Go to **Settings → System → Clipboard** and keep **Clipboard History** and **Sync across your devices** turned **OFF**.

### Checkpoint 5: Network Operator / ISP / Public Wi-Fi Exposure (IP & SNI)
- **Why it matters**: Browz encrypts DNS via **DNS-over-HTTPS (DoH)**, blocks **WebRTC IP leaks**, strips **35+ URL tracking parameters**, and enforces **HTTPS-Only**. However, on a direct connection, your Wi-Fi router or ISP still sees the **destination IP address** packets are routed to.
- **Where to look**:
  - In Browz (**Shields & Settings → Stealth → Proxy / Tor Routing**), switch from `Direct` to **`SOCKS5 / Tor`** (`socks5://127.0.0.1:9050`) or route your device through a trusted VPN/Orbot when you need to hide destination server IPs and TLS SNI from your ISP or Wi-Fi operator.
  - In Browz (**Shields & Settings → I/O & Wi-Fi**), engage the **Air-Gap Radio Kill-Switch** whenever you want to guarantee zero outbound network packets while inspecting offline pages or HAR logs.

### Checkpoint 6: Swap File / Hibernation (`pagefile.sys` / `hiberfil.sys`) on Desktop
- **Why it matters**: Even when using Browz's **Ghost / Burner (RAM-Only)** tabs, Windows may page inactive RAM blocks into `C:\pagefile.sys` or `C:\hiberfil.sys` if your disk is unencrypted.
- **Where to look**:
  - **Windows**: Enable **BitLocker Full-Disk Encryption** (or VeraCrypt) so swap and hibernation files on your SSD cannot be read offline if your laptop is physically seized.

### Checkpoint 7: Live Verification Inside Browz (`browz://security`)
- **Where to look**:
  - Click **`Security Check`** in the top toolbar (or navigate to `browz://security` on Desktop or Mobile) at any time to run the live **24-Point Security, I/O, Wi-Fi & OS Isolation Audit** and verify that `FLAG_SECURE`, WebRTC Kill-Switch, ServiceWorker/CacheStorage/OPFS Disk I/O blocks, and Fingerprint Shields all show **`24 / 24 PASSED`**.
