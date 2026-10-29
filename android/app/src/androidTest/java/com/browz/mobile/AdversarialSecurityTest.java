package com.browz.mobile;

import android.app.Application;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ProviderInfo;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.net.Uri;
import android.test.ActivityInstrumentationTestCase2;
import android.view.WindowManager;
import android.webkit.ClientCertRequest;
import android.webkit.CookieManager;
import android.webkit.HttpAuthHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
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
 * Adversarial checks that execute the real app code on a device: interception,
 * cookie wiping on container switch, window capture flags, manifest exposure and
 * the injected shield. These are behavioural tests, not source-text matching.
 */
@SuppressWarnings("deprecation")
public class AdversarialSecurityTest extends ActivityInstrumentationTestCase2<MainActivity> {

    public AdversarialSecurityTest() { super(MainActivity.class); }

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

    private static void setField(Object target, String name, Object value) throws Exception {
        Class<?> c = target.getClass();
        while (c != null) {
            try {
                Field f = c.getDeclaredField(name);
                f.setAccessible(true);
                f.set(target, value);
                return;
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

    private static void run(MainActivity activity, String name, Object... args) throws Exception {
        call(activity, name, args);
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
        assertEquals("release build must not be debuggable",
                0, info.flags & ApplicationInfo.FLAG_DEBUGGABLE);

        PackageInfo full = pm.getPackageInfo(ctx.getPackageName(),
                PackageManager.GET_PERMISSIONS | PackageManager.GET_ACTIVITIES
                        | PackageManager.GET_RECEIVERS | PackageManager.GET_SERVICES
                        | PackageManager.GET_PROVIDERS);
        List<String> permissions = new ArrayList<>();
        if (full.requestedPermissions != null) {
            for (String p : full.requestedPermissions) permissions.add(p);
        }
        assertEquals("only INTERNET may be requested, found " + permissions,
                1, permissions.size());
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
        MainActivity activity = getActivity();
        WebView wv = activeWebView(activity);
        WebViewClient client = wv.getWebViewClient();
        assertNotNull(client);

        WebResourceResponse tracker = client.shouldInterceptRequest(wv,
                new FakeRequest("https://www.google-analytics.com/collect?v=1", "GET", false));
        assertNotNull("analytics request must be intercepted", tracker);
        assertEquals(0, tracker.getData().available());

        WebResourceResponse loopback = client.shouldInterceptRequest(wv,
                new FakeRequest("https://127.0.0.1:8443/admin", "GET", true));
        assertNotNull("loopback probing must be blocked", loopback);

        WebResourceResponse metadata = client.shouldInterceptRequest(wv,
                new FakeRequest("https://169.254.169.254/latest/meta-data/", "GET", true));
        assertNotNull("cloud metadata SSRF must be blocked", metadata);

        WebResourceResponse nul = client.shouldInterceptRequest(wv,
                new FakeRequest("https://example.org/%00.jpg", "GET", false));
        assertNotNull("NUL-byte host confusion must be blocked", nul);

        WebResourceResponse ordinary = client.shouldInterceptRequest(wv,
                new FakeRequest("https://example.org/article", "GET", true));
        assertNull("ordinary page requests must be forwarded untouched", ordinary);
    }

    public void testUserRulesOverrideBuiltInTrackerList() throws Throwable {
        MainActivity activity = getActivity();
        WebView wv = activeWebView(activity);
        WebViewClient client = wv.getWebViewClient();

        Object blocked = field(activity, "blockedDomainRules");
        Object allowed = field(activity, "allowedDomainRules");
        ((java.util.Set<String>) blocked).add("malware.test");
        ((java.util.Set<String>) allowed).add("google-analytics.com");
        try {
            WebResourceResponse ruleHit = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://cdn.malware.test/payload.js", "GET", false));
            assertNotNull("user block rule must stop subdomain requests", ruleHit);

            WebResourceResponse allowHit = client.shouldInterceptRequest(wv,
                    new FakeRequest("https://www.google-analytics.com/collect?v=2", "GET", false));
            assertNull("an allow rule must override the tracker list", allowHit);
        } finally {
            ((java.util.Set<String>) blocked).remove("malware.test");
            ((java.util.Set<String>) allowed).remove("google-analytics.com");
        }
    }

    public void testHttpAuthAndClientCertificatesAreDenied() throws Throwable {
        MainActivity activity = getActivity();
        WebView wv = activeWebView(activity);
        WebViewClient client = wv.getWebViewClient();

        final boolean[] authCancelled = {false};
        HttpAuthHandler auth = new HttpAuthHandler() {
            @Override public boolean useHttpAuthUsernamePassword() { return false; }
            @Override public void cancel() { authCancelled[0] = true; }
            @Override public void proceed(String u, String p) { }
        };
        client.onReceivedHttpAuthRequest(wv, auth, "intranet.test", "Restricted");
        assertTrue("HTTP auth prompts must be refused", authCancelled[0]);

        final boolean[] certCancelled = {false};
        ClientCertRequest cert = new ClientCertRequest() {
            @Override public void proceed(PrivateKey key, X509Certificate[] chain) { }
            @Override public void cancel() { certCancelled[0] = true; }
            @Override public void ignore() { }
            @Override public String getHost() { return "mtls.test"; }
            @Override public int getPort() { return 443; }
            @Override public String[] getKeyTypes() { return new String[]{"RSA"}; }
            @Override public Principal[] getPrincipals() { return new Principal[0]; }
        };
        client.onReceivedClientCertRequest(wv, cert);
        assertTrue("client-certificate requests must be cancelled", certCancelled[0]);
    }

    // ---------- container isolation ----------

    public void testContainerSwitchWipesCookiesAndPages() throws Throwable {
        MainActivity activity = getActivity();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setCookie("https://example.com", "browz_leak=1; Path=/");
        cm.flush();
        String before = cm.getCookie("https://example.com");
        assertNotNull("test harness could not set a cookie", before);
        assertTrue(before.contains("browz_leak=1"));

        // Add a second container directly so no dialog is involved.
        Object containers = field(activity, "containers");
        int newId = 9001;
        Object profile = newContainerProfile(newId, "Test Container");
        ((List<Object>) containers).add(profile);

        run(activity, "switchContainer", newId);
        getInstrumentation().waitForIdleSync();

        String after = cm.getCookie("https://example.com");
        assertNull("container switch must delete the previous session's cookies", after);
        Object tabs = field(activity, "tabs");
        assertEquals("container switch must leave exactly one fresh page", 1, ((List<?>) tabs).size());
        assertEquals("active container must be the new one",
                newId, ((Integer) field(activity, "activeContainerId")).intValue());
    }

    private Object newContainerProfile(int id, String name) throws Exception {
        Class<?> c = Class.forName("com.browz.mobile.MainActivity$ContainerProfile");
        java.lang.reflect.Constructor<?> ctor = c.getDeclaredConstructor(int.class, String.class);
        ctor.setAccessible(true);
        return ctor.newInstance(id, name);
    }

    // ---------- injected shield behaviour ----------

    public void testShieldActuallyChangesFingerprintFacts() throws Throwable {
        final MainActivity activity = getActivity();
        final WebView probeView = new WebView(activity);
        try {
            runOnUiThreadSync(() -> probeView.loadDataWithBaseURL("https://probe.test/",
                    "<!doctype html><html><body>probe</body></html>", "text/html", "UTF-8", null));
            Thread.sleep(1200);

            final String shieldJs = (String) call(activity, "buildMobileStealthJs", true);
            runOnUiThreadSync(() -> probeView.evaluateJavascript(shieldJs, null));
            Thread.sleep(400);

            String result = evalString(probeView,
                    "JSON.stringify({webdriver:navigator.webdriver,"
                    + "platform:navigator.platform,"
                    + "width:screen.width,"
                    + "dnt:navigator.doNotTrack,"
                    + "gpc:navigator.globalPrivacyControl,"
                    + "rtc:(function(){try{new RTCPeerConnection();return 'allowed';}catch(e){return 'blocked';}})()})");
            assertNotNull(result);
            assertTrue("navigator.webdriver must be false: " + result, result.contains("\"webdriver\":false"));
            assertTrue("screen width must be spoofed: " + result, result.contains("\"width\":412"));
            assertTrue("doNotTrack must be signalled: " + result, result.contains("\"dnt\":\"1\""));
            assertTrue("WebRTC must be blocked: " + result, result.contains("\"rtc\":\"blocked\""));
        } finally {
            runOnUiThreadSync(() -> probeView.destroy());
        }
    }

    private void runOnUiThreadSync(Runnable r) throws Throwable {
        runTestOnUiThread(r);
        getInstrumentation().waitForIdleSync();
    }

    private String evalString(WebView view, final String js) throws Throwable {
        final CountDownLatch latch = new CountDownLatch(1);
        final String[] out = {null};
        runTestOnUiThread(() -> view.evaluateJavascript(js, value -> {
            out[0] = value;
            latch.countDown();
        }));
        assertTrue("JavaScript evaluation timed out", latch.await(10, TimeUnit.SECONDS));
        String value = out[0];
        if (value == null) return null;
        // evaluateJavascript returns a JSON-encoded string literal.
        if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
            value = value.substring(1, value.length() - 1).replace("\\\"", "\"").replace("\\\\", "\\");
        }
        return value;
    }
}
