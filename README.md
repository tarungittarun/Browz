# Browz

Browz is an experimental standalone Electron desktop browser and Android WebView browser, with tabs, browser controls, privacy settings and network-observation tools. Desktop and Android have different capabilities; neither has been independently security audited.

> **Security and release warning:** The Android release signing key and password were committed to the repository and must be considered compromised. Previously published APKs signed with that key cannot be trusted as a secure update path. A matching package ID does not guarantee compatibility with an installation signed by another key. See [mobile notes](MOBILE-PARITY-AND-TESTING.md) before installing or distributing builds.

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
