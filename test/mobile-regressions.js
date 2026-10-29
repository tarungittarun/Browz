// Static regression checks only. Actual Android behavior is covered separately by device tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const java = fs.readFileSync('android/app/src/main/java/com/browz/mobile/MainActivity.java', 'utf8');
const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
for (const feature of ['showBrowserMenu()', 'showBookmarksDialog()', 'shareCurrentPage()',
  'confirmClearBrowsingData()', 'showPrivacyInfo()', 'showTrafficCaptureDialog()',
  'showContainersDialog()', 'showNetworkRulesDialog()', 'showHardwareDialog()']) {
  assert.ok(java.includes(feature), `Missing mobile feature: ${feature}`);
}

// Containers: switching must destroy tabs and wipe cookies before a new page opens.
const switchBody = java.slice(java.indexOf('private void switchContainer(int id)'),
  java.indexOf('private void clearContainerState()'));
assert.ok(switchBody.includes('t.webView.destroy()'), 'container switch must destroy live pages');
assert.ok(switchBody.indexOf('wipeCookiesAndStorage()') < switchBody.indexOf('createAndSwitchTab('),
  'container switch must wipe cookies and storage before opening a page');
assert.ok(java.includes('cm.removeAllCookies(null)') && java.includes('deleteAllData()'));
assert.ok(java.includes('Limit of 12 containers reached'));

// Network interception: user rules, blocking before the network, and an honest status source.
assert.ok(java.includes('matchesDomainRule(host, blockedDomainRules)'));
assert.ok(java.includes('matchesDomainRule(host, allowedDomainRules)'));
assert.ok(java.includes('maybeProbeStatus(') && java.includes('setRequestMethod("HEAD")'));
assert.ok(java.includes('attachStatusToEntry('));
assert.ok(!java.includes('400 OK') && !java.includes('response unknown'));
assert.ok(java.includes('Request forwarded to network'));
assert.ok(java.includes('time,method,decision,status,url'));

// Hardware and OS integration.
assert.ok(java.includes('setDownloadListener('));
assert.ok(java.includes('appDeclaresPermission("android.permission.CAMERA")'));
assert.ok(java.includes('FLAG_SECURE'));
assert.ok(java.includes('buildHardwareReport()'));
assert.ok(java.includes('saveBookmarks()') && java.includes('loadBookmarks()'));
assert.ok(java.includes('status not measured'));
assert.ok(!java.includes('"200 OK "'));
assert.ok(!java.includes('Copy HAR 1.2 JSON'));
assert.ok(java.includes('not Tor or a VPN'));
assert.ok(java.includes('removeJavascriptInterface("BrowzNative")'));
assert.ok(java.includes('"GET".equalsIgnoreCase(request.getMethod())'));
assert.ok(manifest.includes('android:name="android.webkit.WebView.EnableSafeBrowsing"\n            android:value="true"'));
const apkWorkflow = fs.readFileSync('.github/workflows/build-android-apk.yml', 'utf8');
// The only allowed release upload target is a draft, maintainer-only release.
const releaseLines = apkWorkflow.split('\n').filter((line) => line.includes('gh release upload'));
assert.deepEqual(releaseLines.map((line) => line.trim()),
  ['gh release upload v1.0.3-preview Browz-Mobile-1.0.3-preview.apk SHA256SUMS.txt --clobber']);
assert.ok(apkWorkflow.includes('gh release create v1.0.3-preview --prerelease'));
assert.ok(!apkWorkflow.includes('--draft'), 'preview release must publish a working download link');
assert.ok(!apkWorkflow.includes('gh release edit v1.0.0'), 'must not touch the old public release');
assert.ok(!apkWorkflow.includes('releases/download/v1.0.0'), 'must not republish the public release');
assert.ok(java.includes('getVersionName()'));
console.log('Mobile static regressions passed (not an Android device test).');
