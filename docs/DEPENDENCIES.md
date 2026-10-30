# Dependency audit

Audited 30 October 2026. The rule is simple: a version is only "current" if it is
inside the vendor's supported line, and only "secure" if `npm audit` is clean.

## Before this audit

The desktop pins were two years behind and had live advisories. Running the same
`npm audit` against the old pins (`electron@^33.2.0`, `electron-builder@^25.1.8`):

```
14 vulnerabilities (13 high, 1 critical)
CRITICAL  tar: Arbitrary File Read/Write via Hardlink Target Escape [<7.5.8]
CRITICAL  tar: Symlink Path Traversal via Drive-Relative Linkpath [<=7.5.10]
HIGH      electron: Mitigation for compromised eMudhra intermediate certificates [<42.11.16]
HIGH      electron: nodeIntegrationInWorker not correctly scoped in shared renderer processes
HIGH      electron: Context isolation bypass via Function.prototype.bind hijack [<39.8.9]
HIGH      electron: Sandboxed iframes can launch external protocol handlers [<39.8.8]
... (40+ Electron advisories collapsed into 14 vulnerable packages)
```

Two of those matter directly for this product: the eMudhra certificate mitigation is
exactly the class of bug that lets a network attacker read traffic, and the context
isolation bypass defeats the boundary the desktop app relies on.

## After

| Component | Was | Now | Why |
| --- | --- | --- | --- |
| `electron` | `^33.2.0` (EOL) | `^45.1.0` | EOL line; missing every fix below 42.11.16 |
| `electron-builder` | `^25.1.8` | `^26.18.1` | AppImage search-path flaw fixed in 26.15.0 |
| `package-lock.json` | absent | committed | without it `^` ranges float on every install |
| Android Gradle Plugin | 8.2.2 | 8.7.3 | 2023-era toolchain |
| Gradle | 8.7 | 8.11.1 | matches AGP 8.7 requirement |
| `actions/checkout` | v4 | v7 | |
| `actions/setup-node` | v4 | v7 | |
| `actions/setup-java` | v4 | v6 | v4 is deprecated |
| `actions/upload-artifact` | v4 | v7 | |
| `gradle/actions/setup-gradle` | v3 | v6 | |
| CI Node.js | 20 / 22 | 24 | Node 20 is end-of-life |

`npm audit --package-lock-only` now reports **0 vulnerabilities**.

## Android

`android/app/build.gradle` has an empty `dependencies {}` block on purpose: the app
links no third-party SDKs, so there is no ad, analytics or crash-reporting library to
audit. The only third-party code that runs is the system WebView, which Google
updates through Play. That is a genuine strength of this build and worth keeping.

## Verified, not assumed

- `f062b9a`: device gate, APK build and the 38-job audit all green with AGP 8.7.3,
  Gradle 8.11.1 and the new Action majors.
- A temporary Windows job ran `npm ci` against the new lockfile, installed
  Electron **45.1.0**, and built both installers with electron-builder **26.18.1**:
  `Browz-Setup-1.0.0.exe` 121,311,089 bytes and `Browz-Portable-1.0.0.exe`
  110,359,485 bytes.
- The upgrade exposed a real incompatibility: electron-builder 26 removed the
  `${target}` macro, so the old `artifactName` aborted the build. Per-target names
  replaced it, and `--publish never` is now explicit instead of implicit CI guessing.

## Enforced from now on

`test/dependency-policy.js` runs inside `npm test` and fails if Electron drops below
42.11.16, electron-builder below 26.15.0, AGP below 8.7.0, any Action falls below its
current major, CI runs Node below 24, or the lockfile disappears. It was checked
against the old pins to confirm it actually fails.

## Still outstanding

- `compileSdk`/`targetSdk` remain 34. Raising them to 36 changes runtime behaviour
  (edge-to-edge enforcement and inset handling) and needs its own layout verification
  on a real device, so it is not bundled into a dependency bump.
- The Windows installer is still unsigned, so Windows SmartScreen will warn.
- Signing key rotation is still owner-only; see `docs/SIGNING.md`.
