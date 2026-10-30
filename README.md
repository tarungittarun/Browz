# Browz

Browz is an experimental standalone Electron desktop browser and Android WebView browser, with tabs, browser controls, privacy settings and network-observation tools. Desktop and Android have different capabilities; neither has been independently security audited.

> **Security and release warning:** The Android release signing key and password were committed to the repository and must be considered compromised. Published APKs signed with that key are previews, not a trusted update path. A matching package ID does not guarantee compatibility with an installation signed by another key. See [mobile notes](MOBILE-PARITY-AND-TESTING.md) and [signing](docs/SIGNING.md).

## Verify a download before installing

```sh
# macOS / Linux
tools/verify-download.sh Browz-Mobile-1.0.3-preview.apk SHA256SUMS.txt
```

The script checks the SHA-256 checksum, verifies the APK signature, prints the
certificate fingerprint, and warns when the file carries the exposed historical key.
A valid signature proves the file was signed with that key — it does **not** make
the build a trusted release. Windows users can run `shasum`/`Get-FileHash` and
`keytool -printcert -jarfile` with the same idea.

## Current status

- **Android 1.0.3 preview** — containers for separate accounts, network allow/block
  rules, real status measuring, a hardware and permissions screen, persistent
  bookmarks, honest request logging. Signed with the exposed key: test only.
- **Windows 1.0.0 installer** — experimental, older than the Android work.
- **Verification** — every push runs an artifact gate over the built APK and an
  adversarial device suite on Android 34. Evidence and residual risk are in
  [THREAT-MODEL.md](THREAT-MODEL.md); history is in [CHANGELOG.md](CHANGELOG.md).

## Capabilities and limitations

- **Desktop:** An Electron-based standalone browser with session containers, request inspection/export, browsing controls and permission settings. These features are not guaranteed to capture or control every request or operating-system capability. Container isolation and security need independent runtime assessment.
- **Android:** A WebView browser with tabs, persistent bookmarks, navigation, page tools, a partial request log and privacy options. WebView tabs share cookies and site storage; low-cache tabs are not isolated private sessions. The request log cannot provide full response data. See [mobile parity and testing](MOBILE-PARITY-AND-TESTING.md).
- **Privacy:** Browz is not Tor or a VPN. Sites and network providers may see identifying information, and privacy shields can be bypassed. The browser cannot guarantee that all websites work or that a system cannot be compromised. Read [device and OS privacy](SECURITY-AND-OS-ISOLATION.md).
- **Testing:** `npm test` contains useful automated checks but many are source assertions, not end-to-end security tests. See [testing and security status](INDEPENDENT-AUDIT-REPORT.md).

## Run locally

Web mode:

```bash
npm install
npm start
```

Desktop mode:

```bash
npm install
npm run desktop
```

Run automated checks with `npm test`. Android instrumentation tests require the Android SDK, emulator, JDK 17 and Gradle 8.7: `gradle connectedDebugAndroidTest -p android`.
