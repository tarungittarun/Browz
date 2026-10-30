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
assert.ok(java.includes('isBlockedLocalHost(host)'));
const interceptBody = java.slice(java.indexOf('public WebResourceResponse shouldInterceptRequest'),
  java.indexOf('public void onReceivedSslError'));
for (const branch of ['Air-Gap Radio Kill-Switch Active', 'Blocked SSRF / Loopback / Local Resource',
  'Blocked by site rule', 'Allowed by site rule', 'Tracker Blocked', 'Request forwarded to network']) {
  assert.ok(interceptBody.includes(branch), `interception branch missing: ${branch}`);
}
assert.ok(interceptBody.indexOf('Blocked SSRF') < interceptBody.indexOf('Blocked by site rule'),
  'loopback blocking must take precedence over user allow rules');
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

// Strict transport and credential handling.
assert.ok(java.includes('MIXED_CONTENT_NEVER_ALLOW'), 'HTTPS pages must not load HTTP subresources');
assert.ok(!java.includes('MIXED_CONTENT_COMPATIBILITY_MODE'));
assert.ok(java.includes('onReceivedSslError(') && java.includes('handler.cancel()'));
assert.ok(java.includes('onReceivedClientCertRequest(') && java.includes('request.cancel()'));
assert.ok(java.includes('onReceivedHttpAuthRequest('));
assert.ok(java.includes('onShowFileChooser('), 'file pickers must be guarded');
assert.ok(java.includes('setMediaPlaybackRequiresUserGesture(true)'), 'autoplay with sound must require a gesture');
assert.ok(java.includes('setSafeBrowsingEnabled(true)'));

// No account system: only a known allowlist of local preferences may be written.
const writtenKeys = [...java.matchAll(/put(?:String|Boolean|Int|Long)\("([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
const allowedKeys = new Set(['bookmarks', 'containers', 'netRules', 'sessionOpen', 'sessionCrashed']);
for (const key of new Set(writtenKeys)) {
  assert.ok(allowedKeys.has(key), `unexpected preference key (account/sync data?): ${key}`);
}
assert.ok(java.includes('no Browz account'), 'the app must tell users it needs no account');
assert.ok(!java.includes('login('), 'there must be no sign-in call');
assert.ok(!java.includes('Bearer '), 'no API tokens may be stored or sent');
assert.ok(java.includes('WebView.setWebContentsDebuggingEnabled(false)'));
const manifestStrict = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
assert.ok(manifestStrict.includes('android:allowBackup="false"'));
assert.ok(manifestStrict.includes('android:usesCleartextTraffic="false"'));
assert.ok(manifestStrict.includes('android:networkSecurityConfig="@xml/network_security_config"'));
const nsc = fs.readFileSync('android/app/src/main/res/xml/network_security_config.xml', 'utf8');
assert.ok(nsc.includes('cleartextTrafficPermitted="false"'));
assert.ok(!nsc.includes('certificates src="user"'), 'user-installed CAs must not be trusted');
// External intents must not be able to supply a non-web scheme.
assert.ok(java.includes('"http".equals(scheme) || "https".equals(scheme)'));
// Honest naming for the in-app checks.
assert.ok(java.includes('not a security audit or a guarantee'));

// Session data must be wiped before the first page can read it.
const onCreateBody = java.slice(java.indexOf('protected void onCreate'), java.indexOf('private TextView makeBottomBtn'));
assert.ok(onCreateBody.includes('removeAllCookies'), 'launch must wipe cookies left by a crash');
assert.ok(onCreateBody.indexOf('removeAllCookies') < onCreateBody.indexOf('createAndSwitchTab'),
  'the wipe must happen before the first page opens');
assert.ok(java.includes('"sessionOpen"'));

// Release tooling must never publish a preview-signed APK.
const releaseWorkflow = fs.readFileSync('.github/workflows/release-android.yml', 'utf8');
assert.ok(releaseWorkflow.includes('Refuse to release without an owner-held key'));
assert.ok(!/env:[\s\S]{0,120}BROWZ_ALLOW_EXPOSED_KEY/.test(releaseWorkflow),
  'release must not enable the exposed-key allowance');
assert.ok(releaseWorkflow.includes('--draft'), 'releases must start as drafts');
const verifyTool = fs.readFileSync('tools/verify-download.sh', 'utf8');
assert.ok(verifyTool.includes('94af295478718c92fa1636a722c2b0fd68f4d64a8a0f849c96d0d28ec9f43f26'));
assert.ok(verifyTool.includes('apksigner verify'));
assert.ok(!java.includes('18-Point Mobile Security Audit'));
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
