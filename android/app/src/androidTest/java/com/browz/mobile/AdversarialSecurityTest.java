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
            results[5] = true;
            results[6] = true;
        });
        assertTrue("analytics request must be intercepted", results[0]);
        assertTrue("loopback probing must be blocked", results[1]);
        assertTrue("cloud metadata SSRF must be blocked", results[2]);
        assertTrue("NUL-byte host confusion must be blocked", results[3]);
        assertTrue("ordinary page requests must be forwarded untouched", results[4]);
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

    // ---------- injected shield behaviour ----------

    public void testShieldActuallyChangesFingerprintFacts() throws Throwable {
        final MainActivity activity = getActivity();
        final WebView[] holder = new WebView[1];
        onUi(() -> holder[0] = new WebView(activity));
        final WebView probe = holder[0];
        try {
            onUi(() -> probe.loadDataWithBaseURL("https://probe.test/",
                    "<!doctype html><html><body>probe</body></html>", "text/html", "UTF-8", null));
            Thread.sleep(1500);

            final String shieldJs = (String) call(activity, "buildMobileStealthJs", true);
            onUi(() -> probe.evaluateJavascript(shieldJs, null));
            Thread.sleep(500);

            String result = evalString(probe,
                    "JSON.stringify({webdriver:navigator.webdriver,"
                    + "platform:navigator.platform,"
                    + "width:screen.width,"
                    + "dnt:navigator.doNotTrack,"
                    + "rtc:(function(){try{new RTCPeerConnection();return 'allowed';}catch(e){return 'blocked';}})()})");
            assertNotNull("no probe result", result);
            assertTrue("navigator.webdriver must be false: " + result, result.contains("\"webdriver\":false"));
            assertTrue("screen width must be spoofed: " + result, result.contains("\"width\":412"));
            assertTrue("doNotTrack must be signalled: " + result, result.contains("\"dnt\":\"1\""));
            assertTrue("WebRTC must be blocked: " + result, result.contains("\"rtc\":\"blocked\""));
        } finally {
            onUi(() -> probe.destroy());
        }
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
