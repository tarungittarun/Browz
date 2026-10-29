#!/usr/bin/env bash
# Verify a Browz APK that you downloaded, before you install it.
#
# Usage:
#   tools/verify-download.sh Browz-Mobile-1.0.3-preview.apk [SHA256SUMS.txt]
#
# The script is read-only: it never installs, edits or deletes the APK.
set -uo pipefail

APK="${1:?usage: verify-download.sh <apk> [SHA256SUMS.txt]}"
SUMS="${2:-}"
[ -f "$APK" ] || { echo "No such file: $APK" >&2; exit 2; }
fail=0

echo "== File =="
ls -l "$APK"
ACTUAL="$(shasum -a 256 "$APK" 2>/dev/null | cut -d' ' -f1 || sha256sum "$APK" | cut -d' ' -f1)"
echo "sha256: $ACTUAL"

if [ -n "$SUMS" ] && [ -f "$SUMS" ]; then
  EXPECTED="$(grep -F "$(basename "$APK")" "$SUMS" | awk '{print $1}')"
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ]; then
    echo "PASS: checksum matches $(basename "$SUMS")"
  else
    echo "FAIL: checksum does not match the published list" >&2
    fail=1
  fi
else
  echo "NOTE: no SHA256SUMS.txt given; compare the hash above with the release page yourself."
fi

echo
echo "== Certificate =="
CERT=""
if command -v apksigner >/dev/null 2>&1; then
  if apksigner verify --print-certs "$APK" > /tmp/browz-certs.$$ 2>/dev/null; then
    echo "PASS: signature verifies (apksigner)"
    CERT="$(grep -i 'SHA-256 digest' /tmp/browz-certs.$$ | head -1 | awk -F': ' '{print $2}')"
  else
    echo "FAIL: apksigner says the signature is invalid or the file is modified" >&2
    fail=1
  fi
elif command -v keytool >/dev/null 2>&1; then
  CERT="$(keytool -printcert -jarfile "$APK" 2>/dev/null | grep -i 'SHA256:' | head -1 | awk -F': ' '{print $2}')"
  [ -n "$CERT" ] && echo "PASS: certificate readable (keytool)" || { echo "FAIL: no certificate found" >&2; fail=1; }
else
  echo "NOTE: install Android build-tools (apksigner) or a JDK (keytool) to check the signature."
fi

if [ -n "$CERT" ]; then
  CLEAN="$(echo "$CERT" | tr -d ':' | tr 'A-F' 'a-f')"
  echo "cert sha256: $CLEAN"
  EXPOSED="94af295478718c92fa1636a722c2b0fd68f4d64a8a0f849c96d0d28ec9f43f26"
  if [ "$CLEAN" = "$EXPOSED" ]; then
    echo
    echo "WARNING: this APK is signed with Browz's historical key, which was published"
    echo "         in the repository. Anyone can sign a file that Android accepts as an"
    echo "         update to it. Install it only on a test device, and never treat it as"
    echo "         a trusted security update."
  fi
fi

rm -f /tmp/browz-certs.$$
echo
if [ "$fail" -ne 0 ]; then
  echo "RESULT: do not install this file."
  exit 1
fi
echo "RESULT: file checks passed. Signature validity does not make this a trusted release; read docs/SIGNING.md."
