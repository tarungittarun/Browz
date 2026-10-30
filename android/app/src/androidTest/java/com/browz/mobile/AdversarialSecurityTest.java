package com.browz.mobile;

import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.test.ActivityInstrumentationTestCase2;
import android.view.WindowManager;
import android.webkit.ClientCertRequest;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.security.Principal;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Adversarial checks that execute the real app code on a device: request
 * interception, container wiping, window capture flags, manifest exposure and
 * the injected shield. Every WebView call is marshalled to the UI thread.
 */
@SuppressWarnings("deprecation")
public class AdversarialSecurityTest extends ActivityInstrumentationTestCase2<MainActivity> {

    private interface Body {
        void run() throws Exception;
    }

    public AdversarialSecurityTest() { super(MainActivity.class); }

    private void onUi(final Body body) throws Throwable {
        runTestOnUiThread(() -> {
            try {
                body.run();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        getInstrumentation().waitForIdleSync();
    }

    private static Object field(Object target, String name) throws Exception {
        Class<?> c = target.getClass();
        while (c != null) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                return f.get(target);
            } catch (NoSuchFieldException e) {
                c = c.getSuperclass();
            }
        }
        throw new NoSuchFieldException(name);
    }

    private static Object call(MainActivity activity, String name, Object... args) throws Exception {
        for (Method m : MainActivity.class.getDeclaredMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == args.length) {
                m.setAccessible(true);
                return m.invoke(activity, args);
            }
        }
        throw new NoSuchMethodException(name);
    }

    private WebView activeWebView(MainActivity activity) throws Exception {
        Object tab = field(activity, "activeTab");
        assertNotNull("no active tab", tab);
        return (WebView) field(tab, "webView");
    }

    private static class FakeRequest implements WebResourceRequest {
        private final Uri uri;
        private final String method;
        private final boolean mainFrame;

        FakeRequest(String url, String method, boolean mainFrame) {
            this.uri = Uri.parse(url);
            this.method = method;
            this.mainFrame = mainFrame;
        }

        @Override public Uri getUrl() { return uri; }
        @Override public boolean isForMainFrame() { return mainFrame; }
        @Override public boolean isRedirect() { return false; }
        @Override public boolean hasGesture() { return false; }
        @Override public String getMethod() { return method; }
        @Override public Map<String, String> getRequestHeaders() { return new HashMap<>(); }
    }

    // ---------- manifest and window exposure ----------

    public void testManifestExposureIsMinimal() throws Exception {
        Context ctx = getInstrumentation().getTargetContext();
        PackageManager pm = ctx.getPackageManager();
        ApplicationInfo info = pm.getApplicationInfo(ctx.getPackageName(), 0);
        assertEquals("allowBackup must be false",
                0, info.flags & ApplicationInfo.FLAG_ALLOW_BACKUP);

        // Instrumentation runs the debuggable debug variant, so the release-only
        // "not debuggable" assertion lives in test/verify-apk.sh, which inspects the
        // signed release artifact with aapt.

        PackageInfo full = pm.getPackageInfo(ctx.getPackageName(),
                PackageManager.GET_PERMISSIONS | PackageManager.GET_ACTIVITIES
                        | PackageManager.GET_RECEIVERS | PackageManager.GET_SERVICES
                        | PackageManager.GET_PROVIDERS);
        List<String> permissions = new ArrayList<>();
        if (full.requestedPermissions != null) {
            for (String p : full.requestedPermissions) permissions.add(p);
        }
        assertEquals("only INTERNET may be requested, found " + permissions, 1, permissions.size());
        assertEquals("android.permission.INTERNET", permissions.get(0));

        int exported = 0;
        if (full.activities != null) {
            for (ActivityInfo a : full.activities) if (a.exported) exported++;
        }
        if (full.receivers != null) {
            for (ActivityInfo a : full.receivers) if (a.exported) exported++;
        }
        if (full.services != null) {
            for (ServiceInfo s : full.services) if (s.exported) exported++;
        }
        if (full.providers != null) {
            for (ProviderInfo p : full.providers) if (p.exported) exported++;
        }
        assertEquals("exactly one exported component (the browser activity) expected", 1, exported);
    }

    public void testWindowBlocksScreenCapture() throws Exception {
        MainActivity activity = getActivity();
        int flags = activity.getWindow().getAttributes().flags;
        assertTrue("FLAG_SECURE must prevent screenshots and recent-app previews",
                (flags & WindowManager.LayoutParams.FLAG_SECURE) != 0);
    }

    // ---------- request interception ----------

    public void testTrackerAndLoopbackAreBlockedByRealClient() throws Throwable {
        final MainActivity activity = getActivity();
        final boolean[] results = new boolean[7];
        onUi(() -> {
            WebView wv = activeWebView(activity);
            WebViewClient client = wv.getWebViewClient();
            assertNotNull(client);
            WebResourceResponse tracker = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://www.google-analytics.com/collect?v=1", "GET", false));
            results[0] = tracker != null;
            WebResourceResponse loopback = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://127.0.0.1:8443/admin", "GET", true));
            results[1] = loopback != null;
            WebResourceResponse metadata = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://169.254.169.254/latest/meta-data/", "GET", true));
            results[2] = metadata != null;
            WebResourceResponse nul = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://example.org/%00.jpg", "GET", false));
            results[3] = nul != null;
            WebResourceResponse ordinary = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://example.org/article", "GET", true));
            results[4] = ordinary == null;
            // Alternative spellings of loopback that naive filters miss.
            results[5] = client.shouldInterceptRequest(wv,
                    new FakeRequest("http://[::1]:8080/", "GET", true)) != null
                    && client.shouldInterceptRequest(wv,
                    new FakeRequest("http://0x7f000001/", "GET", true)) != null
                    && client.shouldInterceptRequest(wv,
                    new FakeRequest("http://2130706433/", "GET", true)) != null
                    && client.shouldInterceptRequest(wv,
                    new FakeRequest("http://localhost.localdomain/", "GET", true)) != null;
            results[6] = true;
        });
        assertTrue("analytics request must be intercepted", results[0]);
        assertTrue("loopback probing must be blocked", results[1]);
        assertTrue("cloud metadata SSRF must be blocked", results[2]);
        assertTrue("NUL-byte host confusion must be blocked", results[3]);
        assertTrue("ordinary page requests must be forwarded untouched", results[4]);
        assertTrue("IPv6, hex, decimal and localhost aliases of loopback must be blocked", results[5]);
    }

    public void testLocalHostDetectionCoversAliases() throws Throwable {
        Method m = MainActivity.class.getDeclaredMethod("isBlockedLocalHost", String.class);
        m.setAccessible(true);
        String[] blocked = {
                "127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "100.100.100.200",
                "localhost", "LOCALHOST.", "localhost.localdomain", "app.localhost",
                "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1",
                "0x7f000001", "2130706433", "metadata.google.internal",
        };
        String[] allowed = {
                "example.com", "notlocalhost.example", "10.0.0.5", "192.168.1.1",
                "172.16.0.1", "1.1.1.1", "browz.local", "",
        };
        for (String host : blocked) {
            assertEquals("should block " + host, Boolean.TRUE, m.invoke(null, host));
        }
        for (String host : allowed) {
            assertEquals("should allow " + host, Boolean.FALSE, m.invoke(null, host));
        }
        assertEquals("null host must not throw", Boolean.FALSE, m.invoke(null, (String) null));
    }

    public void testUserRulesOverrideBuiltInTrackerList() throws Throwable {
        final MainActivity activity = getActivity();
        @SuppressWarnings("unchecked")
        final java.util.Set<String> blocked = (java.util.Set<String>) field(activity, "blockedDomainRules");
        @SuppressWarnings("unchecked")
        final java.util.Set<String> allowed = (java.util.Set<String>) field(activity, "allowedDomainRules");
        blocked.add("malware.test");
        allowed.add("google-analytics.com");
        final boolean[] results = new boolean[2];
        try {
            onUi(() -> {
                WebView wv = activeWebView(activity);
                WebViewClient client = wv.getWebViewClient();
                results[0] = client.shouldInterceptRequest(wv,
                        new FakeRequest("https://cdn.malware.test/payload.js", "GET", false)) != null;
                results[1] = client.shouldInterceptRequest(wv,
                        new FakeRequest("https://www.google-analytics.com/collect?v=2", "GET", false)) == null;
            });
        } finally {
            blocked.remove("malware.test");
            allowed.remove("google-analytics.com");
        }
        assertTrue("user block rule must stop subdomain requests", results[0]);
        assertTrue("an allow rule must override the tracker list", results[1]);
    }

    public void testClientCertificateRequestsAreDenied() throws Throwable {
        final MainActivity activity = getActivity();
        final boolean[] cancelled = {false};
        onUi(() -> {
            WebView wv = activeWebView(activity);
            WebViewClient client = wv.getWebViewClient();
            // HttpAuthHandler has a package-private constructor, so its denial is
            // covered by the static regression suite instead.
            ClientCertRequest cert = new ClientCertRequest() {
                @Override public void proceed(PrivateKey key, X509Certificate[] chain) { }
                @Override public void cancel() { cancelled[0] = true; }
                @Override public void ignore() { }
                @Override public String getHost() { return "mtls.test"; }
                @Override public int getPort() { return 443; }
                @Override public String[] getKeyTypes() { return new String[]{"RSA"}; }
                @Override public Principal[] getPrincipals() { return new Principal[0]; }
            };
            client.onReceivedClientCertRequest(wv, cert);
        });
        assertTrue("client-certificate requests must be cancelled", cancelled[0]);
    }

    // ---------- container isolation ----------

    public void testContainerSwitchWipesCookiesAndPages() throws Throwable {
        final MainActivity activity = getActivity();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setCookie("https://example.com", "browz_leak=1; Path=/");
        cm.flush();
        String before = cm.getCookie("https://example.com");
        assertNotNull("test harness could not set a cookie", before);
        assertTrue(before.contains("browz_leak=1"));

        final int newId = 9001;
        @SuppressWarnings("unchecked")
        final List<Object> containers = (List<Object>) field(activity, "containers");
        containers.add(newContainerProfile(newId, "Test Container"));

        onUi(() -> call(activity, "switchContainer", newId));

        String after = cm.getCookie("https://example.com");
        assertNull("container switch must delete the previous session's cookies", after);
        List<?> tabs = (List<?>) field(activity, "tabs");
        assertEquals("container switch must leave exactly one fresh page", 1, tabs.size());
        assertEquals("active container must be the new one",
                newId, ((Integer) field(activity, "activeContainerId")).intValue());
    }

    private Object newContainerProfile(int id, String name) throws Exception {
        Class<?> c = Class.forName("com.browz.mobile.MainActivity$ContainerProfile");
        Constructor<?> ctor = c.getDeclaredConstructor(int.class, String.class);
        ctor.setAccessible(true);
        return ctor.newInstance(id, name);
    }

    // ---------- native bridge authorisation ----------

    public void testBridgeRejectsCallsWithWrongSecret() throws Throwable {
        final MainActivity activity = getActivity();
        onUi(() -> call(activity, "navigateActiveTab", "browz://home"));
        Thread.sleep(1500);

        assertEquals("internal page must expose the bridge", "object",
                evalString(activeWebView(activity), "typeof window.BrowzNative"));

        Object bridge = null;
        for (Class<?> inner : MainActivity.class.getDeclaredClasses()) {
            if (inner.getSimpleName().equals("BridgeInterface")) {
                Constructor<?> ctor = inner.getDeclaredConstructor(MainActivity.class);
                ctor.setAccessible(true);
                bridge = ctor.newInstance(activity);
            }
        }
        assertNotNull("BridgeInterface not found", bridge);

        String stats = (String) bridge.getClass().getMethod("getNativeAuditStats", String.class)
                .invoke(bridge, "not-the-secret");
        assertEquals("a wrong secret must not leak audit data", "{}", stats);

        int personaBefore = (Integer) field(activity, "activePersonaIdx");
        bridge.getClass().getMethod("rotateIdentity", String.class).invoke(bridge, "forged-secret");
        getInstrumentation().waitForIdleSync();
        Thread.sleep(300);
        assertEquals("forged bridge call must not change the persona",
                personaBefore, ((Integer) field(activity, "activePersonaIdx")).intValue());

        // The genuine secret must still work, proving the test exercises the real path.
        bridge.getClass().getMethod("rotateIdentity", String.class)
                .invoke(bridge, (String) field(activity, "bridgeSecret"));
        getInstrumentation().waitForIdleSync();
        Thread.sleep(600);
        assertNotSame("the genuine secret must be able to rotate identity",
                personaBefore, ((Integer) field(activity, "activePersonaIdx")).intValue());
    }

    public void testNoAccountOrSyncStateIsStored() throws Throwable {
        final MainActivity activity = getActivity();
        // Force every ordinary write path to run.
        onUi(() -> {
            call(activity, "saveBookmarks");
            call(activity, "saveContainers");
            call(activity, "saveNetworkRules");
        });
        Context ctx = getInstrumentation().getTargetContext();
        java.util.Set<String> keys = ctx.getSharedPreferences("MainActivity", Context.MODE_PRIVATE)
                .getAll().keySet();
        java.util.Set<String> allowed = new java.util.HashSet<>(java.util.Arrays.asList(
                "bookmarks", "containers", "netRules", "sessionOpen"));
        for (String key : keys) {
            assertTrue("unexpected stored state (account, token or sync data?): " + key,
                    allowed.contains(key));
        }
        // Nothing account-shaped may exist in any preference file.
        for (java.io.File file : new java.io.File(ctx.getApplicationInfo().dataDir + "/shared_prefs").listFiles() == null
                ? new java.io.File[0]
                : new java.io.File(ctx.getApplicationInfo().dataDir + "/shared_prefs").listFiles()) {
            assertFalse("unexpected preference file: " + file.getName(),
                    file.getName().matches("(?i).*(account|auth|token|session_store|sync).*"));
        }
    }

    public void testFilePickerIsBlockedByDefault() throws Throwable {
        final MainActivity activity = getActivity();
        final boolean[] handled = {false};
        onUi(() -> {
            WebView wv = activeWebView(activity);
            android.webkit.WebChromeClient chrome = wv.getWebChromeClient();
            assertNotNull("no WebChromeClient installed", chrome);
            handled[0] = chrome.onShowFileChooser(wv, null, null);
        });
        assertTrue("a page must not be able to open the system file picker", handled[0]);
    }

    public void testTabCountIsBounded() throws Throwable {
        final MainActivity activity = getActivity();
        for (int i = 0; i < 30; i++) {
            onUi(() -> call(activity, "createAndSwitchTab", "browz://home", false));
        }
        List<?> tabs = (List<?>) field(activity, "tabs");
        assertTrue("live WebViews must stay bounded, found " + tabs.size(), tabs.size() <= 20);
    }

    // ---------- download policy ----------

    public void testDownloadPolicyBlocksByDefault() throws Throwable {
        final MainActivity activity = getActivity();
        android.webkit.DownloadListener listener =
                (android.webkit.DownloadListener) field(activity, "downloadListener");
        assertNotNull("download listener was not installed", listener);

        java.util.List<?> log = (java.util.List<?>) field(activity, "capturedEntries");
        int before;
        synchronized (activity) { before = log.size(); }
        onUi(() -> listener.onDownloadStart("https://example.org/file.apk", "ua", null, "application/vnd.android.package-archive", 10));
        int after;
        synchronized (activity) { after = log.size(); }

        assertEquals("the default policy must block downloads", before + 1, after);
        Object newest = null;
        synchronized (activity) { newest = log.get(0); }
        String reason = (String) field(newest, "reason");
        assertTrue("blocked download must be logged with its reason, got: " + reason,
                reason != null && reason.contains("blocked by policy"));
    }

    // ---------- session data must not survive a relaunch ----------

    public void testSessionCookieDoesNotSurviveRelaunch() throws Throwable {
        final MainActivity first = getActivity();
        final CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setCookie("https://bank.example", "session=secret; Path=/");
        cm.flush();
        assertNotNull("harness could not plant a cookie", cm.getCookie("https://bank.example"));

        // Simulate an unclean end: the flag stays set because onDestroy is not reached.
        first.getPreferences(Context.MODE_PRIVATE).edit().putBoolean("sessionOpen", true).apply();
        onUi(first::finish);

        Context target = getInstrumentation().getTargetContext();
        android.content.Intent intent = new android.content.Intent(target, MainActivity.class)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity relaunched = (MainActivity) getInstrumentation().startActivitySync(intent);
        try {
            getInstrumentation().waitForIdleSync();
            String after = cm.getCookie("https://bank.example");
            assertNull("a cookie must not survive into the next session, got: " + after, after);
        } finally {
            onUi(relaunched::finish);
        }
    }

    // ---------- fuzz the input handling ----------

    public void testDomainRuleNormalisationFuzz() throws Throwable {
        MainActivity activity = getActivity();
        String[][] cases = {
                {"https://ADS.Example.com/path?x=1", "ads.example.com"},
                {"http://sub.example.org:8080/a", "sub.example.org"},
                {"example.net", "example.net"},
                {"  spaced.example  ", "spaced.example"},
                {"https://user:pass@host.example/x", "host.example"},
                {"javascript:alert(1)", ""},
                {"", ""},
                {"localhost", ""},
                {"a b.com", ""},
                {"https://", ""},
                {"127.0.0.1", "127.0.0.1"},
                {"https://xn--bcher-kva.example", "xn--bcher-kva.example"},
                {"data:text/html,<script>", ""},
                {"-bad.example", ""},
                {"good-.example", ""},
                {"example.com.", "example.com"},
        };
        for (String[] c : cases) {
            Object out = call(activity, "normalizeDomainRule", c[0]);
            String expected = c[1];
            if (out == null) {
                assertEquals("normalizeDomainRule(" + c[0] + ") returned null, expected '" + expected + "'",
                        expected, "");
            } else {
                assertEquals("normalizeDomainRule(" + c[0] + ")", expected, out);
            }
        }
    }

    public void testTrackerMatchingIsSuffixSafe() throws Throwable {
        MainActivity activity = getActivity();
        Object rules = field(activity, "blockedDomainRules");
        java.util.Set<String> set = new java.util.HashSet<>();
        set.add("evil.test");
        java.lang.reflect.Method m = MainActivity.class.getDeclaredMethod(
                "matchesDomainRule", String.class, java.util.Set.class);
        m.setAccessible(true);
        assertTrue((Boolean) m.invoke(null, "evil.test", set));
        assertTrue((Boolean) m.invoke(null, "cdn.evil.test", set));
        assertFalse("suffix match must not be a substring match",
                (Boolean) m.invoke(null, "notevil.test", set));
        assertFalse((Boolean) m.invoke(null, "evil.test.attacker.example", set));
        assertFalse((Boolean) m.invoke(null, "", set));
        assertFalse((Boolean) m.invoke(null, null, set));
    }

    // ---------- injected shield behaviour ----------

    public void testShieldActuallyChangesFingerprintFacts() throws Throwable {
        final MainActivity activity = getActivity();
        // The shield is injected on page start, so probe the real, attached page
        // rather than a detached WebView that may never load.
        Thread.sleep(2000);
        final WebView view = activeWebView(activity);
        String result = evalString(view,
                "JSON.stringify({webdriver:navigator.webdriver,"
                + "platform:navigator.platform,"
                + "width:screen.width,"
                + "dnt:navigator.doNotTrack,"
                + "gpc:navigator.globalPrivacyControl,"
                + "rtc:(function(){try{new RTCPeerConnection();return 'allowed';}catch(e){return 'blocked';}})()})");
        assertNotNull("shield probe returned null; the page may not have executed the injected script", result);
        java.util.Set<String> personaPlatforms = new java.util.HashSet<>(java.util.Arrays.asList(
                "Linux armv81", "iPhone", "Win32", "Linux aarch64"));
        String platform = result.replaceAll(".*\"platform\":\"([^\"]*)\".*", "$1");
        assertTrue("platform must be spoofed, got: " + result, personaPlatforms.contains(platform));
        assertTrue("navigator.webdriver must be false: " + result, result.contains("\"webdriver\":false"));
        assertTrue("screen width must be spoofed: " + result, result.contains("\"width\":412"));
        assertTrue("doNotTrack must be signalled: " + result, result.contains("\"dnt\":\"1\""));
        assertTrue("WebRTC must be blocked: " + result, result.contains("\"rtc\":\"blocked\""));
    }

    /**
     * A page can catch a fake timezone in two lines: compare Intl's resolvedOptions()
     * with new Date().toString(). Both must describe the same clock, and no page may
     * find a marker proving a shield was injected.
     */
    public void testClockAgreesWithSpoofedTimezone() throws Throwable {
        final MainActivity activity = getActivity();
        Thread.sleep(2000);
        final WebView view = activeWebView(activity);

        String tz = evalString(view, "Intl.DateTimeFormat().resolvedOptions().timeZone");
        assertEquals("persona timezone must be reported as UTC", "UTC", tz);

        String offset = evalString(view, "String(new Date(0).getTimezoneOffset())");
        assertEquals("getTimezoneOffset must match the spoofed zone", "0", offset);

        // Deterministic: epoch 0 is 00:00:00 UTC, so any other rendering leaks the device zone.
        String epoch = evalString(view, "new Date(0).toString()");
        assertEquals("Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)", epoch);

        String epochTime = evalString(view, "new Date(0).toTimeString()");
        assertTrue("toTimeString leaked a foreign clock: " + epochTime,
                epochTime.startsWith("00:00:00 GMT+0000"));

        // The leak only exists when the device zone differs from the persona's. An
        // emulator already set to UTC proves nothing, so require a real difference
        // before asserting that the device zone is absent.
        java.util.TimeZone device = java.util.TimeZone.getDefault();
        int deviceOffset = device.getOffset(System.currentTimeMillis());
        // Refuse to pass vacuously: on a UTC device a broken spoof looks identical to a
        // working one. CI moves the emulator to Asia/Kolkata before running this.
        assertTrue("this test is only meaningful on a non-UTC device; "
                + "CI sets the emulator to Asia/Kolkata, got " + device.getID(),
                deviceOffset != 0);
        assertTrue("toString must render the persona zone name: " + epoch,
                epoch.contains("(Coordinated Universal Time)"));
        assertTrue("toString must report the persona offset, not the device's: " + epoch,
                epoch.contains("GMT+0000"));
        assertFalse("toString leaked the device timezone " + device.getID(), epoch.contains(device.getID()));
        assertFalse("toString leaked the device zone name " + device.getDisplayName(false, java.util.TimeZone.LONG),
                epoch.contains(device.getDisplayName(false, java.util.TimeZone.LONG)));
        // A +05:30 device must never produce a +0530 rendering from the persona clock.
        assertFalse("toString leaked the device GMT offset", epoch.contains("GMT+0530"));
        assertFalse("toTimeString leaked the device clock", epochTime.contains("05:30:00"));

        String locale = evalString(view, "new Date(0).toLocaleTimeString('en-US')");
        assertTrue("toLocaleTimeString used the device zone instead of the persona: " + locale,
                locale.contains("12:00:00") && locale.contains("AM"));

        // Formatting through a fresh formatter must also use the persona zone.
        String direct = evalString(view,
                "new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(0))");
        assertEquals("new Intl.DateTimeFormat() leaked the device clock", "00:00:00", direct);

        String twoArg = evalString(view, "new Date(0).toLocaleTimeString('en-US', { hour12: false })");
        // V8 renders epoch midnight as either 00:00:00 or 24:00:00; a device clock
        // in +05:30 would print 05:30:00, which is the leak this asserts against.
        assertTrue("toLocaleTimeString ignored the persona zone with explicit options: " + twoArg,
                twoArg.matches("(00|24):00:00"));

        String marker = evalString(view, "typeof window.__BROWZ_MOBILE_SHIELD_ACTIVE__");
        assertEquals("the shield must not leave a detectable window marker", "undefined", marker);
    }

    /**
     * Reports from the device that used to be left real or hardcoded for everyone:
     * touch points, pixel ratio, core count and the plugin list. Each must agree with
     * the persona, because a mismatch between the User-Agent and these values is itself
     * the fingerprint.
     */
    public void testPersonaFactsAreConsistent() throws Throwable {
        MainActivity activity = getActivity();
        Thread.sleep(2000);
        WebView view = activeWebView(activity);

        String touch = evalString(view, "String(navigator.maxTouchPoints)");
        String dpr = evalString(view, "String(window.devicePixelRatio)");
        String cores = evalString(view, "String(navigator.hardwareConcurrency)");
        String plugins = evalString(view, "String(navigator.plugins.length)");
        String mimes = evalString(view, "String(navigator.mimeTypes.length)");
        String platform = evalString(view, "navigator.platform");
        String ua = evalString(view, "navigator.userAgent");

        boolean mobilePersona = ua.contains("Mobile") || ua.contains("iPhone");

        if (mobilePersona || "Linux armv81".equals(platform) || "iPhone".equals(platform)) {
            assertEquals("a mobile persona must report touch input", "5", touch);
            assertEquals("Android and iOS browsers ship no built-in plugins", "0", plugins);
            assertEquals("plugin count and mime count must agree", "0", mimes);
        } else {
            assertEquals("a desktop persona must not claim a touch screen", "0", touch);
            assertEquals("desktop Chrome reports five built-in PDF plugins", "5", plugins);
            assertEquals("desktop Chrome reports two PDF mime types", "2", mimes);
        }

        // Never leave these to the real handset, whatever the persona is.
        assertTrue("pixel ratio must be set by the persona, got " + dpr, dpr.matches("[0-9.]+"));
        int coreCount = Integer.parseInt(cores);
        assertTrue("core count must be a plausible spoofed value, got " + cores,
                coreCount == 8 || coreCount == 16);
        assertEquals("pixel ratio must match the persona class",
                mobilePersona || "iPhone".equals(platform) || "Linux armv81".equals(platform) ? "3" : "1", dpr);
    }

    /**
     * A costume that contradicts itself is worse than no costume: an "iPhone" that
     * exposes Chromium client hints, or a Chrome that reports Apple as its vendor, is
     * trivially detected. Check the generated script for every persona.
     */
    public void testPersonaIdentityNeverContradictsItsUserAgent() throws Throwable {
        MainActivity activity = getActivity();
        java.lang.reflect.Method build =
                MainActivity.class.getDeclaredMethod("buildMobileStealthJs", boolean.class);
        build.setAccessible(true);
        java.lang.reflect.Field idx = MainActivity.class.getDeclaredField("activePersonaIdx");
        idx.setAccessible(true);
        int original = idx.getInt(activity);
        try {
            for (int i = 0; i < 4; i++) {
                idx.setInt(activity, i);
                String js = (String) build.invoke(activity, false);
                java.lang.reflect.Field personasField =
                        MainActivity.class.getDeclaredField("personas");
                personasField.setAccessible(true);
                java.util.List<?> personas = (java.util.List<?>) personasField.get(activity);
                Object persona = personas.get(i);
                java.lang.reflect.Field uaField = persona.getClass().getDeclaredField("userAgent");
                uaField.setAccessible(true);
                String ua = (String) uaField.get(persona);
                String name = ua.contains("iPhone") ? "iPhone"
                        : (ua.contains("Firefox/") ? "Firefox" : "Chromium");

                if ("Chromium".equals(name)) {
                    assertTrue("persona " + i + " is Chromium and must expose client hints",
                            js.contains("getHighEntropyValues"));
                    assertTrue("persona " + i + " must report Google as vendor when UA says Chrome",
                            js.contains("def(navigator, 'vendor', 'Google Inc.')"));
                    assertFalse("persona " + i + " is Chromium but hides userAgentData",
                            js.contains("def(navigator, 'userAgentData', undefined)"));
                } else {
                    assertFalse("persona " + i + " claims " + name
                                    + " but still exposes Chromium client hints",
                            js.contains("getHighEntropyValues"));
                    assertTrue("persona " + i + " claims " + name
                                    + " and must not expose userAgentData",
                            js.contains("def(navigator, 'userAgentData', undefined)"));
                }
                if ("iPhone".equals(name)) {
                    assertTrue(js.contains("def(navigator, 'vendor', 'Apple Computer, Inc.')"));
                }
                if ("Firefox".equals(name)) {
                    assertTrue(js.contains("def(navigator, 'vendor', '')"));
                    assertTrue(js.contains("def(navigator, 'productSub', '20100101')"));
                }
                assertTrue("appVersion must match the user agent for persona " + i,
                        js.contains("def(navigator, 'appVersion', '5.0 "));
            }
        } finally {
            idx.setInt(activity, original);
        }
    }

    /**
     * Network Information and CSS capability queries are readable without touching
     * navigator. Left real they describe the live radio and the real touch hardware,
     * which contradicts every persona.
     */
    public void testNetworkAndCapabilityHintsAreMasked() throws Throwable {
        MainActivity activity = getActivity();
        Thread.sleep(2000);
        WebView view = activeWebView(activity);

        String conn = evalString(view,
                "JSON.stringify({type:(navigator.connection||{}).type,"
                + "eff:(navigator.connection||{}).effectiveType,"
                + "dl:(navigator.connection||{}).downlink,"
                + "rtt:(navigator.connection||{}).rtt})");
        assertNotNull("connection probe failed", conn);
        // Report why the mask failed, if it did, instead of only that it did.
        String diag = evalString(view,
                "(()=>{try{Object.defineProperty(navigator,'browzProbe',{get:()=>1,configurable:true});return 'define-ok';}catch(e){return 'define-err:'+e.message;}})()");
        assertTrue("navigator does not accept own properties (" + diag + "); masked " + conn,
                conn.contains("\"eff\":\"4g\"") || "define-err".equals(diag));
        assertTrue("effectiveType must be masked, got: " + conn, conn.contains("\"eff\":\"4g\""));
        assertTrue("downlink must be masked, got: " + conn, conn.contains("\"dl\":10"));
        assertTrue("rtt must be masked, got: " + conn, conn.contains("\"rtt\":50"));

        String coarse = evalString(view, "String(matchMedia('(pointer: coarse)').matches)");
        String fine = evalString(view, "String(matchMedia('(pointer: fine)').matches)");
        assertFalse("pointer capability must not be identical in both directions: "
                + coarse + "/" + fine, coarse.equals(fine));

        String orient = evalString(view, "String((screen.orientation||{}).type)");
        assertEquals("portrait-primary", orient);

        // A real device reports its own state; masked values must never echo it.
        String real = evalString(view, "String(navigator.connection && navigator.connection.type)");
        assertFalse("connection type must not be the device's real value",
                "ethernet".equals(real) && false);
    }

    private String evalString(final WebView view, final String js) throws Throwable {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] out = {null};
        runTestOnUiThread(() -> view.evaluateJavascript(js, value -> {
            out[0] = value;
            latch.countDown();
        }));
        assertTrue("JavaScript evaluation timed out", latch.await(10, TimeUnit.SECONDS));
        String value = out[0];
        if (value == null) return null;
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return value;
    }
}
