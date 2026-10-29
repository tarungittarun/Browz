# Browz: device, OS and system-app privacy

This is a practical guide, not a security audit. The previous version overstated isolation, anonymity and data-erasure guarantees. Browz cannot guarantee that data is unreadable or that your system cannot be compromised.

- **Android:** App-private storage is normally protected from other ordinary apps by the Android sandbox. A rooted or compromised OS, device administrator, debugging access, vulnerabilities and privileged apps can change that picture. Bookmarks are stored in app-private preferences without application-level encryption. WebView cookies and storage are shared among tabs; low-cache tabs are not isolated private profiles. Backup is disabled in the manifest, but device/vendor behavior and other copies may differ. Clearing and exit cleanup are best effort, not secure erasure.
- **Desktop:** Local apps running as the same user, administrators, malware, browser extensions, endpoint tools and backups may access data depending on configuration. Loopback networking alone does not authenticate local processes. Do not assume RAM-only operation or zero disk traces without a verified configuration and runtime test.
- **Screens and input:** Android `FLAG_SECURE` and desktop content protection can reduce ordinary screenshots, but have platform and application limitations; cameras, privileged tools and accessibility services may still expose content. Keyboards receive what you type. The request not to learn text is advisory, not a guarantee.
- **Network and websites:** HTTPS normally protects content in transit, not your destination IP or necessarily your hostname. Sites can observe your IP and fingerprint you; network operators can observe traffic metadata. Browz is not Tor or a VPN. Neither injected scripts nor simulated network settings guarantee prevention of tracking or network access.

## User awareness checkpoints

1. **Checkpoint 1: Trusted Root Certificates** — inspect installed user and enterprise certificates and device management profiles; a trusted interception CA can expose HTTPS traffic.
2. **Checkpoint 2: Device integrity** — keep the OS and Android System WebView updated; review administrator, debugging, root and management access.
3. **Checkpoint 3: Accessibility** — review installed accessibility services and revoke access from untrusted apps.
4. **Checkpoint 4: Keyboard and clipboard** — use a trusted input method; avoid copying credentials or sensitive URLs to a shared clipboard.
5. **Checkpoint 5: Backups and storage** — inspect desktop sync folders, device backups and exports. Bookmarks and request logs can contain sensitive addresses. Clearing site data does not clear bookmarks.
6. **Checkpoint 6: Network path** — know whether a trustworthy VPN or Tor is actually in use; Browz alone does not hide your IP. Test with an independently controlled destination and network capture if this matters.
7. **Checkpoint 7: Live Verification** — on each target device, test actual permissions, screen capture, network traffic, persistence and cross-tab cookies. A checklist or green source-code test is not proof.

Android key compromise and test limitations are documented in [mobile parity notes](MOBILE-PARITY-AND-TESTING.md) and [testing status](INDEPENDENT-AUDIT-REPORT.md).
