// Static regression checks only. Actual Android behavior is covered separately by device tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const java = fs.readFileSync('android/app/src/main/java/com/browz/mobile/MainActivity.java', 'utf8');
const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
for (const feature of ['showBrowserMenu()', 'showBookmarksDialog()', 'shareCurrentPage()',
  'confirmClearBrowsingData()', 'showPrivacyInfo()', 'showTrafficCaptureDialog()']) {
  assert.ok(java.includes(feature), `Missing mobile feature: ${feature}`);
}
assert.ok(java.includes('saveBookmarks()') && java.includes('loadBookmarks()'));
assert.ok(java.includes('response unknown'));
assert.ok(!java.includes('"200 OK "'));
assert.ok(!java.includes('Copy HAR 1.2 JSON'));
assert.ok(java.includes('not Tor or a VPN'));
assert.ok(java.includes('removeJavascriptInterface("BrowzNative")'));
assert.ok(java.includes('"GET".equalsIgnoreCase(request.getMethod())'));
assert.ok(manifest.includes('android:name="android.webkit.WebView.EnableSafeBrowsing"\n            android:value="true"'));
assert.ok(!fs.readFileSync('.github/workflows/build-android-apk.yml', 'utf8').includes('gh release upload'));
console.log('Mobile static regressions passed (not an Android device test).');
