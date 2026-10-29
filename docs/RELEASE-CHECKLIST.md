# Release checklist

Run through this every time a build is meant for other people.

1. **Version** — bump `versionCode` and `versionName` in `android/app/build.gradle`
   and update `CHANGELOG.md`.
2. **Tests** — `npm test` passes.
3. **Artifact gate** — `./test/verify-apk.sh <apk>` passes **without**
   `BROWZ_ALLOW_EXPOSED_KEY`. If it warns about the historical key, stop: the build
   is a preview, not a release.
4. **Device gate** — `gradle connectedDebugAndroidTest -p android` passes on an
   emulator, and a manual pass on at least one real phone covers: tab switching,
   rotation, keyboard, download blocked/allowed, container switch, clear data.
5. **Signing** — four repository secrets exist (`docs/SIGNING.md`); the workflow
   prints a certificate fingerprint that is *not* the historical one. Record the
   fingerprint in the release notes.
6. **Checksums** — publish `SHA256SUMS.txt` with the APK and mention the fingerprint.
7. **Notes** — state what is new, what is untested, and the known limitations from
   `THREAT-MODEL.md`. Never describe the app as anonymous.
8. **Rollback** — keep the previous APK available so users can reinstall if a release
   regresses.
