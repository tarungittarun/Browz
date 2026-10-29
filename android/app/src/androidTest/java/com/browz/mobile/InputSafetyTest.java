package com.browz.mobile;

import android.test.ActivityInstrumentationTestCase2;
import android.webkit.CookieManager;
import android.webkit.WebView;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Random;

/**
 * Input-safety checks: anything typed, clicked or injected must end up as a plain
 * web URL, never as a local file, a script or an app scheme. Also covers error-page
 * escaping, log bounds and clear-data completeness.
 */
@SuppressWarnings("deprecation")
public class InputSafetyTest extends ActivityInstrumentationTestCase2<MainActivity> {

    public InputSafetyTest() { super(MainActivity.class); }

    private static Object call(MainActivity activity, String name, Object... args) throws Exception {
        for (Method m : MainActivity.class.getDeclaredMethods()) {
            if (m.getName().equals(name) && m.getParameterCount() == args.length) {
                m.setAccessible(true);
                return m.invoke(activity, args);
            }
        }
        throw new NoSuchMethodException(name);
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

    private void assertSafeTarget(String input, String resolved) {
        assertNotNull("resolved URL was null for input: " + input, resolved);
        boolean allowed = resolved.startsWith("https://")
                || resolved.startsWith("http://")
                || resolved.startsWith("browz://");
        assertTrue("input '" + input + "' resolved to an unsafe target: " + resolved, allowed);
        if (resolved.startsWith("browz://")) {
            assertTrue("unknown internal scheme for input: " + input,
                    resolved.equals("browz://home")
                            || resolved.equals("browz://security")
                            || resolved.equals("browz://testbench"));
        }
    }

    public void testTypedInputNeverProducesDangerousSchemes() throws Throwable {
        MainActivity activity = getActivity();
        String[] hostile = {
                "javascript:alert(1)",
                "JavaScript:alert(document.cookie)",
                "file:///data/data/com.browz.mobile/shared_prefs/x.xml",
                "content://com.android.contacts/data",
                "intent://scan/#Intent;scheme=zxing;end",
                "data:text/html,<script>alert(1)</script>",
                "about:blank",
                "chrome://settings",
                "browz://../../etc/passwd",
                "https://browz.local/admin",
                "http://user:pass@evil.example/",
                "//evil.example/path",
                "\u0000https://example.com",
                "example.com\n<script>alert(1)</script>",
                "https://example.com/%0d%0aSet-Cookie:x=1",
        };
        for (String input : hostile) {
            Object resolved = call(activity, "resolveInputUrl", input);
            assertSafeTarget(input, resolved == null ? null : resolved.toString());
        }
    }

    public void testCredentialsAreStrippedFromUrls() throws Throwable {
        MainActivity activity = getActivity();
        Object cleaned = call(activity, "cleanAndUpgradeUrl",
                android.net.Uri.parse("https://trusted.example@evil.example/path"));
        String url = cleaned == null ? "" : cleaned.toString();
        assertTrue("credentials must be removed, got: " + url, !url.contains("@"));
        assertTrue("the real host must remain, got: " + url, url.startsWith("https://evil.example"));
        assertTrue("the path must be preserved, got: " + url, url.endsWith("/path"));
    }

    public void testRandomInputsStayOnWebSchemes() throws Throwable {
        MainActivity activity = getActivity();
        Random random = new Random(20261029L);
        String alphabet = "abc:. /?#%\\@[]<>\"';\u0000\u00e9\uFF1A";
        for (int i = 0; i < 300; i++) {
            StringBuilder sb = new StringBuilder();
            int length = 1 + random.nextInt(40);
            for (int c = 0; c < length; c++) sb.append(alphabet.charAt(random.nextInt(alphabet.length())));
            String input = sb.toString();
            Object resolved = call(activity, "resolveInputUrl", input);
            assertSafeTarget(input, resolved == null ? null : resolved.toString());
        }
    }

    public void testErrorPageEscapesHostileUrl() throws Throwable {
        final MainActivity activity = getActivity();
        final Object tab = field(activity, "activeTab");
        final WebView view = (WebView) field(tab, "webView");
        final String hostile = "https://example.com/<img src=x onerror=window.__xss=1>\"'><svg onload=window.__xss=2>";

        runTestOnUiThread(() -> {
            try {
                call(activity, "loadErrorPageIntoWebView", view, hostile, "<script>window.__xss=3</script>", 1);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        getInstrumentation().waitForIdleSync();
        Thread.sleep(1200);

        final String[] flag = {null};
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        runTestOnUiThread(() -> view.evaluateJavascript("String(window.__xss || 'clean')", value -> {
            flag[0] = value;
            latch.countDown();
        }));
        assertTrue("error page evaluation timed out", latch.await(10, java.util.concurrent.TimeUnit.SECONDS));
        assertEquals("a hostile URL must not execute script in the error page",
                "\"clean\"", flag[0]);
    }

    public void testRequestLogIsBounded() throws Throwable {
        final MainActivity activity = getActivity();
        final List<?> log = (List<?>) field(activity, "capturedEntries");
        for (int i = 0; i < 600; i++) {
            call(activity, "recordRequest", "GET", "https://example.org/page" + i, "example.org", false, "fuzz");
        }
        synchronized (activity) {
            assertTrue("request log grew past its 500-entry bound: " + log.size(), log.size() <= 500);
        }
        call(activity, "clearRequestLog");
        synchronized (activity) {
            assertEquals("clearing must empty the log", 0, log.size());
        }
    }

    public void testClearDataWipesCookiesButKeepsBookmarks() throws Throwable {
        final MainActivity activity = getActivity();
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setCookie("https://shop.example", "cart=1; Path=/");
        cm.flush();
        assertNotNull(cm.getCookie("https://shop.example"));

        int bookmarksBefore;
        synchronized (activity) {
            bookmarksBefore = ((List<?>) field(activity, "bookmarks")).size();
        }
        final List<?> log = (List<?>) field(activity, "capturedEntries");
        call(activity, "recordRequest", "GET", "https://shop.example/", "shop.example", false, "test");

        runTestOnUiThread(() -> {
            try {
                call(activity, "clearContainerState");
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        getInstrumentation().waitForIdleSync();
        Thread.sleep(500);

        assertNull("clear-data must remove cookies", cm.getCookie("https://shop.example"));
        synchronized (activity) {
            assertEquals("clear-data must empty the request log", 0, log.size());
            assertEquals("bookmarks are user data and must survive clear-data",
                    bookmarksBefore, ((List<?>) field(activity, "bookmarks")).size());
        }
    }
}
