# Security policy

## Status of this project

Browz is an **experimental** browser. It has not been independently audited. The
Android APKs published so far are **previews signed with a key that was committed
to this public repository**, so they must not be treated as trusted security
updates. See [`docs/SIGNING.md`](docs/SIGNING.md) and
[`THREAT-MODEL.md`](THREAT-MODEL.md).

## What is verified automatically

| Gate | Scope | Command |
| --- | --- | --- |
| Artifact gate | The built release APK: identity, permissions, backup/cleartext/CA settings, exported components, signature schemes, shipped files | `./test/verify-apk.sh app-release.apk` |
| Device gate | Real Android 34 runtime: request interception, user rules, bridge authorisation, download policy, container wiping, session wipe on relaunch, screen-capture flag, injected shield, manifest at runtime | `gradle connectedDebugAndroidTest -p android` |
| Static suite | JavaScript suites plus Android source assertions | `npm test` |

These are the project's own tests. Passing them is not a security guarantee.

## Reporting a vulnerability

Do **not** open a public issue for a security problem.

1. Use GitHub's private reporting: **Security → Report a vulnerability** on this
   repository (Security Advisories).
2. If that is unavailable, contact the maintainer through their GitHub profile.
3. Include the affected version (`Menu` title or `versionName`), the platform, and
   reproduction steps or a proof of concept.

Please allow time for a fix before public disclosure. There is no bug bounty.

## Known limitations you should assume until proven otherwise

- Browz is **not** a VPN or Tor: sites see your IP address and your operator sees
  connection metadata.
- Fingerprinting resistance is partial and best-effort.
- Android WebView engine vulnerabilities are fixed by Google, not by Browz.
- Container isolation relies on wiping cookies and site storage, not on a
  hardware-backed storage partition.
- The historical signing key is compromised; no APK from this repository can be a
  trusted update until a new key is configured (see `docs/SIGNING.md`).

## Supported versions

Only the newest preview and the code on `main` receive fixes. Older APKs are not
supported.
