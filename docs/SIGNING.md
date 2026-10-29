# Android signing: current state and how to fix it

## Why the published APK must not be trusted

`android/app/browz-release.p12` and its password were committed to this public
repository. Anyone can sign an APK that Android will accept as an update to the
installed app, because the certificate is identical. The APK is therefore only
a **preview build**, not a trusted security update.

Deleting the file now does not undo the exposure: the certificate fingerprint is
`94:AF:29:54:78:71:8C:92:FA:16:36:A7:22:C2:B0:FD:68:F4:D6:4A:8A:0F:84:9C:96:D0:D2:8E:C9:F4:3F:26`
(also in git history). It must never be used for a release you ask users to
trust.

## Recommended: sign with a key only you hold

1. On your own computer, create a new key (never commit it):

   ```sh
   keytool -genkeypair -v -keystore browz-owner.p12 -storetype PKCS12 \
     -alias browz-owner -keyalg RSA -keysize 4096 -validity 10000
   ```

2. Base64-encode and back up the file somewhere safe and offline:

   ```sh
   base64 -w0 browz-owner.p12 > browz-owner.p12.b64
   ```

3. In GitHub: **Settings → Secrets and variables → Actions → New repository secret**

   | Name | Value |
   | --- | --- |
   | `BROWZ_ANDROID_KEYSTORE_BASE64` | contents of `browz-owner.p12.b64` |
   | `BROWZ_ANDROID_KEYSTORE_PASSWORD` | keystore password |
   | `BROWZ_ANDROID_KEY_ALIAS` | `browz-owner` |
   | `BROWZ_ANDROID_KEY_PASSWORD` | key password |

   Use a password manager for the passwords. Losing the key means you cannot
   ship updates that install over previous builds.

4. Push to any branch. The **Build Android Mobile APK** workflow then produces
   `Browz-Mobile-1.0.3-signed-APK`, signed with your key, and prints its
   certificate and SHA-256 checksum. It refuses to run if the result still
   carries the historical exposed certificate.

## Install expectations

- The app ID stays `com.browz.mobile`.
- An APK signed by a *different* key cannot install over the historical build.
  Uninstall the old app first; its bookmarks and app data are removed with it.
- Keep using the same key for every later release so future updates install
  normally.
- Android's Play Integrity / signing-lineage rotation is not configured here, so
  moving from the historical key to a new key is a manual uninstall/reinstall,
  not a seamless upgrade.

## Build locally

```sh
gradle assembleRelease -p android
# output: android/app/build/outputs/apk/release/app-release.apk
```

The repository's temporary preview build is signed by Gradle with the exposed
key so that maintainers can still test upgrade behaviour. Do not distribute it.
