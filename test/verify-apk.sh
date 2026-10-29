#!/usr/bin/env bash
# Strict verification of the *built artifact*, not of source text.
# Every check fails the build. Run in an Android build-tools environment.
set -euo pipefail

APK="${1:?usage: verify-apk.sh path/to/app.apk}"
TOOLS="${ANDROID_HOME:?ANDROID_HOME not set}/build-tools"
BUILD_TOOLS_DIR="$(ls -d "$TOOLS"/* | sort -V | tail -n 1)"
AAPT="$BUILD_TOOLS_DIR/aapt"
APKSIGNER="$BUILD_TOOLS_DIR/apksigner"
fail=0
note() { printf '  %s\n' "$1"; }
bad() { printf '  FAIL: %s\n' "$1"; fail=1; }
ok() { printf '  ok: %s\n' "$1"; }

echo "Verifying $APK"
echo "== Package identity =="
BADGING="$("$AAPT" dump badging "$APK")"
grep -q "package: name='com.browz.mobile'" <<<"$BADGING" && ok "package com.browz.mobile" || bad "unexpected package name"
grep -q "versionName='1.0.3'" <<<"$BADGING" && ok "versionName 1.0.3" || bad "versionName is not 1.0.3"
grep -q "targetSdkVersion:'34'" <<<"$BADGING" && ok "targetSdk 34" || bad "targetSdk is not 34"
grep -q "application-debuggable" <<<"$BADGING" && bad "APK is debuggable" || ok "not debuggable"

echo "== Permissions =="
PERMS="$("$AAPT" dump permissions "$APK" | sed -n "s/^uses-permission: name='\(.*\)'/\1/p" | sort)"
echo "$PERMS" | sed 's/^/  granted-request: /'
EXTRA="$(echo "$PERMS" | grep -v '^android.permission.INTERNET$' || true)"
if [ -n "$EXTRA" ]; then bad "unexpected permissions requested: $EXTRA"; else ok "only INTERNET requested"; fi
if echo "$PERMS" | grep -Eq 'CAMERA|RECORD_AUDIO|ACCESS_FINE_LOCATION|ACCESS_COARSE_LOCATION|READ_CONTACTS|READ_SMS|READ_EXTERNAL_STORAGE|READ_PHONE_STATE|QUERY_ALL_PACKAGES'; then
  bad "dangerous or fingerprinting permission present"
else
  ok "no camera, microphone, location, contacts, SMS, storage or package-enumeration permission"
fi

echo "== Manifest hardening (compiled binary manifest) =="
XML="$("$AAPT" dump xmltree "$APK" AndroidManifest.xml)"
assert_attr() { if grep -q "$1" <<<"$XML"; then ok "$2"; else bad "$2"; fi; }
assert_attr 'android:allowBackup.*0x0' "allowBackup is false"
assert_attr 'android:usesCleartextTraffic.*0x0' "usesCleartextTraffic is false"
assert_attr 'android:networkSecurityConfig' "network security config is bundled"
assert_attr 'android.webkit.WebView.EnableSafeBrowsing' "Safe Browsing is enabled"
assert_attr 'android.webkit.WebView.MetricsOptOut' "WebView metrics are opted out"
if grep -q 'android:debuggable.*0x1' <<<"$XML"; then bad "debuggable=true in manifest"; else ok "debuggable is not set"; fi

EXPORTED="$(grep -c 'android:exported.*0x1' <<<"$XML" || true)"
if [ "$EXPORTED" = "1" ]; then ok "exactly one exported component (the browser activity)"; else bad "expected exactly 1 exported component, found $EXPORTED"; fi

echo "== Signature =="
CERTS="$("$APKSIGNER" verify --verbose --print-certs "$APK")"
grep -q "Verifies" <<<"$CERTS" && ok "signature verifies" || bad "signature does not verify"
for scheme in v2 v3; do
  grep -qi "Verified using $scheme scheme.*true" <<<"$CERTS" && ok "$scheme signature scheme" || bad "$scheme signature missing"
done
if grep -qi "94af295478718c92fa1636a722c2b0fd68f4d64a8a0f849c96d0d28ec9f43f26" <<<"$CERTS"; then
  bad "APK is signed with the exposed historical key: not a trusted release"
else
  ok "not signed with the exposed historical key"
fi

echo "== Contents =="
ENTRIES="$(unzip -Z1 "$APK")"
if echo "$ENTRIES" | grep -Eq '(^|/)(androidTest|test)/|org/junit|androidx/test'; then bad "test-only classes shipped"; else ok "no test-only classes shipped"; fi
if echo "$ENTRIES" | grep -q 'assets/.*\.p12'; then bad "a keystore is bundled"; else ok "no keystore bundled"; fi
if echo "$ENTRIES" | grep -Eq 'lib/.*\.so'; then note "native libraries: $(echo "$ENTRIES" | grep -c 'lib/.*\.so')"; else ok "no native libraries (smaller attack surface)"; fi

echo "== Checksum =="
sha256sum "$APK"

if [ "$fail" -ne 0 ]; then echo "ARTIFACT VERIFICATION FAILED"; exit 1; fi
echo "ARTIFACT VERIFICATION PASSED"
