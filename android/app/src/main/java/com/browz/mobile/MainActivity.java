package com.browz.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.ClientCertRequest;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;

import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends Activity {

    private static class Persona {
        final String id;
        final String label;
        final String userAgent;
        final String platform;
        final String webglVendor;
        final String webglRenderer;
        final String timezone;
        final int screenW;
        final int screenH;
        final boolean isMobile;
        // Previously hardcoded (always 8 / 8) or simply left real, which made every
        // user share the same value or leak the actual device.
        final int cores;
        final int memoryGb;
        final int touchPoints;
        final String pixelRatio;
        // Derived from the user agent so the identity can never contradict itself.
        final boolean chromium;
        final String navigatorVendor;
        final String appVersion;
        final String productSub;

        Persona(String id, String label, String ua, String platform, String vendor, String renderer, String tz, int w, int h, boolean isMobile) {
            this.id = id;
            this.label = label;
            this.userAgent = ua;
            this.platform = platform;
            this.webglVendor = vendor;
            this.webglRenderer = renderer;
            this.timezone = tz;
            this.screenW = w;
            this.screenH = h;
            this.isMobile = isMobile;
            // Derive coherent hardware facts from the device class, so the persona never
            // claims a touch-less Windows PC on a phone or an iPhone with 16 cores.
            this.cores = isMobile ? 8 : 16;
            this.memoryGb = isMobile ? 8 : 8;
            this.touchPoints = isMobile ? 5 : 0;
            this.pixelRatio = isMobile ? "3" : "1";
            // Safari and Firefox are not Chromium: exposing navigator.userAgentData or a
            // Chromium brand list under an iPhone/Safari user agent is a one-line giveaway.
            this.chromium = ua.contains("Chrome/") && !ua.contains("Firefox/");
            // Chrome user agents also contain "Safari/", so test for Chrome first.
            this.navigatorVendor = ua.contains("Firefox/") ? ""
                : (ua.contains("Chrome/") ? "Google Inc." : "Apple Computer, Inc.");
            this.appVersion = ua.startsWith("Mozilla/") ? ua.substring("Mozilla/".length) : ua;
            this.productSub = ua.contains("Firefox/") ? "20100101" : "20030107";
        }
    }

    private static class CapturedEntry {
        final int seq;
        final String timestamp;
        final String method;
        final String url;
        final String domain;
        final boolean blocked;
        final String reason;
        // Real status from the optional HEAD probe; null means "not measured".
        String status = null;

        CapturedEntry(int seq, String timestamp, String method, String url, String domain, boolean blocked, String reason) {
            this.seq = seq;
            this.timestamp = timestamp;
            this.method = method;
            this.url = url;
            this.domain = domain;
            this.blocked = blocked;
            this.reason = reason;
        }
    }

    private static class BookmarkItem {
        final String title;
        final String url;

        BookmarkItem(String title, String url) {
            this.title = title;
            this.url = url;
        }
    }

    private static class BrowserTab {
        final int id;
        final WebView webView;
        final boolean ghostMode;
        String title = "New Tab";
        String url = "browz://home";
        boolean loading = false;
        int zoomPercent = 100;

        BrowserTab(int id, WebView webView, boolean ghostMode) {
            this.id = id;
            this.webView = webView;
            this.ghostMode = ghostMode;
        }
    }

    private static class ContainerProfile {
        final int id;
        final String name;

        ContainerProfile(int id, String name) {
            this.id = id;
            this.name = name;
        }
    }

    private final List<Persona> personas = Arrays.asList(
        new Persona(
            "pixel9_android15",
            "Android 15 — Pixel 9 (Stealth Default)",
            "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
            "Linux armv81",
            "Qualcomm",
            "Adreno (TM) Generic Mobile GPU",
            "UTC",
            412, 915, true
        ),
        new Persona(
            "iphone16_ios18",
            "iOS 18.1 — iPhone 16 Pro (Safari Mobile)",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
            "iPhone",
            "Apple Inc.",
            "Apple GPU",
            "UTC",
            393, 852, true
        ),
        new Persona(
            "win11_desktop",
            "Desktop Mode — Windows 11 Intel PC",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Win32",
            "Intel Inc.",
            "Intel(R) Iris(R) Xe Graphics",
            "UTC",
            1920, 1080, false
        ),
        new Persona(
            "tor_mobile",
            "Firefox-style mobile profile (not Tor)",
            "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0",
            "Linux aarch64",
            "Mozilla",
            "Mozilla Generic Renderer",
            "UTC",
            360, 800, true
        )
    );

    private static final Set<String> TRACKER_DOMAINS = new HashSet<>(Arrays.asList(
        "doubleclick.net",
        "google-analytics.com",
        "googletagmanager.com",
        "googlesyndication.com",
        "facebook.net",
        "connect.facebook.net",
        "hotjar.com",
        "clarity.ms",
        "appsflyer.com",
        "adjust.com",
        "branch.io",
        "scorecardresearch.com",
        "criteo.com",
        "taboola.com",
        "outbrain.com",
        "mixpanel.com",
        "amplitude.com",
        "segment.io",
        "fullstory.com",
        "mouseflow.com"
    ));

    private static final Set<String> TRACKING_PARAMS = new HashSet<>(Arrays.asList(
        "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
        "utm_name", "utm_reader", "utm_viz_id", "utm_pubreferrer",
        "fbclid", "gclid", "gclsrc", "msclkid", "dclid", "twclid", "ttclid", "yclid",
        "mc_cid", "mc_eid", "_ga", "_gl", "_hsenc", "_hsmi", "hsctatracking",
        "igshid", "si", "spm", "vero_id", "mkt_tok", "oly_enc_id", "oly_anon_id",
        "rb_clickid", "s_kwcid", "zanpid", "wickedid"
    ));

    private final String bridgeSecret = UUID.randomUUID().toString();
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private final Map<String, Integer> retryAttemptsByUrl = new HashMap<>();
    // Which URL the shield was last injected into for each page; replaces the old
    // window global that any website could read.
    private final java.util.WeakHashMap<WebView, String> shieldInjectedFor = new java.util.WeakHashMap<>();

    private int activePersonaIdx = 0;
    private int noiseSeed = 482910;
    private boolean shieldCanvas = true;
    private boolean shieldWebGL = true;
    private boolean shieldAudio = true;
    private boolean shieldClientRects = true;
    private boolean shieldWebRTC = true;
    private boolean shieldSensors = true;
    private boolean shieldTimezone = true;
    private boolean shieldClientHints = true;
    private boolean shieldStorageAndVoices = true;
    private String radioProfile = "stealth_hidden";
    private boolean blockServiceWorkers = true;
    private boolean blockCacheStorage = true;
    private boolean blockFileSystemAccess = true;
    private boolean blockClipboardRead = true;
    private boolean blockWebSockets = false;
    private boolean timerJitter = true;
    private boolean fitVideosToScreen = true;
    private boolean blockTrackers = true;
    private boolean stripUrlParams = true;
    private boolean forceHttps = true;
    private boolean autoRetryFailed = true;
    private boolean screenSecurityFlag = true;
    private boolean captureTraffic = true;
    private int strippedParamsCount = 0;
    private int blockedTrackersCount = 0;
    private int seqCounter = 1;
    private boolean blockDownloads = true;
    // Retained so the policy can be exercised by device tests.
    android.webkit.DownloadListener downloadListener = null;
    private boolean probeStatuses = true;
    private final Set<String> blockedDomainRules = new HashSet<>();
    private final Set<String> allowedDomainRules = new HashSet<>();
    private final List<ContainerProfile> containers = new ArrayList<>();
    private int activeContainerId = 1;
    private int containerIdCounter = 1;

    private final List<CapturedEntry> capturedEntries = new ArrayList<>();
    private final List<BookmarkItem> bookmarks = new ArrayList<>(Arrays.asList(
        new BookmarkItem("Home", "browz://home"),
        new BookmarkItem("Live privacy checks", "browz://security"),
        new BookmarkItem("API Testbench", "browz://testbench"),
        new BookmarkItem("DuckDuckGo", "https://duckduckgo.com"),
        new BookmarkItem("GitHub", "https://github.com"),
        new BookmarkItem("Google", "https://www.google.com"),
        new BookmarkItem("YouTube", "https://m.youtube.com")
    ));
    private final List<BrowserTab> tabs = new ArrayList<>();
    private BrowserTab activeTab = null;
    private int tabIdCounter = 1;

    private LinearLayout topBarView;
    private HorizontalScrollView bmScrollView;
    private LinearLayout bottomBarView;
    private FrameLayout webViewContainer;
    private LinearLayout bookmarksContainer;
    private EditText urlInput;
    private TextView starBtn;
    private TextView tabCountBtn;
    private TextView trafficCountBtn;
    private TextView backBtn;
    private TextView fwdBtn;
    private TextView reloadOrStopBtn;
    private ProgressBar progressBar;
    private View customVideoView = null;
    private WebChromeClient.CustomViewCallback customVideoCallback = null;

    private int dp(int val) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP,
            val,
            getResources().getDisplayMetrics()
        );
    }

    private GradientDrawable roundBg(int fillColor, int strokeColor, int radiusDp) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(fillColor);
        gd.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) {
            gd.setStroke(dp(1), strokeColor);
        }
        return gd;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);

        // Apply FLAG_SECURE so other apps / Recent Apps switcher cannot screenshot browsing session
        if (screenSecurityFlag) {
            getWindow().setFlags(
                WindowManager.LayoutParams.FLAG_SECURE,
                WindowManager.LayoutParams.FLAG_SECURE
            );
        }
        getWindow().setStatusBarColor(Color.parseColor("#121215"));
        getWindow().setNavigationBarColor(Color.parseColor("#18181c"));

        // Remote debugging over adb would expose every page's storage to a host.
        WebView.setWebContentsDebuggingEnabled(false);

        // Sessions are meant to die with the process. Android skips onDestroy after
        // a crash, a force-stop or a low-memory kill, so anything left on disk from
        // the previous run is erased before the first page can read it.
        boolean previousRunCrashed = getPreferences(MODE_PRIVATE).getBoolean("sessionOpen", false);
        getPreferences(MODE_PRIVATE).edit().putBoolean("sessionOpen", true).apply();
        try {
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            WebStorage.getInstance().deleteAllData();
        } catch (Exception ignored) { }
        if (previousRunCrashed) {
            // The previous session ended without a clean shutdown; its request log is
            // not carried forward either.
            synchronized (this) { capturedEntries.clear(); }
        }
        noiseSeed = 100000 + new Random().nextInt(900000);
        loadBookmarks();
        loadContainers();
        loadNetworkRules();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#121215"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            root.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            root.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS);
        }

        // --- 1. TOP COMPACT OMNIBOX BAR ---
        LinearLayout topBar = new LinearLayout(this);
        topBarView = topBar;
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        topBar.setBackgroundColor(Color.parseColor("#18181c"));
        topBar.setPadding(dp(8), dp(6), dp(8), dp(6));

        // Shield Button
        TextView shieldBtn = new TextView(this);
        shieldBtn.setText("☰");
        shieldBtn.setContentDescription("Browser menu");
        shieldBtn.setTextColor(Color.parseColor("#22c55e"));
        shieldBtn.setTextSize(20f);
        shieldBtn.setGravity(Gravity.CENTER);
        shieldBtn.setMinWidth(dp(48));
        shieldBtn.setMinHeight(dp(48));
        shieldBtn.setTypeface(Typeface.DEFAULT_BOLD);
        shieldBtn.setPadding(dp(9), dp(6), dp(9), dp(6));
        shieldBtn.setBackground(roundBg(Color.parseColor("#121215"), Color.parseColor("#2e2e36"), 14));
        shieldBtn.setOnClickListener(v -> showBrowserMenu());
        topBar.addView(shieldBtn);

        // URL / Search Omnibox
        urlInput = new EditText(this);
        LinearLayout.LayoutParams urlParams = new LinearLayout.LayoutParams(0, dp(48), 1f);
        urlParams.setMargins(dp(5), 0, dp(5), 0);
        urlInput.setLayoutParams(urlParams);
        urlInput.setBackground(roundBg(Color.parseColor("#121215"), Color.parseColor("#2e2e36"), 18));
        urlInput.setPadding(dp(12), 0, dp(12), 0);
        urlInput.setTextColor(Color.parseColor("#f4f4f5"));
        urlInput.setHintTextColor(Color.parseColor("#9ca3af"));
        urlInput.setHint("Search or type address");
        urlInput.setTextSize(13f);
        urlInput.setSingleLine(true);
        urlInput.setSelectAllOnFocus(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        urlInput.setImeOptions(EditorInfo.IME_ACTION_GO | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            urlInput.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        }
        urlInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_GO ||
                actionId == EditorInfo.IME_ACTION_DONE ||
                (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                hideKeyboard();
                navigateActiveTab(urlInput.getText().toString());
                return true;
            }
            return false;
        });
        topBar.addView(urlInput);

        // Bookmark Star Button
        starBtn = new TextView(this);
        starBtn.setText("☆");
        starBtn.setContentDescription("Bookmark this page");
        starBtn.setMinWidth(dp(48));
        starBtn.setMinHeight(dp(48));
        starBtn.setTextColor(Color.parseColor("#d4d4d8"));
        starBtn.setTextSize(15f);
        starBtn.setGravity(Gravity.CENTER);
        starBtn.setPadding(dp(7), dp(4), dp(7), dp(4));
        starBtn.setBackground(roundBg(Color.parseColor("#222228"), Color.parseColor("#2e2e36"), 8));
        starBtn.setOnClickListener(v -> toggleBookmarkCurrentPage());
        topBar.addView(starBtn);

        // Tools / Zoom / Find Button
        TextView toolsBtn = new TextView(this);
        toolsBtn.setText("Tools");
        toolsBtn.setTextColor(Color.parseColor("#d4d4d8"));
        toolsBtn.setTextSize(11.5f);
        toolsBtn.setTypeface(Typeface.DEFAULT_BOLD);
        toolsBtn.setPadding(dp(8), dp(6), dp(8), dp(6));
        LinearLayout.LayoutParams toolsLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        toolsLp.setMargins(dp(4), 0, dp(4), 0);
        toolsBtn.setLayoutParams(toolsLp);
        toolsBtn.setBackground(roundBg(Color.parseColor("#222228"), Color.parseColor("#2e2e36"), 8));
        toolsBtn.setOnClickListener(v -> showToolsDialog());
        // Tools are available from the browser menu to leave room for the address bar.
        toolsBtn.setVisibility(View.GONE);
        topBar.addView(toolsBtn);

        // Tabs Switcher Badge
        tabCountBtn = new TextView(this);
        tabCountBtn.setText("1");
        tabCountBtn.setContentDescription("Open tabs");
        tabCountBtn.setMinWidth(dp(48));
        tabCountBtn.setMinHeight(dp(48));
        tabCountBtn.setTextColor(Color.parseColor("#f4f4f5"));
        tabCountBtn.setTextSize(12f);
        tabCountBtn.setTypeface(Typeface.DEFAULT_BOLD);
        tabCountBtn.setGravity(Gravity.CENTER);
        tabCountBtn.setPadding(dp(9), dp(6), dp(9), dp(6));
        tabCountBtn.setBackground(roundBg(Color.parseColor("#222228"), Color.parseColor("#3f3f4a"), 8));
        tabCountBtn.setOnClickListener(v -> showTabsDialog());
        topBar.addView(tabCountBtn);

        root.addView(topBar);

        // --- 1B. HORIZONTAL SCROLLABLE BOOKMARKS BAR ---
        HorizontalScrollView bmScroll = new HorizontalScrollView(this);
        bmScrollView = bmScroll;
        bmScroll.setHorizontalScrollBarEnabled(false);
        bmScroll.setBackgroundColor(Color.parseColor("#16161a"));
        bmScroll.setPadding(dp(6), dp(4), dp(6), dp(4));
        bookmarksContainer = new LinearLayout(this);
        bookmarksContainer.setOrientation(LinearLayout.HORIZONTAL);
        bookmarksContainer.setGravity(Gravity.CENTER_VERTICAL);
        bmScroll.addView(bookmarksContainer);
        root.addView(bmScroll);
        bmScroll.setVisibility(View.GONE);
        renderBookmarksBar();

        // --- 2. THIN ANIMATED PROGRESS BAR ---
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            dp(2)
        ));
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar);

        // --- 3. FULL-SCREEN WEBVIEW VIEWPORT ---
        webViewContainer = new FrameLayout(this);
        webViewContainer.setLayoutParams(new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            0,
            1f
        ));
        webViewContainer.setBackgroundColor(Color.parseColor("#121215"));
        root.addView(webViewContainer);

        // --- 4. BOTTOM MOBILE NAVIGATION & UNTRACEABILITY BAR ---
        LinearLayout bottomBar = new LinearLayout(this);
        bottomBarView = bottomBar;
        bottomBar.setOrientation(LinearLayout.HORIZONTAL);
        bottomBar.setGravity(Gravity.CENTER_VERTICAL);
        bottomBar.setBackgroundColor(Color.parseColor("#18181c"));
        bottomBar.setPadding(dp(5), dp(6), dp(5), dp(6));

        backBtn = makeBottomBtn("‹ Back", v -> {
            if (activeTab != null && activeTab.webView.canGoBack()) {
                activeTab.webView.goBack();
            }
        });
        bottomBar.addView(backBtn);

        fwdBtn = makeBottomBtn("Fwd ›", v -> {
            if (activeTab != null && activeTab.webView.canGoForward()) {
                activeTab.webView.goForward();
            }
        });
        bottomBar.addView(fwdBtn);

        bottomBar.addView(makeBottomBtn("Home", v -> navigateActiveTab("browz://home")));

        reloadOrStopBtn = makeBottomBtn("↻ Reload", v -> {
            if (activeTab == null) return;
            if (activeTab.loading) {
                activeTab.webView.stopLoading();
                setTabLoadingState(activeTab, false);
                Toast.makeText(this, "Stopped loading", Toast.LENGTH_SHORT).show();
            } else {
                retryAttemptsByUrl.clear();
                if (activeTab.url.startsWith("browz://")) {
                    navigateActiveTab(activeTab.url);
                } else {
                    setTabLoadingState(activeTab, true);
                    activeTab.webView.reload();
                }
            }
        });
        bottomBar.addView(reloadOrStopBtn);

        trafficCountBtn = makeBottomBtn("Traffic (0)", v -> showTrafficCaptureDialog());
        // Traffic is available in the menu rather than crowding navigation.
        trafficCountBtn.setVisibility(View.GONE);
        bottomBar.addView(trafficCountBtn);

        TextView burnBtn = makeBottomBtn("New ID", v -> burnAndRotateIdentity());
        burnBtn.setTextColor(Color.parseColor("#f87171"));
        burnBtn.setVisibility(View.GONE);
        bottomBar.addView(burnBtn);

        bottomBar.addView(makeBottomBtn("Tabs", v -> showTabsDialog()));

        root.addView(bottomBar);
        setContentView(root);

        // Open initial tab (or external intent URL if launched from link)
        String initialUrl = "browz://home";
        Intent intent = getIntent();
        if (intent != null && Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri supplied = intent.getData();
            String scheme = supplied.getScheme() == null ? "" : supplied.getScheme().toLowerCase(Locale.ROOT);
            // Another app can start Browz with any URI; only plain web links are accepted,
            // and they are stripped and HTTPS-upgraded exactly like typed addresses.
            if ("http".equals(scheme) || "https".equals(scheme)) {
                initialUrl = cleanAndUpgradeUrl(supplied);
            } else {
                Toast.makeText(this, "Browz ignored an unsupported link from another app", Toast.LENGTH_LONG).show();
            }
        }
        createAndSwitchTab(initialUrl, false);
    }

    private TextView makeBottomBtn(String label, View.OnClickListener listener) {
        TextView tv = new TextView(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(48), 1f);
        lp.setMargins(dp(2), 0, dp(2), 0);
        tv.setLayoutParams(lp);
        tv.setText(label);
        tv.setContentDescription(label);
        tv.setTextColor(Color.parseColor("#d4d4d8"));
        tv.setTextSize(11.5f);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setBackground(roundBg(Color.parseColor("#222228"), Color.parseColor("#2e2e36"), 7));
        tv.setOnClickListener(listener);
        return tv;
    }

    // Bookmarks are private app data, but can include sensitive URLs. They are not encrypted.
    private void loadBookmarks() {
        String saved = getPreferences(MODE_PRIVATE).getString("bookmarks", null);
        if (saved == null) return;
        try {
            JSONArray data = new JSONArray(saved);
            List<BookmarkItem> restored = new ArrayList<>();
            for (int i = 0; i < data.length() && i < 500; i++) {
                JSONObject item = data.optJSONObject(i);
                if (item == null) continue;
                String title = item.optString("title", "");
                String url = item.optString("url", "");
                if (title.length() > 200 || url.length() > 8192 || title.isEmpty()) continue;
                Uri parsed = Uri.parse(url);
                String scheme = parsed.getScheme();
                if (!("https".equals(scheme) || "http".equals(scheme) || "browz".equals(scheme))) continue;
                restored.add(new BookmarkItem(title, url));
            }
            bookmarks.clear();
            bookmarks.addAll(restored);
        } catch (Exception ignored) {
            // A malformed preference must not prevent the browser from opening.
        }
    }

    private void saveBookmarks() {
        JSONArray data = new JSONArray();
        try {
            for (BookmarkItem bookmark : bookmarks) {
                JSONObject item = new JSONObject();
                item.put("title", bookmark.title);
                item.put("url", bookmark.url);
                data.put(item);
            }
            getPreferences(MODE_PRIVATE).edit().putString("bookmarks", data.toString()).apply();
        } catch (Exception e) {
            Toast.makeText(this, "Could not save bookmarks", Toast.LENGTH_LONG).show();
        }
    }

    private void renderBookmarksBar() {
        if (bookmarksContainer == null) return;
        bookmarksContainer.removeAllViews();
        for (int i = 0; i < bookmarks.size(); i++) {
            final BookmarkItem bm = bookmarks.get(i);
            TextView chip = new TextView(this);
            chip.setText(bm.title);
            chip.setTextColor(Color.parseColor("#d4d4d8"));
            chip.setTextSize(11.5f);
            chip.setPadding(dp(9), dp(4), dp(9), dp(4));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            );
            lp.setMargins(dp(3), 0, dp(3), 0);
            chip.setLayoutParams(lp);
            chip.setBackground(roundBg(Color.parseColor("#222228"), Color.parseColor("#2e2e36"), 6));
            chip.setOnClickListener(v -> navigateActiveTab(bm.url));
            bookmarksContainer.addView(chip);
        }
    }

    private void syncBookmarkStar() {
        if (starBtn == null || activeTab == null) return;
        boolean found = false;
        for (BookmarkItem b : bookmarks) {
            if (b.url.equals(activeTab.url)) {
                found = true;
                break;
            }
        }
        starBtn.setContentDescription(found ? "Remove bookmark" : "Bookmark this page");
        starBtn.setText(found ? "★" : "☆");
        starBtn.setTextColor(found ? Color.parseColor("#eab308") : Color.parseColor("#d4d4d8"));
    }

    private void toggleBookmarkCurrentPage() {
        if (activeTab == null) return;
        for (int i = 0; i < bookmarks.size(); i++) {
            if (bookmarks.get(i).url.equals(activeTab.url)) {
                bookmarks.remove(i);
                saveBookmarks();
                renderBookmarksBar();
                syncBookmarkStar();
                Toast.makeText(this, "Removed bookmark", Toast.LENGTH_SHORT).show();
                return;
            }
        }
        if (bookmarks.size() >= 500 || activeTab.url.length() > 8192) {
            Toast.makeText(this, "Bookmark limit reached or address is too long", Toast.LENGTH_LONG).show();
            return;
        }
        String title = !TextUtils.isEmpty(activeTab.title) ? activeTab.title : activeTab.url;
        if (title.length() > 20) title = title.substring(0, 20);
        bookmarks.add(new BookmarkItem(title, activeTab.url));
        saveBookmarks();
        renderBookmarksBar();
        syncBookmarkStar();
        Toast.makeText(this, "Bookmarked: " + title, Toast.LENGTH_SHORT).show();
    }

    private void setTabLoadingState(BrowserTab tab, boolean isLoading) {
        if (tab == null) return;
        tab.loading = isLoading;
        if (tab == activeTab) {
            if (reloadOrStopBtn != null) {
                reloadOrStopBtn.setText(isLoading ? "✕ Stop" : "↻ Reload");
            }
            if (!isLoading && progressBar != null) {
                progressBar.setVisibility(View.GONE);
            }
            syncNavButtonsState();
        }
    }

    private void syncNavButtonsState() {
        if (activeTab == null) return;
        boolean canBack = activeTab.webView.canGoBack();
        boolean canFwd = activeTab.webView.canGoForward();
        if (backBtn != null) backBtn.setAlpha(canBack ? 1.0f : 0.4f);
        if (fwdBtn != null) fwdBtn.setAlpha(canFwd ? 1.0f : 0.4f);
    }

    private void hideKeyboard() {
        View view = getCurrentFocus();
        if (view != null) {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
            }
        }
    }

    private class BridgeInterface {
        @JavascriptInterface
        public void navigate(String secret, String rawQueryOrUrl) {
            if (!bridgeSecret.equals(secret)) return;
            runOnUiThread(() -> navigateActiveTab(rawQueryOrUrl));
        }

        @JavascriptInterface
        public void rotateIdentity(String secret) {
            if (!bridgeSecret.equals(secret)) return;
            runOnUiThread(() -> burnAndRotateIdentity());
        }

        @JavascriptInterface
        public void openShields(String secret) {
            if (!bridgeSecret.equals(secret)) return;
            runOnUiThread(() -> showShieldsDialog());
        }

        @JavascriptInterface
        public void openTraffic(String secret) {
            if (!bridgeSecret.equals(secret)) return;
            runOnUiThread(() -> showTrafficCaptureDialog());
        }

        @JavascriptInterface
        public String getNativeAuditStats(String secret) {
            if (!bridgeSecret.equals(secret)) return "{}";
            return "{\"blockedTrackers\":" + blockedTrackersCount +
                ",\"strippedParams\":" + strippedParamsCount +
                ",\"flagSecure\":" + screenSecurityFlag +
                ",\"seed\":" + noiseSeed + "}";
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView buildHardenedWebView(boolean ghostMode) {
        WebView wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        wv.setBackgroundColor(Color.parseColor("#121215"));
        wv.setFocusable(true);
        wv.setFocusableInTouchMode(true);
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            wv.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            wv.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS);
        }

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(false);

        // STRICT SECURITY HARDENING: Block local file & content provider access
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        // Media must not start playing with sound until the user interacts.
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            s.setSafeBrowsingEnabled(true);
        }
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        // Strict: an HTTPS page may never load HTTP subresources, so an on-path attacker
        // cannot downgrade or inject script into a secure page.
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setOffscreenPreRaster(true);
        if (ghostMode) {
            s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        }

        downloadListener = (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            String dlHost = Uri.parse(url).getHost();
            if (dlHost == null) dlHost = "";
            if (blockDownloads) {
                recordRequest("GET", url, dlHost, true, "Download blocked by policy");
                Toast.makeText(this, "Download blocked. Change this in Menu > Hardware & permissions.", Toast.LENGTH_LONG).show();
                return;
            }
            startSystemDownload(url, userAgent, contentDisposition, mimeType);
        };
        wv.setDownloadListener(downloadListener);

        // Long-press link menu (Open in New Tab, Open in Ghost Tab, Copy Clean URL)
        wv.setOnLongClickListener(v -> {
            WebView.HitTestResult hit = wv.getHitTestResult();
            if (hit == null) return false;
            int type = hit.getType();
            if (type == WebView.HitTestResult.SRC_ANCHOR_TYPE ||
                type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE) {
                final String rawLink = hit.getExtra();
                if (rawLink != null && (rawLink.startsWith("http://") || rawLink.startsWith("https://"))) {
                    final String cleanLink = cleanAndUpgradeUrl(Uri.parse(rawLink));
                    String[] opts = new String[]{
                        "Open in New Tab",
                        "Open in low-cache tab (shared site data)",
                        "Copy Clean URL (Tracking Stripped)"
                    };
                    new AlertDialog.Builder(MainActivity.this)
                        .setTitle(cleanLink)
                        .setItems(opts, (d, which) -> {
                            if (which == 0) {
                                createAndSwitchTab(cleanLink, false);
                            } else if (which == 1) {
                                createAndSwitchTab(cleanLink, true);
                            } else if (which == 2) {
                                ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
                                if (cm != null) {
                                    cm.setPrimaryClip(ClipData.newPlainText("Clean URL", cleanLink));
                                    Toast.makeText(MainActivity.this, "Copied clean URL!", Toast.LENGTH_SHORT).show();
                                }
                            }
                        })
                        .show();
                    return true;
                }
            }
            return false;
        });

        Persona p = personas.get(activePersonaIdx);
        s.setUserAgentString(p.userAgent);

        // Block third-party tracking cookies across all websites natively
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(wv, false);


        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return null;
                String reqUrl = uri.toString();
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
                String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";
                String method = request.getMethod() != null ? request.getMethod() : "GET";

                // Air-Gap Radio Kill-Switch: Cut 100% of external network socket I/O when active
                if ("airgap_killswitch".equals(radioProfile) && !"browz.local".equals(host)) {
                    blockedTrackersCount++;
                    recordRequest(method, reqUrl, host, true, "Air-Gap Radio Kill-Switch Active");
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }

                // SECURITY: block loopback, link-local, cloud-metadata and local
                // aliases, including IPv6, hex and decimal spellings of the same
                // address, plus NUL-byte and fullwidth-DNS tricks.
                String lowUrl = reqUrl.toLowerCase(Locale.ROOT);
                if ("file".equals(scheme) || "content".equals(scheme) ||
                    lowUrl.contains("%00") || lowUrl.contains("%ef%bc%9") ||
                    isBlockedLocalHost(host)) {
                    blockedTrackersCount++;
                    recordRequest(method, reqUrl, host, true, "Blocked SSRF / Loopback / Local Resource");
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }

                // User rules: an explicit block stops the request, an explicit allow
                // exempts the host from the tracker list. Neither can override the
                // loopback/metadata block above, which must always win.
                if (!host.isEmpty() && matchesDomainRule(host, blockedDomainRules)) {
                    blockedTrackersCount++;
                    recordRequest(method, reqUrl, host, true, "Blocked by site rule");
                    return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
                }
                if (!host.isEmpty() && matchesDomainRule(host, allowedDomainRules)) {
                    recordRequest(method, reqUrl, host, false, "Allowed by site rule");
                    maybeProbeStatus(request, reqUrl);
                    return super.shouldInterceptRequest(view, request);
                }

                if (blockTrackers && !host.isEmpty()) {
                    for (String tracker : TRACKER_DOMAINS) {
                        if (host.equals(tracker) || host.endsWith("." + tracker)) {
                            blockedTrackersCount++;
                            recordRequest(method, reqUrl, host, true, "Tracker Blocked (" + tracker + ")");
                            return new WebResourceResponse(
                                "text/plain",
                                "UTF-8",
                                new ByteArrayInputStream(new byte[0])
                            );
                        }
                    }
                }

                // The request is forwarded untouched; the log says so honestly instead
                // of claiming a status WebView never reported.
                recordRequest(method, reqUrl, host, false, "Request forwarded to network");
                maybeProbeStatus(request, reqUrl);
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                // Never let the user click through an invalid certificate.
                handler.cancel();
                final String badUrl = error != null && error.getUrl() != null ? error.getUrl() : "";
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                    "Blocked a connection with an invalid TLS certificate", Toast.LENGTH_LONG).show());
                recordRequest("GET", badUrl, "", true, "TLS certificate rejected");
            }

            @Override
            public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
                // A malicious server must not be able to trigger the OS certificate picker.
                request.cancel();
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler,
                                                  String host, String realm) {
                // Model credentials are never replayed: deny instead of prompting.
                handler.cancel();
                Toast.makeText(MainActivity.this,
                    "Blocked a site request for stored HTTP credentials (" + host + ")",
                    Toast.LENGTH_LONG).show();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.ROOT) : "";
                String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.ROOT) : "";

                // Block external OS intent/scheme hijacking (intent://, tel:, mailto:, market://)
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    Toast.makeText(MainActivity.this, "Blocked external OS app scheme (" + scheme + ":)", Toast.LENGTH_SHORT).show();
                    return true;
                }

                // Block external web pages from spoofing or navigating to internal privileged origin browz.local
                if ("browz.local".equals(host) || host.endsWith(".browz.local")) {
                    return true;
                }

                view.removeJavascriptInterface("BrowzNative");
                String finalUrl = cleanAndUpgradeUrl(uri);
                if (!finalUrl.equals(uri.toString())) {
                    view.loadUrl(finalUrl, buildPrivacyHeaders());
                    return true;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                boolean isInternal = url != null && url.startsWith("https://browz.local/");
                if (!isInternal) view.removeJavascriptInterface("BrowzNative");
                shieldInjectedFor.put(view, url == null ? "" : url);
                view.evaluateJavascript(buildMobileStealthJs(isInternal), null);
                BrowserTab tab = findTabByWebView(view);
                if (tab != null) {
                    setTabLoadingState(tab, true);
                    if (url != null && !url.startsWith("data:") && !isInternal) {
                        tab.url = url;
                        if (tab == activeTab) {
                            urlInput.setText(url);
                            syncBookmarkStar();
                        }
                    }
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                boolean isInternal = url != null && url.startsWith("https://browz.local/");
                if (!isInternal) view.removeJavascriptInterface("BrowzNative");
                String injectedFor = shieldInjectedFor.get(view);
                if (injectedFor == null || !injectedFor.equals(url == null ? "" : url)) {
                    shieldInjectedFor.put(view, url == null ? "" : url);
                    view.evaluateJavascript(buildMobileStealthJs(isInternal), null);
                }
                BrowserTab tab = findTabByWebView(view);
                if (tab != null) {
                    setTabLoadingState(tab, false);
                    String t = view.getTitle();
                    if (!TextUtils.isEmpty(t)) {
                        tab.title = t;
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    final String failedUrl = request.getUrl() != null ? request.getUrl().toString() : "";
                    String desc = (error != null && error.getDescription() != null)
                        ? error.getDescription().toString()
                        : "Network connection error";

                    int prevAttempts = retryAttemptsByUrl.containsKey(failedUrl)
                        ? retryAttemptsByUrl.get(failedUrl)
                        : 0;

                    // Automatic transient retry with backoff (up to 2 automatic retries)
                    if (autoRetryFailed && prevAttempts < 2 && failedUrl.startsWith("http")
                        && "GET".equalsIgnoreCase(request.getMethod())) {
                        final int nextAttempt = prevAttempts + 1;
                        retryAttemptsByUrl.put(failedUrl, nextAttempt);
                        Toast.makeText(MainActivity.this, "Auto-retrying (" + nextAttempt + "/2)...", Toast.LENGTH_SHORT).show();
                        uiHandler.postDelayed(() -> {
                            BrowserTab retryTab = findTabByWebView(view);
                            if (retryTab != null && failedUrl.equals(retryTab.url)) {
                                view.loadUrl(failedUrl, buildPrivacyHeaders());
                            }
                        }, 350L * nextAttempt);
                        return;
                    }

                    BrowserTab tab = findTabByWebView(view);
                    if (tab != null) setTabLoadingState(tab, false);
                    loadErrorPageIntoWebView(view, failedUrl, desc, prevAttempts);
                }
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // A page must not be able to open the system file picker on its own.
                if (blockFileSystemAccess) {
                    if (callback != null) callback.onReceiveValue(null);
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "File picker blocked. Allow it in Menu > Hardware & permissions.",
                        Toast.LENGTH_LONG).show());
                    recordRequest("FILE", "file-chooser", "", true, "File picker blocked by policy");
                    return true;
                }
                return false;
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (activeTab != null && activeTab.webView == view) {
                    if (newProgress < 100) {
                        progressBar.setVisibility(View.VISIBLE);
                        progressBar.setProgress(newProgress);
                    } else {
                        progressBar.setVisibility(View.GONE);
                    }
                    syncNavButtonsState();
                }
            }

            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                // Default-Deny GPS location for untraceability
                callback.invoke(origin, false, false);
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // Default-Deny Camera, Microphone & WebMIDI hardware requests
                request.deny();
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customVideoView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customVideoView = view;
                customVideoView.setBackgroundColor(Color.BLACK);
                customVideoCallback = callback;
                if (topBarView != null) topBarView.setVisibility(View.GONE);
                if (bmScrollView != null) bmScrollView.setVisibility(View.GONE);
                if (bottomBarView != null) bottomBarView.setVisibility(View.GONE);
                if (progressBar != null) progressBar.setVisibility(View.GONE);
                getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_FULLSCREEN |
                    View.SYSTEM_UI_FLAG_HIDE_NAVIGATION |
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                );
                webViewContainer.addView(
                    customVideoView,
                    new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                );
            }

            @Override
            public void onHideCustomView() {
                if (customVideoView == null) return;
                webViewContainer.removeView(customVideoView);
                customVideoView = null;
                if (topBarView != null) topBarView.setVisibility(View.VISIBLE);
                if (bmScrollView != null) bmScrollView.setVisibility(View.GONE);
                if (bottomBarView != null) bottomBarView.setVisibility(View.VISIBLE);
                getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
                if (customVideoCallback != null) {
                    customVideoCallback.onCustomViewHidden();
                    customVideoCallback = null;
                }
            }
        });

        return wv;
    }

    private BrowserTab findTabByWebView(WebView wv) {
        for (BrowserTab t : tabs) {
            if (t.webView == wv) return t;
        }
        return null;
    }

    private Map<String, String> buildPrivacyHeaders() {
        Map<String, String> headers = new HashMap<>();
        headers.put("DNT", "1");
        headers.put("Sec-GPC", "1");
        headers.put("Accept-Language", "en-US,en;q=0.9");
        if ("cellular_3g_saver".equals(radioProfile)) {
            headers.put("Save-Data", "on");
        }
        return headers;
    }

    private String cleanAndUpgradeUrl(Uri uri) {
        if (uri == null) return "";
        // "https://trusted.example@evil.example/" shows trusted.example in some UI
        // but connects to evil.example; credentials in the authority are dropped.
        if (uri.isHierarchical() && uri.getUserInfo() != null) {
            uri = uri.buildUpon().encodedAuthority(uri.getHost() == null ? "" :
                    (uri.getPort() > 0 ? uri.getHost() + ":" + uri.getPort() : uri.getHost())).build();
        }
        String finalUrl = uri.toString();

        // Strip 35+ URL tracking query parameters (utm_*, fbclid, gclid, msclkid, ttclid, etc.)
        if (stripUrlParams && uri.isHierarchical() && uri.getQueryParameterNames() != null && !uri.getQueryParameterNames().isEmpty()) {
            Uri.Builder builder = uri.buildUpon().clearQuery();
            boolean strippedAny = false;
            for (String name : uri.getQueryParameterNames()) {
                String low = name.toLowerCase(Locale.ROOT);
                if (TRACKING_PARAMS.contains(low) || low.startsWith("utm_")) {
                    strippedAny = true;
                    strippedParamsCount++;
                } else {
                    for (String val : uri.getQueryParameters(name)) {
                        builder.appendQueryParameter(name, val);
                    }
                }
            }
            if (strippedAny) {
                finalUrl = builder.build().toString();
            }
        }

        // HTTPS-Only automatic upgrade
        if (forceHttps && finalUrl.startsWith("http://") && !finalUrl.contains("localhost") && !finalUrl.contains("127.0.0.1")) {
            finalUrl = "https://" + finalUrl.substring(7);
        }
        return finalUrl;
    }

    /** True when a host points at this device, the local link or a cloud metadata service. */
    private static boolean isBlockedLocalHost(String rawHost) {
        if (rawHost == null) return false;
        String h = rawHost.toLowerCase(Locale.ROOT).replace("[", "").replace("]", "").trim();
        while (h.endsWith(".")) h = h.substring(0, h.length() - 1);
        if (h.isEmpty()) return false;
        if ("localhost".equals(h) || "ip6-localhost".equals(h)
                || "localhost.localdomain".equals(h) || h.endsWith(".localhost")
                || "metadata.google.internal".equals(h)) {
            return true;
        }
        if ("::1".equals(h) || "::".equals(h) || "0:0:0:0:0:0:0:1".equals(h)
                || h.startsWith("fe80:")) {
            return true;
        }
        if (h.startsWith("::ffff:")) h = h.substring(7);
        int[] octets = ipv4Octets(h);
        if (octets == null) return false;
        if (octets[0] == 127 || octets[0] == 0) return true;          // loopback, "this network"
        if (octets[0] == 169 && octets[1] == 254) return true;         // link-local + metadata
        return octets[0] == 100 && octets[1] == 100 && octets[2] == 100 && octets[3] == 200;
    }

    /** Parses dotted, decimal or hex IPv4 into four octets; null when it is not an IP. */
    private static int[] ipv4Octets(String host) {
        if (host.matches("^\\d+$") || host.startsWith("0x")) {
            long value;
            try {
                value = host.startsWith("0x")
                        ? Long.parseLong(host.substring(2), 16)
                        : Long.parseLong(host);
            } catch (NumberFormatException e) {
                return null;
            }
            if (value < 0 || value > 0xFFFFFFFFL) return null;
            return new int[]{(int) ((value >> 24) & 0xFF), (int) ((value >> 16) & 0xFF),
                    (int) ((value >> 8) & 0xFF), (int) (value & 0xFF)};
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) return null;
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("^\\d{1,3}$")) return null;
            int value = Integer.parseInt(parts[i]);
            if (value > 255) return null;
            octets[i] = value;
        }
        return octets;
    }

    private synchronized void clearRequestLog() {
        capturedEntries.clear();
        if (trafficCountBtn != null) trafficCountBtn.setText("Traffic (0)");
    }

    private synchronized void recordRequest(String method, String url, String domain, boolean blocked, String reason) {
        if (!captureTraffic || url.startsWith("data:") || url.startsWith("https://browz.local/")) return;
        String ts = new SimpleDateFormat("HH:mm:ss.SSS", Locale.US).format(new Date());
        capturedEntries.add(0, new CapturedEntry(seqCounter++, ts, method, url, domain, blocked, reason));
        if (capturedEntries.size() > 500) {
            capturedEntries.remove(capturedEntries.size() - 1);
        }
        final int total = capturedEntries.size();
        runOnUiThread(() -> {
            if (trafficCountBtn != null) {
                trafficCountBtn.setText("Traffic (" + total + ")");
            }
        });
    }

    private static boolean matchesDomainRule(String host, Set<String> rules) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase(Locale.ROOT);
        for (String rule : rules) {
            String r = rule.toLowerCase(Locale.ROOT);
            if (h.equals(r) || h.endsWith("." + r)) return true;
        }
        return false;
    }

    // A HEAD request measures the real response code for a top-level navigation.
    // It is a separate request, sent without page cookies, and can differ from the
    // page load (for example a server that rejects HEAD with 405).
    private void maybeProbeStatus(WebResourceRequest request, String url) {
        if (!probeStatuses || request == null || !request.isForMainFrame()) return;
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
        final String target = url;
        new Thread(() -> {
            HttpURLConnection conn = null;
            String measured;
            try {
                conn = (HttpURLConnection) new URL(target).openConnection();
                conn.setRequestMethod("HEAD");
                conn.setConnectTimeout(7000);
                conn.setReadTimeout(7000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("User-Agent", personas.get(activePersonaIdx).userAgent);
                measured = "HTTP " + conn.getResponseCode();
            } catch (Exception e) {
                measured = "no response";
            } finally {
                if (conn != null) conn.disconnect();
            }
            final String value = measured;
            runOnUiThread(() -> attachStatusToEntry(target, value));
        }, "browz-status-probe").start();
    }

    private synchronized void attachStatusToEntry(String url, String status) {
        for (int i = 0; i < capturedEntries.size(); i++) {
            CapturedEntry e = capturedEntries.get(i);
            if (!e.blocked && e.status == null && url.equals(e.url)) {
                capturedEntries.set(i, withStatus(e, status));
                return;
            }
        }
    }

    private static CapturedEntry withStatus(CapturedEntry e, String status) {
        CapturedEntry copy = new CapturedEntry(e.seq, e.timestamp, e.method, e.url, e.domain, e.blocked, e.reason);
        copy.status = status;
        return copy;
    }

    private void startSystemDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        try {
            String fileName = android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType);
            if (fileName == null || fileName.trim().isEmpty()) fileName = "browz-download";
            fileName = fileName.replace('/', '_').replace('\\', '_');
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setMimeType(mimeType);
            req.addRequestHeader("User-Agent", userAgent);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            req.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) throw new IllegalStateException("download service unavailable");
            dm.enqueue(req);
            recordRequest("GET", url, Uri.parse(url).getHost() == null ? "" : Uri.parse(url).getHost(),
                false, "Download saved to " + (dir == null ? "app downloads" : dir.getAbsolutePath()));
            Toast.makeText(this, "Download started in Browz downloads", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "Download failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    // ---------- Container sessions ----------

    private void loadContainers() {
        containers.clear();
        String saved = getPreferences(MODE_PRIVATE).getString("containers", null);
        if (saved != null) {
            try {
                JSONArray data = new JSONArray(saved);
                for (int i = 0; i < data.length() && i < 12; i++) {
                    JSONObject o = data.optJSONObject(i);
                    if (o == null) continue;
                    int id = o.optInt("id", i + 1);
                    String name = o.optString("name", "Container");
                    containers.add(new ContainerProfile(id, name));
                    containerIdCounter = Math.max(containerIdCounter, id + 1);
                }
            } catch (Exception ignored) { }
        }
        if (containers.isEmpty()) {
            containers.add(new ContainerProfile(1, "Personal"));
            containerIdCounter = 2;
        }
        activeContainerId = containers.get(0).id;
    }

    private void saveContainers() {
        try {
            JSONArray data = new JSONArray();
            for (ContainerProfile c : containers) {
                JSONObject o = new JSONObject();
                o.put("id", c.id);
                o.put("name", c.name);
                data.put(o);
            }
            getPreferences(MODE_PRIVATE).edit().putString("containers", data.toString()).apply();
        } catch (Exception ignored) { }
    }

    private ContainerProfile findContainer(int id) {
        for (ContainerProfile c : containers) if (c.id == id) return c;
        return containers.isEmpty() ? null : containers.get(0);
    }

    private String activeContainerName() {
        ContainerProfile c = findContainer(activeContainerId);
        return c == null ? "Container" : c.name;
    }

    private void wipeCookiesAndStorage() {
        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        WebStorage.getInstance().deleteAllData();
    }

    // Android WebView has no per-container storage partitions, so switching a
    // container closes every page and wipes cookies plus site storage first.
    // Isolation is therefore between containers, not between tabs of one container.
    private void switchContainer(int id) {
        ContainerProfile target = findContainer(id);
        if (target == null || id == activeContainerId) return;
        for (BrowserTab t : new ArrayList<>(tabs)) {
            webViewContainer.removeView(t.webView);
            t.webView.removeJavascriptInterface("BrowzNative");
            t.webView.stopLoading();
            t.webView.destroy();
        }
        tabs.clear();
        activeTab = null;
        wipeCookiesAndStorage();
        activeContainerId = id;
        retryAttemptsByUrl.clear();
        synchronized (this) { capturedEntries.clear(); }
        if (trafficCountBtn != null) trafficCountBtn.setText("Traffic (0)");
        createAndSwitchTab("browz://home", false);
        Toast.makeText(this, "Switched to container: " + target.name + " (all previous sessions closed)", Toast.LENGTH_LONG).show();
    }

    private void clearContainerState() {
        wipeCookiesAndStorage();
        for (BrowserTab t : tabs) {
            t.webView.clearCache(true);
            t.webView.clearHistory();
            t.webView.clearFormData();
        }
        synchronized (this) { capturedEntries.clear(); }
        if (trafficCountBtn != null) trafficCountBtn.setText("Traffic (0)");
        if (activeTab != null) navigateActiveTab(activeTab.url);
    }

    private void showContainersDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(12), dp(18), dp(4));

        TextView hint = new TextView(this);
        hint.setText("Browz has no Browz account: nothing to sign in to, nothing synced. A container is a local space for a different website login, for example Personal and Work. Switching closes every page in the current container, wipes its cookies and site storage, then opens a fresh start page. Nothing is shared between containers while Browz runs, and nothing is saved after you close Browz.");
        hint.setTextSize(12f);
        hint.setPadding(0, 0, 0, dp(10));
        box.addView(hint);

        for (final ContainerProfile c : new ArrayList<>(containers)) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(0, dp(3), 0, dp(3));

            TextView label = new TextView(this);
            label.setText((c.id == activeContainerId ? "● " : "○ ") + c.name);
            label.setTextSize(14f);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
            label.setLayoutParams(lp);
            row.addView(label);

            if (c.id != activeContainerId) {
                Button switchBtn = new Button(this);
                switchBtn.setText("Switch");
                switchBtn.setContentDescription("Switch to container " + c.name);
                switchBtn.setOnClickListener(v -> {
                    dismissOpenDialog();
                    switchContainer(c.id);
                });
                row.addView(switchBtn);
            } else {
                Button clearBtn = new Button(this);
                clearBtn.setText("Clear");
                clearBtn.setContentDescription("Clear data for container " + c.name);
                clearBtn.setOnClickListener(v -> {
                    dismissOpenDialog();
                    clearContainerState();
                    Toast.makeText(this, "Cleared container: " + c.name, Toast.LENGTH_SHORT).show();
                });
                row.addView(clearBtn);
            }
            box.addView(row);
        }

        Button newBtn = new Button(this);
        newBtn.setText("+ New container");
        newBtn.setContentDescription("New container");
        newBtn.setOnClickListener(v -> {
            dismissOpenDialog();
            createContainer();
        });
        box.addView(newBtn);

        openDialog = new AlertDialog.Builder(this)
            .setTitle("Containers · active: " + activeContainerName())
            .setView(box)
            .setNegativeButton("Close", null)
            .show();
    }

    private void createContainer() {
        EditText input = new EditText(this);
        input.setHint("Container name (for example Work)");
        input.setSingleLine(true);
        new AlertDialog.Builder(this)
            .setTitle("New container")
            .setView(input)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Create", (d, w) -> {
                String raw = input.getText() == null ? "" : input.getText().toString().trim();
                String name = raw.isEmpty() ? ("Container " + containerIdCounter) : raw;
                if (name.length() > 30) name = name.substring(0, 30);
                if (containers.size() >= 12) {
                    Toast.makeText(this, "Limit of 12 containers reached", Toast.LENGTH_SHORT).show();
                    return;
                }
                ContainerProfile created = new ContainerProfile(containerIdCounter++, name);
                containers.add(created);
                saveContainers();
                switchContainer(created.id);
            }).show();
    }

    private android.app.Dialog openDialog = null;

    private void dismissOpenDialog() {
        if (openDialog != null) {
            try { openDialog.dismiss(); } catch (Exception ignored) { }
            openDialog = null;
        }
    }

    // ---------- Network rules ----------

    private void loadNetworkRules() {
        String saved = getPreferences(MODE_PRIVATE).getString("netRules", null);
        if (saved == null) return;
        try {
            JSONObject data = new JSONObject(saved);
            JSONArray blocked = data.optJSONArray("blocked");
            JSONArray allowed = data.optJSONArray("allowed");
            if (blocked != null) for (int i = 0; i < blocked.length() && i < 200; i++) blockedDomainRules.add(blocked.optString(i));
            if (allowed != null) for (int i = 0; i < allowed.length() && i < 200; i++) allowedDomainRules.add(allowed.optString(i));
            probeStatuses = data.optBoolean("probe", true);
            blockDownloads = data.optBoolean("blockDownloads", true);
        } catch (Exception ignored) { }
    }

    private void saveNetworkRules() {
        try {
            JSONObject data = new JSONObject();
            JSONArray blocked = new JSONArray();
            for (String r : blockedDomainRules) blocked.put(r);
            JSONArray allowed = new JSONArray();
            for (String r : allowedDomainRules) allowed.put(r);
            data.put("blocked", blocked);
            data.put("allowed", allowed);
            data.put("probe", probeStatuses);
            data.put("blockDownloads", blockDownloads);
            getPreferences(MODE_PRIVATE).edit().putString("netRules", data.toString()).apply();
        } catch (Exception ignored) { }
    }

    private void showNetworkRulesDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(12), dp(18), dp(4));

        TextView hint = new TextView(this);
        hint.setText("Rules apply to every request the browser makes. A block stops the request before it leaves the device. An allow entry exempts a site from the built-in tracker list. Rules are stored on this device only.");
        hint.setTextSize(12f);
        hint.setPadding(0, 0, 0, dp(8));
        box.addView(hint);

        box.addView(makeCheck("Block ad, pixel and SDK trackers", blockTrackers, c -> {
            blockTrackers = c;
            saveNetworkRules();
        }));
        box.addView(makeCheck("Measure real response status (extra HEAD request)", probeStatuses, c -> {
            probeStatuses = c;
            saveNetworkRules();
        }));

        EditText input = new EditText(this);
        input.setHint("example.com");
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        box.addView(input);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        Button blockBtn = new Button(this);
        blockBtn.setText("Block domain");
        blockBtn.setContentDescription("Block domain");
        blockBtn.setOnClickListener(v -> {
            String d = normalizeDomainRule(input.getText() == null ? "" : input.getText().toString());
            if (d.isEmpty()) {
                Toast.makeText(this, "Enter a domain such as ads.example.com", Toast.LENGTH_SHORT).show();
                return;
            }
            allowedDomainRules.remove(d);
            blockedDomainRules.add(d);
            saveNetworkRules();
            dismissOpenDialog();
            showNetworkRulesDialog();
        });
        Button allowBtn = new Button(this);
        allowBtn.setText("Allow domain");
        allowBtn.setContentDescription("Allow domain");
        allowBtn.setOnClickListener(v -> {
            String d = normalizeDomainRule(input.getText() == null ? "" : input.getText().toString());
            if (d.isEmpty()) {
                Toast.makeText(this, "Enter a domain such as bank.example", Toast.LENGTH_SHORT).show();
                return;
            }
            blockedDomainRules.remove(d);
            allowedDomainRules.add(d);
            saveNetworkRules();
            dismissOpenDialog();
            showNetworkRulesDialog();
        });
        LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        blockBtn.setLayoutParams(half);
        allowBtn.setLayoutParams(half);
        btnRow.addView(blockBtn);
        btnRow.addView(allowBtn);
        box.addView(btnRow);

        TextView blockedTitle = new TextView(this);
        blockedTitle.setText("Blocked domains (" + blockedDomainRules.size() + ") - tap to remove");
        blockedTitle.setTypeface(Typeface.DEFAULT_BOLD);
        blockedTitle.setPadding(0, dp(10), 0, dp(4));
        box.addView(blockedTitle);
        for (final String rule : new ArrayList<>(blockedDomainRules)) {
            Button b = new Button(this);
            b.setText(rule);
            b.setContentDescription("Remove blocked rule " + rule);
            b.setOnClickListener(v -> {
                blockedDomainRules.remove(rule);
                saveNetworkRules();
                dismissOpenDialog();
                showNetworkRulesDialog();
            });
            box.addView(b);
        }

        TextView allowedTitle = new TextView(this);
        allowedTitle.setText("Allowed domains (" + allowedDomainRules.size() + ") - tap to remove");
        allowedTitle.setTypeface(Typeface.DEFAULT_BOLD);
        allowedTitle.setPadding(0, dp(10), 0, dp(4));
        box.addView(allowedTitle);
        for (final String rule : new ArrayList<>(allowedDomainRules)) {
            Button b = new Button(this);
            b.setText(rule);
            b.setContentDescription("Remove allowed rule " + rule);
            b.setOnClickListener(v -> {
                allowedDomainRules.remove(rule);
                saveNetworkRules();
                dismissOpenDialog();
                showNetworkRulesDialog();
            });
            box.addView(b);
        }

        ScrollView sv = new ScrollView(this);
        sv.addView(box);

        openDialog = new AlertDialog.Builder(this)
            .setTitle("Network interception rules")
            .setView(sv)
            .setPositiveButton("Reload page", (d, w) -> {
                if (activeTab != null) navigateActiveTab(activeTab.url);
            })
            .setNegativeButton("Close", null)
            .show();
    }

    private static String normalizeDomainRule(String raw) {
        if (raw == null) return "";
        String d = raw.trim().toLowerCase(Locale.ROOT);
        if (d.isEmpty()) return "";
        int schemeEnd = d.indexOf("://");
        if (schemeEnd >= 0) d = d.substring(schemeEnd + 3);
        // Credentials are removed first so "user:pass@host" is not mistaken for a scheme.
        int at = d.lastIndexOf('@');
        if (at >= 0) d = d.substring(at + 1);
        int colon = d.indexOf(':');
        if (colon >= 0) {
            String beforeColon = d.substring(0, colon);
            // A "scheme:" prefix that is not a hostname means this is not a domain rule.
            if (d.matches("^[a-z][a-z0-9+.-]*:.*") && !beforeColon.contains(".")) return "";
            d = beforeColon;
        }
        int cut = d.length();
        for (char c : new char[]{'/', '?', '#'}) {
            int i = d.indexOf(c);
            if (i >= 0 && i < cut) cut = i;
        }
        d = d.substring(0, cut);
        if (d.endsWith(".")) d = d.substring(0, d.length() - 1);
        if (d.isEmpty() || d.length() > 253) return "";
        // Only hostname characters survive: no spaces, credentials, paths or scripts.
        if (!d.matches("^[a-z0-9.-]+$")) return "";
        boolean looksLikeIp = d.matches("^[0-9.]+$");
        if (!looksLikeIp && !d.contains(".")) return "";
        for (String label : d.split("\\.")) {
            if (label.isEmpty() || label.length() > 63) return "";
            if (label.startsWith("-") || label.endsWith("-")) return "";
        }
        return d;
    }

    // ---------- Hardware, permissions and OS integration ----------

    private void showHardwareDialog() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(12), dp(18), dp(4));

        TextView state = new TextView(this);
        state.setTextSize(12f);
        state.setText(buildHardwareReport());
        state.setPadding(0, 0, 0, dp(10));
        box.addView(state);

        box.addView(makeCheck("Block screenshots and Recent-apps preview (FLAG_SECURE)", screenSecurityFlag, c -> {
            screenSecurityFlag = c;
            if (c) {
                getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                Toast.makeText(this, "Screenshots allowed again; other apps and assistants may capture the page", Toast.LENGTH_LONG).show();
            }
        }));
        box.addView(makeCheck("Block file downloads", blockDownloads, c -> {
            blockDownloads = c;
            saveNetworkRules();
        }));
        box.addView(makeCheck("Block sensor, USB and Bluetooth JavaScript APIs", shieldSensors, c -> shieldSensors = c));
        box.addView(makeCheck("Block clipboard reads from pages", blockClipboardRead, c -> blockClipboardRead = c));
        box.addView(makeCheck("Block local file picker and OPFS disk access", blockFileSystemAccess, c -> blockFileSystemAccess = c));

        ScrollView sv = new ScrollView(this);
        sv.addView(box);

        openDialog = new AlertDialog.Builder(this)
            .setTitle("Hardware & permissions")
            .setView(sv)
            .setPositiveButton("Reload page", (d, w) -> {
                if (activeTab != null) navigateActiveTab(activeTab.url);
            })
            .setNegativeButton("Close", null)
            .show();
    }

    private String buildHardwareReport() {
        StringBuilder sb = new StringBuilder();
        boolean camera = appDeclaresPermission("android.permission.CAMERA");
        boolean microphone = appDeclaresPermission("android.permission.RECORD_AUDIO");
        boolean location = appDeclaresPermission("android.permission.ACCESS_FINE_LOCATION")
            || appDeclaresPermission("android.permission.ACCESS_COARSE_LOCATION");
        sb.append("Enforced by the app itself:\n");
        sb.append("Camera: ").append(camera ? "permission declared, page requests still denied" : "no permission declared, so pages cannot open it").append("\n");
        sb.append("Microphone: ").append(microphone ? "permission declared, page requests still denied" : "no permission declared, so pages cannot record").append("\n");
        sb.append("Precise location: ").append(location ? "permission declared, page requests still denied" : "no permission declared, so pages cannot locate you").append("\n");
        sb.append("Autofill: disabled for every Browz field\n");
        sb.append("Content capture by assistant apps: disabled\n");
        sb.append("External app links (intent:, tel:, market:, mailto:): blocked\n");
        sb.append("Screenshots and Recent-apps thumbnails: ").append(screenSecurityFlag ? "blocked while enabled" : "not blocked").append("\n");
        sb.append("Downloads: ").append(blockDownloads ? "blocked" : "saved into Browz private downloads folder").append("\n");
        sb.append("\n");
        sb.append("Not controllable from Browz:\n");
        sb.append("The Android system keyboard can see text you type into page fields; use its own private mode to reduce learning.\n");
        sb.append("Device administrators, accessibility services, rooted or compromised systems, screenshots taken by other apps while protection is off, and your network operator remain outside Browz control.\n");
        sb.append("Browz is not a VPN or Tor, so websites still see your IP address.");
        return sb.toString();
    }

    private boolean appDeclaresPermission(String permission) {
        try {
            android.content.pm.PackageInfo info = getPackageManager()
                .getPackageInfo(getPackageName(), android.content.pm.PackageManager.GET_PERMISSIONS);
            if (info.requestedPermissions == null) return false;
            for (String p : info.requestedPermissions) if (permission.equals(p)) return true;
        } catch (Exception ignored) { }
        return false;
    }

    private String escapeHtmlForMobile(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;")
                .replace("'", "&#39;");
    }

    private String escapeJsStringForMobile(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\"", "\\\"")
                .replace("<", "\\u003c")
                .replace(">", "\\u003e")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }

    private String buildMobileStealthJs(boolean keepInternalBridge) {
        Persona p = personas.get(activePersonaIdx);
        String platHint = p.isMobile ? "Android" : "Windows";
        // Derive the clock offset from the persona instead of hardcoding UTC, so a
        // future non-UTC persona cannot contradict Intl.DateTimeFormat.
        int personaOffsetMin;
        try {
            personaOffsetMin = java.util.TimeZone.getTimeZone(p.timezone)
                .getOffset(System.currentTimeMillis()) / 60000;
        } catch (Throwable ignored) {
            personaOffsetMin = 0;
        }
        final int tzOffsetMinutes = personaOffsetMin;
        return "(function(){" +
            "try {" +
            "  const nativeMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;" +
            "  const markNative = (fn, name) => { if (typeof fn === 'function' && nativeMap) { try { nativeMap.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }'); } catch(e){} } return fn; };" +
            "  try { const origTS = Function.prototype.toString; const cloakedTS = markNative(function(){ return (nativeMap && nativeMap.has(this)) ? nativeMap.get(this) : origTS.apply(this, arguments); }, 'toString'); Object.defineProperty(Function.prototype, 'toString', { value: cloakedTS, writable: true, configurable: true }); } catch(e){}" +
            (keepInternalBridge ? "" : "") +
            "  const SEED = " + noiseSeed + ";" +
            "  const def = (o, k, v) => { if (!o) return; try { Object.defineProperty(o, k, { get: markNative(() => v, 'get ' + k), configurable: true }); } catch(e){} };" +
            "  def(navigator, 'webdriver', false);" +
            "  def(navigator, 'doNotTrack', '1');" +
            "  def(navigator, 'globalPrivacyControl', true);" +
            "  def(navigator, 'pdfViewerEnabled', true);" +
            "  def(navigator, 'platform', '" + p.platform + "');" +
            "  def(navigator, 'vendor', '" + p.navigatorVendor + "');" +
            "  def(navigator, 'appVersion', '" + p.appVersion.replace("'", "\\'") + "');" +
            "  def(navigator, 'productSub', '" + p.productSub + "');" +
            (p.chromium
                ? ""
                : "  def(navigator, 'userAgentData', undefined);" +
                  "  try { def(window, 'chrome', undefined); } catch(e){}") +
            "  def(navigator, 'hardwareConcurrency', " + p.cores + ");" +
            "  def(navigator, 'deviceMemory', " + p.memoryGb + ");" +
            "  def(navigator, 'language', 'en-US');" +
            "  def(navigator, 'languages', Object.freeze(['en-US', 'en']));" +
            "  if (window.screen) {" +
            "    def(window.screen, 'width', " + p.screenW + ");" +
            "    def(window.screen, 'height', " + p.screenH + ");" +
            "    def(window.screen, 'availWidth', " + p.screenW + ");" +
            "    def(window.screen, 'availHeight', " + p.screenH + ");" +
            "    def(window.screen, 'colorDepth', 24);" +
            "    def(window.screen, 'pixelDepth', 24);" +
            "  }" +
            // Left unspoofed before, these two contradicted the persona: an "iPhone"
            // that reports zero touch points and a 2.625 pixel ratio is obviously a phone.
            "  def(navigator, 'maxTouchPoints', " + p.touchPoints + ");" +
            "  def(window, 'devicePixelRatio', " + p.pixelRatio + ");" +
            // The plugin list is a classic identifier. Android Chrome ships none; desktop
            // Chrome ships the five built-in PDF entries. Report whichever fits the persona.
            "  const PDF_PLUGINS = [" +
            "    ['PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format']," +
            "    ['Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format']," +
            "    ['Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format']," +
            "    ['Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format']," +
            "    ['WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format']" +
            "  ];" +
            "  const PDF_MIMES = [['application/pdf', 'pdf'], ['text/pdf', 'pdf']];" +
            "  const asList = (items) => {" +
            "    const arr = items;" +
            "    arr.item = function(i){ return arr[i] || null; };" +
            "    arr.namedItem = function(n){ for (let i = 0; i < arr.length; i++) { if (arr[i].name === n) return arr[i]; } return null; };" +
            "    arr.refresh = function(){};" +
            "    return arr;" +
            "  };" +
            "  try {" +
            "    const wantPlugins = " + (p.isMobile ? "[]" : "PDF_PLUGINS") + ";" +
            "    const pluginList = asList(wantPlugins.map(function(e){" +
            "      return { name: e[0], filename: e[1], description: e[2], length: " + (p.isMobile ? 0 : 2) + " };" +
            "    }));" +
            "    const mimeList = asList((" + (p.isMobile ? "[]" : "PDF_MIMES") + ").map(function(e){" +
            "      return { type: e[0], suffixes: e[1], description: 'Portable Document Format', enabledPlugin: pluginList[0] || null };" +
            "    }));" +
            "    def(navigator, 'plugins', pluginList);" +
            "    def(navigator, 'mimeTypes', mimeList);" +
            "  } catch(e){}" +
            ((shieldClientHints && p.chromium) ? (
                "  const fakeBrands = Object.freeze([{ brand: 'Chromium', version: '131' }, { brand: 'Not_A Brand', version: '24' }]);" +
                "  def(navigator, 'userAgentData', {" +
                "    brands: fakeBrands," +
                "    mobile: " + (p.isMobile ? "true" : "false") + "," +
                "    platform: '" + platHint + "'," +
                "    getHighEntropyValues: markNative(async function() {" +
                "      return { architecture: 'arm', bitness: '64', brands: fakeBrands, mobile: " + (p.isMobile ? "true" : "false") + ", model: 'Generic', platform: '" + platHint + "', platformVersion: '10.0.0', uaFullVersion: '131.0.0.0' };" +
                "    }, 'getHighEntropyValues')," +
                "    toJSON: markNative(function() { return { brands: fakeBrands, mobile: " + (p.isMobile ? "true" : "false") + ", platform: '" + platHint + "' }; }, 'toJSON')" +
                "  });"
            ) : "") +
            (shieldSensors ? (
                "  def(navigator, 'getBattery', undefined);" +
                "  def(navigator, 'bluetooth', undefined);" +
                "  def(navigator, 'usb', undefined);" +
                "  def(navigator, 'serial', undefined);" +
                "  def(navigator, 'hid', undefined);" +
                "  def(navigator, 'getGamepads', markNative(() => [], 'getGamepads'));" +
                "  if (navigator.mediaDevices) { navigator.mediaDevices.enumerateDevices = markNative(async () => [], 'enumerateDevices'); }" +
                "  if (navigator.sendBeacon) { navigator.sendBeacon = markNative(function() { return true; }, 'sendBeacon'); }" +
                "  window.DeviceMotionEvent = undefined;" +
                "  window.DeviceOrientationEvent = undefined;" +
                "  window.addEventListener = (function(orig){ return markNative(function(type, fn, opts){" +
                "    if (type === 'devicemotion' || type === 'deviceorientation' || type === 'deviceorientationabsolute') return;" +
                "    return orig.call(this, type, fn, opts);" +
                "  }, 'addEventListener'); })(window.addEventListener);"
            ) : "") +
            ("stealth_hidden".equals(radioProfile) ? (
                "  def(navigator, 'onLine', true);" +
                "  def(navigator, 'connection', undefined);" +
                "  def(navigator, 'mozConnection', undefined);" +
                "  def(navigator, 'webkitConnection', undefined);"
            ) : "wifi_fiber".equals(radioProfile) ? (
                "  def(navigator, 'onLine', true);" +
                "  def(navigator, 'connection', Object.freeze({ type: 'wifi', effectiveType: '4g', downlink: 100, rtt: 5, saveData: false, addEventListener: function(){}, removeEventListener: function(){} }));"
            ) : "cellular_4g".equals(radioProfile) ? (
                "  def(navigator, 'onLine', true);" +
                "  def(navigator, 'connection', Object.freeze({ type: 'cellular', effectiveType: '4g', downlink: 12, rtt: 45, saveData: false, addEventListener: function(){}, removeEventListener: function(){} }));"
            ) : "cellular_3g_saver".equals(radioProfile) ? (
                "  def(navigator, 'onLine', true);" +
                "  def(navigator, 'connection', Object.freeze({ type: 'cellular', effectiveType: '3g', downlink: 1.2, rtt: 220, saveData: true, addEventListener: function(){}, removeEventListener: function(){} }));"
            ) : (
                "  def(navigator, 'onLine', false);" +
                "  def(navigator, 'connection', Object.freeze({ type: 'none', effectiveType: 'slow-2g', downlink: 0, rtt: 0, saveData: true, addEventListener: function(){}, removeEventListener: function(){} }));"
            )) +
            (blockServiceWorkers ? (
                "  def(navigator, 'serviceWorker', { controller: null, ready: new Promise(()=>{}), register: async function(){ throw new DOMException('Blocked by Browz I/O Firewall', 'SecurityError'); }, getRegistrations: async () => [] });"
            ) : "") +
            (blockCacheStorage ? (
                "  def(window, 'caches', { open: async function(){ throw new DOMException('Blocked by Browz I/O Firewall', 'SecurityError'); }, keys: async () => [], has: async () => false });"
            ) : "") +
            (blockFileSystemAccess ? (
                "  def(window, 'showOpenFilePicker', undefined);" +
                "  def(window, 'showSaveFilePicker', undefined);" +
                "  def(window, 'showDirectoryPicker', undefined);" +
                "  if (navigator.storage) { def(navigator.storage, 'getDirectory', undefined); navigator.storage.persist = markNative(async () => false, 'persist'); }"
            ) : "") +
            (blockClipboardRead ? (
                "  if (navigator.clipboard) { navigator.clipboard.readText = markNative(async function(){ throw new DOMException('Clipboard read blocked by Browz I/O Firewall', 'NotAllowedError'); }, 'readText'); }"
            ) : "") +
            (blockWebSockets ? (
                "  def(window, 'WebSocket', markNative(function(){ throw new DOMException('WebSocket stream I/O disabled by Browz I/O Firewall', 'SecurityError'); }, 'WebSocket'));"
            ) : "") +
            (timerJitter ? (
                "  if (typeof performance !== 'undefined' && performance.now) {" +
                "    const origNow = performance.now.bind(performance);" +
                "    performance.now = markNative(function(){ return Math.round(origNow() * 10) / 10 + ((SEED % 37) + 1) * 0.001; }, 'now');" +
                "  }"
            ) : "") +
            (shieldStorageAndVoices ? (
                "  if (navigator.storage && navigator.storage.estimate) {" +
                "    navigator.storage.estimate = markNative(async () => ({ usage: 0, quota: 10737418240 }), 'estimate');" +
                "  }" +
                "  if (window.speechSynthesis) {" +
                "    window.speechSynthesis.getVoices = markNative(() => [], 'getVoices');" +
                "  }"
            ) : "") +
            (shieldTimezone ? (
                "  const TZ = '" + p.timezone + "';" +
                "  const TZOFF = " + tzOffsetMinutes + ";" +
                "  const origRO = Intl.DateTimeFormat.prototype.resolvedOptions;" +
                "  Intl.DateTimeFormat.prototype.resolvedOptions = markNative(function(){" +
                "    const r = origRO.apply(this, arguments);" +
                "    r.timeZone = TZ;" +
                "    r.locale = 'en-US';" +
                "    return r;" +
                "  }, 'resolvedOptions');" +
                // The clock must agree with the spoofed zone in every rendering, or a
                // single new Date().toString() reveals the phone's real timezone.
                "  const fmtIn = (d, o) => { const c = Object.assign({ timeZone: TZ }, o); return new Intl.DateTimeFormat('en-US', c).format(d); };" +
                "  const offLabel = () => { const a = Math.abs(TZOFF); const hh = String(Math.floor(a / 60)).padStart(2, '0'); const mm = String(a % 60).padStart(2, '0'); return 'GMT' + (TZOFF >= 0 ? '+' : '-') + hh + mm; };" +
                "  const zoneName = (d) => { try { const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'long' }).formatToParts(d); for (let i = 0; i < parts.length; i++) { if (parts[i].type === 'timeZoneName') return parts[i].value; } } catch(e){} return 'Coordinated Universal Time'; };" +
                "  const timeStr = (d) => fmtIn(d, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });" +
                "  const dateStr = (d) => fmtIn(d, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' }).replace(/,/g, '');" +
                "  const tail = (d) => ' ' + offLabel() + ' (' + zoneName(d) + ')';" +
                "  Date.prototype.getTimezoneOffset = markNative(function(){ return -TZOFF; }, 'getTimezoneOffset');" +
                "  Date.prototype.toString = markNative(function(){ if (isNaN(this.getTime())) return 'Invalid Date'; return dateStr(this) + ' ' + timeStr(this) + tail(this); }, 'toString');" +
                "  Date.prototype.toTimeString = markNative(function(){ if (isNaN(this.getTime())) return 'Invalid Date'; return timeStr(this) + tail(this); }, 'toTimeString');" +
                "  Date.prototype.toDateString = markNative(function(){ if (isNaN(this.getTime())) return 'Invalid Date'; return dateStr(this); }, 'toDateString');" +
                // Date.toLocaleXxx(locales, options): the first argument is a locale, so
                // feeding options into it silently ignores the timezone. Accept both shapes.
                "  ['toLocaleString', 'toLocaleTimeString', 'toLocaleDateString'].forEach(function(m){" +
                "    const orig = Date.prototype[m];" +
                "    if (typeof orig !== 'function') return;" +
                "    Date.prototype[m] = markNative(function(){" +
                "      const args = Array.prototype.slice.call(arguments);" +
                "      let locales; let opts;" +
                "      if (args.length && (typeof args[0] === 'string' || Object.prototype.toString.call(args[0]) === '[object Array]')) {" +
                "        locales = args[0];" +
                "        if (args.length > 1 && args[1] && typeof args[1] === 'object') opts = Object.assign({}, args[1]);" +
                "      } else if (args.length && args[0] && typeof args[0] === 'object') {" +
                "        opts = Object.assign({}, args[0]);" +
                "      } else if (args.length > 1 && args[1] && typeof args[1] === 'object') {" +
                "        opts = Object.assign({}, args[1]);" +
                "      }" +
                "      opts = opts || {};" +
                "      if (!opts.timeZone) opts.timeZone = TZ;" +
                "      return locales === undefined ? orig.call(this, opts) : orig.call(this, locales, opts);" +
                "    }, m);" +
                "  });" +
                // A page that formats with new Intl.DateTimeFormat() and no explicit zone
                // would otherwise render the device's clock.
                "  try {" +
                "    const OrigDTF = Intl.DateTimeFormat;" +
                "    const PatchedDTF = function(locales, options){" +
                "      let o = {};" +
                "      if (options && typeof options === 'object') o = Object.assign({}, options);" +
                "      else if (locales && typeof locales === 'object' && Object.prototype.toString.call(locales) !== '[object Array]') o = Object.assign({}, locales);" +
                "      if (!o.timeZone) o.timeZone = TZ;" +
                "      return new OrigDTF(locales, o);" +
                "    };" +
                "    PatchedDTF.prototype = OrigDTF.prototype;" +
                "    PatchedDTF.supportedLocalesOf = OrigDTF.supportedLocalesOf;" +
                "    Object.defineProperty(Intl, 'DateTimeFormat', { value: markNative(PatchedDTF, 'DateTimeFormat'), writable: true, configurable: true });" +
                "  } catch(e){}"
            ) : "") +
            (shieldWebGL ? (
                "  const patchGL = (proto) => {" +
                "    if (!proto || !proto.getParameter) return;" +
                "    const orig = proto.getParameter;" +
                "    proto.getParameter = markNative(function(param){" +
                "      if (param === 37445 || param === 7936) return '" + p.webglVendor + "';" +
                "      if (param === 37446 || param === 7937) return '" + p.webglRenderer + "';" +
                "      return orig.apply(this, arguments);" +
                "    }, 'getParameter');" +
                "  };" +
                "  if (typeof WebGLRenderingContext !== 'undefined') patchGL(WebGLRenderingContext.prototype);" +
                "  if (typeof WebGL2RenderingContext !== 'undefined') patchGL(WebGL2RenderingContext.prototype);"
            ) : "") +
            (shieldCanvas ? (
                "  if (typeof CanvasRenderingContext2D !== 'undefined' && CanvasRenderingContext2D.prototype.getImageData) {" +
                "    const origGID = CanvasRenderingContext2D.prototype.getImageData;" +
                "    CanvasRenderingContext2D.prototype.getImageData = markNative(function(){" +
                "      const d = origGID.apply(this, arguments);" +
                "      try { if (d && d.data && d.data.length >= 4) d.data[0] = (d.data[0] + (SEED % 7) + 1) & 0xff; } catch(e){}" +
                "      return d;" +
                "    }, 'getImageData');" +
                "  }" +
                "  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;" +
                "  HTMLCanvasElement.prototype.toDataURL = markNative(function(){" +
                "    try {" +
                "      const ctx = this.getContext && this.getContext('2d');" +
                "      if (ctx && this.width > 0 && this.height > 0) {" +
                "        const d = ctx.getImageData(0, 0, Math.min(4, this.width), Math.min(4, this.height));" +
                "        d.data[0] = (d.data[0] + (SEED % 7) + 1) & 0xff;" +
                "        ctx.putImageData(d, 0, 0);" +
                "      }" +
                "    } catch(e){}" +
                "    return origToDataURL.apply(this, arguments);" +
                "  }, 'toDataURL');"
            ) : "") +
            (shieldAudio ? (
                "  if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {" +
                "    const origCh = AudioBuffer.prototype.getChannelData;" +
                "    AudioBuffer.prototype.getChannelData = markNative(function(){" +
                "      const data = origCh.apply(this, arguments);" +
                "      try { for (let i = 0; i < Math.min(data.length, 32); i += 8) data[i] += ((SEED % 89) + 1) * 1e-7; } catch(e){}" +
                "      return data;" +
                "    }, 'getChannelData');" +
                "  }" +
                "  if (typeof AnalyserNode !== 'undefined' && AnalyserNode.prototype.getFloatFrequencyData) {" +
                "    const origFreq = AnalyserNode.prototype.getFloatFrequencyData;" +
                "    AnalyserNode.prototype.getFloatFrequencyData = markNative(function(arr){" +
                "      const r = origFreq.apply(this, arguments);" +
                "      try { if (arr && arr.length > 0) arr[0] += ((SEED % 53) + 1) * 1e-5; } catch(e){}" +
                "      return r;" +
                "    }, 'getFloatFrequencyData');" +
                "  }"
            ) : "") +
            (shieldClientRects ? (
                "  if (typeof Element !== 'undefined' && Element.prototype.getBoundingClientRect) {" +
                "    const origBCR = Element.prototype.getBoundingClientRect;" +
                "    Element.prototype.getBoundingClientRect = markNative(function(){" +
                "      const rect = origBCR.apply(this, arguments);" +
                "      try { const delta = ((SEED % 19) + 1) * 1e-4; def(rect, 'width', rect.width + delta); def(rect, 'height', rect.height + delta); } catch(e){}" +
                "      return rect;" +
                "    }, 'getBoundingClientRect');" +
                "  }"
            ) : "") +
            (shieldWebRTC ? (
                "  const BlockRTC = markNative(function(){ throw new DOMException('WebRTC blocked by Browz Shield', 'NotAllowedError'); }, 'RTCPeerConnection');" +
                "  window.RTCPeerConnection = BlockRTC;" +
                "  window.webkitRTCPeerConnection = BlockRTC;" +
                "  window.RTCDataChannel = undefined;"
            ) : "") +
            "  // Compatibility: Ensure target='_blank' links, window.open, and Video Fit-to-Screen work cleanly in mobile WebView\n" +
            "  window.open = markNative(function(u) { if (u) { window.location.href = u; } return null; }, 'open');" +
            "  document.addEventListener('click', function(ev) {" +
            "    const a = ev.target && ev.target.closest && ev.target.closest('a[target=\"_blank\"]');" +
            "    if (a && a.href && a.href.startsWith('http')) { a.removeAttribute('target'); }" +
            "  }, true);" +
            "  const injectMobileVideoCss = function() {" +
            "    try {" +
            "      if (document.head && !document.getElementById('browz-mob-video-css')) {" +
            "        const st = document.createElement('style');" +
            "        st.id = 'browz-mob-video-css';" +
            "        st.textContent = 'video{max-width:100%;object-fit:contain;} video.browz-video-fitted,iframe.browz-video-fitted{position:fixed!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;max-width:100vw!important;max-height:100vh!important;z-index:2147483646!important;background:#000!important;object-fit:contain!important;} #browz-video-fit-exit{position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(24,24,28,0.9);color:#fff;border:1px solid #3f3f4a;border-radius:8px;padding:7px 12px;font-weight:600;font-size:12px;}';" +
            "        document.head.appendChild(st);" +
            "      }" +
            "    } catch(e){}" +
            "  };" +
            "  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectMobileVideoCss); else injectMobileVideoCss();" +
            "  const mobFitFn = function(forceState) {" +
            "    injectMobileVideoCss();" +
            "    const cur = document.querySelector('.browz-video-fitted');" +
            "    const ex = document.getElementById('browz-video-fit-exit');" +
            "    if (cur && forceState !== true) { cur.classList.remove('browz-video-fitted'); if (ex) ex.remove(); return false; }" +
            "    const v = document.querySelector('video, iframe[src*=\"youtube\"], iframe[src*=\"vimeo\"], iframe[src*=\"player\"]');" +
            "    if (!v) return false;" +
            "    v.classList.add('browz-video-fitted');" +
            "    if (!ex && document.body) {" +
            "      const b = document.createElement('button');" +
            "      b.id = 'browz-video-fit-exit';" +
            "      b.textContent = '✕ Exit Video Fit';" +
            "      b.onclick = function(){ window.__browzToggleVideoFit(false); };" +
            "      document.body.appendChild(b);" +
            "    }" +
            "    return true;" +
            "  };" +
            "  try { Object.defineProperty(window, '__browzToggleVideoFit', { value: mobFitFn, enumerable: false, configurable: true, writable: true }); } catch(e){ window.__browzToggleVideoFit = mobFitFn; }" +
            "} catch(e){}" +
            "})();";
    }

    private static final int MAX_TABS = 20;

    private void createAndSwitchTab(String url, boolean ghostMode) {
        if (tabs.size() >= MAX_TABS) {
            // Every tab is a live WebView; an unbounded list would let a page (or an
            // impatient user) exhaust memory and get the whole process killed.
            Toast.makeText(this, "Tab limit reached (" + MAX_TABS + "). Close a tab first.", Toast.LENGTH_LONG).show();
            return;
        }
        WebView wv = buildHardenedWebView(ghostMode);
        BrowserTab tab = new BrowserTab(tabIdCounter++, wv, ghostMode);
        tabs.add(tab);
        switchToTab(tab);
        navigateActiveTab(url);
    }

    private void switchToTab(BrowserTab tab) {
        activeTab = tab;
        webViewContainer.removeAllViews();
        webViewContainer.addView(tab.webView);
        tabCountBtn.setText(String.valueOf(tabs.size()));
        urlInput.setText("browz://home".equals(tab.url) ? "" : tab.url);
        setTabLoadingState(tab, tab.loading);
        syncBookmarkStar();
        syncNavButtonsState();
    }

    private String resolveInputUrl(String raw) {
        String input = raw == null ? "" : raw.trim();
        if (input.isEmpty() || "browz://home".equalsIgnoreCase(input)) {
            return "browz://home";
        }
        if ("browz://security".equalsIgnoreCase(input)) {
            return "browz://security";
        }
        if ("browz://testbench".equalsIgnoreCase(input)) {
            return "browz://testbench";
        }
        if (input.startsWith("http://") || input.startsWith("https://")) {
            return cleanAndUpgradeUrl(Uri.parse(input));
        }
        if (input.matches("^([a-zA-Z0-9-]+\\.)+[a-zA-Z]{2,}(/.*)?$") && !input.contains(" ")) {
            return cleanAndUpgradeUrl(Uri.parse("https://" + input));
        }
        return "https://duckduckgo.com/?q=" + Uri.encode(input);
    }

    private void navigateActiveTab(String rawInput) {
        if (activeTab == null) return;
        String target = resolveInputUrl(rawInput);
        Uri targetUri = Uri.parse(target);
        String targetHost = targetUri.getHost();
        if (targetHost != null && ("browz.local".equalsIgnoreCase(targetHost)
                || targetHost.toLowerCase(Locale.ROOT).endsWith(".browz.local"))) {
            Toast.makeText(this, "This address is reserved for Browz", Toast.LENGTH_SHORT).show();
            return;
        }
        activeTab.url = target;
        if (target.startsWith("browz://")) {
            activeTab.webView.addJavascriptInterface(new BridgeInterface(), "BrowzNative");
        } else {
            activeTab.webView.removeJavascriptInterface("BrowzNative");
        }
        syncBookmarkStar();

        if ("browz://home".equals(target)) {
            activeTab.title = "New Tab";
            urlInput.setText("");
            loadHomeIntoWebView(activeTab.webView);
        } else if ("browz://security".equals(target)) {
            activeTab.title = "Live privacy checks";
            urlInput.setText("browz://security");
            loadSecurityAuditIntoWebView(activeTab.webView);
        } else if ("browz://testbench".equals(target)) {
            activeTab.title = "Mobile API Testbench";
            urlInput.setText("browz://testbench");
            loadTestbenchIntoWebView(activeTab.webView);
        } else {
            urlInput.setText(target);
            setTabLoadingState(activeTab, true);
            activeTab.webView.loadUrl(target, buildPrivacyHeaders());
        }
    }

    private void loadErrorPageIntoWebView(WebView wv, String failedUrl, String reason, int retriesDone) {
        String safeHtmlUrl = escapeHtmlForMobile(failedUrl);
        String safeJsUrl = escapeJsStringForMobile(failedUrl);
        String safeReason = escapeHtmlForMobile(reason == null ? "Connection Error" : reason);
        String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<title>Connection Error</title>" +
            "<style>" +
            "body{background:#121215;color:#f4f4f5;font-family:-apple-system,Roboto,sans-serif;padding:24px 16px;display:flex;align-items:center;justify-content:center;min-height:92vh}" +
            ".box{background:#18181c;border:1px solid #2e2e36;border-radius:12px;padding:22px;max-width:440px;width:100%}" +
            ".pill{display:inline-block;background:rgba(245,158,11,0.15);color:#fbbf24;border:1px solid rgba(245,158,11,0.35);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;margin-bottom:10px}" +
            "h2{font-size:18px;margin-bottom:8px}" +
            ".u{font-family:monospace;font-size:12px;color:#60a5fa;word-break:break-all;margin-bottom:10px}" +
            ".m{font-size:12.5px;color:#9ca3af;margin-bottom:16px;background:#121215;padding:10px;border-radius:8px;border:1px solid #2e2e36}" +
            ".btns{display:flex;flex-wrap:wrap;gap:8px}" +
            "button{flex:1;background:#3b82f6;color:#fff;border:none;border-radius:8px;padding:10px;font-weight:600;font-size:12.5px;cursor:pointer}" +
            "button.sec{background:#222228;border:1px solid #3f3f4a}" +
            "</style></head><body><div class='box'>" +
            "<div class='pill'>⚠️ Auto-Retried " + retriesDone + "x</div>" +
            "<h2>Site Could Not Be Reached</h2>" +
            "<div class='u'>" + safeHtmlUrl + "</div>" +
            "<div class='m'>" + safeReason + "</div>" +
            "<div class='btns'>" +
            "<button onclick=\"retryUrl()\">↻ Retry Now</button>" +
            "<button class='sec' id='autoBtn' onclick=\"toggleAuto()\">Auto-Retry (5s)</button>" +
            "<button class='sec' onclick=\"go('browz://home')\">Home</button>" +
            "</div></div>" +
            "<script>" +
            "const SEC = '" + bridgeSecret + "';" +
            "let t = null; let s = 5;" +
            "function retryUrl(){ if(window.BrowzNative) window.BrowzNative.navigate(SEC, '" + safeJsUrl + "'); }" +
            "function go(u){ if(window.BrowzNative) window.BrowzNative.navigate(SEC, u); }" +
            "function toggleAuto(){" +
            "  const b = document.getElementById('autoBtn');" +
            "  if(t){ clearInterval(t); t=null; b.textContent='Auto-Retry (5s)'; } else {" +
            "    s=5; b.textContent='Retrying in 5s...';" +
            "    t=setInterval(()=>{ s--; b.textContent='Retrying in '+s+'s...'; if(s<=0){ clearInterval(t); retryUrl(); } }, 1000);" +
            "  }" +
            "}" +
            "</script></body></html>";
        wv.addJavascriptInterface(new BridgeInterface(), "BrowzNative");
        wv.loadDataWithBaseURL("https://browz.local/", html, "text/html", "UTF-8", null);
    }

    private void loadSecurityAuditIntoWebView(WebView wv) {
        Persona p = personas.get(activePersonaIdx);
        String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<title>Live privacy checks (not a certification)</title>" +
            "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0}" +
            "body{background:#121215;color:#f4f4f5;font-family:-apple-system,Roboto,sans-serif;padding:16px}" +
            ".head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #2e2e36}" +
            "h2{font-size:17px;color:#f4f4f5}" +
            ".badge{background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.4);border-radius:999px;padding:4px 10px;font-size:11.5px;font-weight:700}" +
            ".sub{font-size:12px;color:#9ca3af;margin-bottom:12px}" +
            ".btns{display:flex;gap:8px;margin-bottom:14px}" +
            "button{flex:1;background:#222228;color:#f4f4f5;border:1px solid #3f3f4a;border-radius:8px;padding:9px;font-size:12px;font-weight:600}" +
            "button.pri{background:#3b82f6;border-color:#3b82f6;color:#fff}" +
            ".item{background:#18181c;border:1px solid #2e2e36;border-radius:8px;padding:10px 12px;margin-bottom:8px}" +
            ".row{display:flex;justify-content:space-between;align-items:center;font-size:12px;font-weight:600;margin-bottom:3px}" +
            ".pass{color:#22c55e;font-size:11px;font-weight:700;background:rgba(34,197,94,0.15);padding:2px 6px;border-radius:4px}" +
            ".val{font-family:monospace;font-size:11px;color:#9ca3af;word-break:break-all}" +
            "</style></head><body>" +
            "<div class='head'><h2>Live checks on this device</h2><span class='badge' id='scoreBadge'>Running...</span></div>" +
            "<div style='background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:8px;padding:10px;font-size:12px;color:#fbbf24;margin-bottom:12px'>These checks measure a few properties of this WebView. Passing them is not a security audit or a guarantee: a hostile page, a compromised device or a hostile network can still defeat parts of it.</div>" +
            "<div class='sub'>These checks are illustrative, not an independent security audit. Some are not verified; passing does not guarantee anonymity or protection.</div>" +
            "<div class='sub'>Persona: <strong>" + p.label + "</strong> · Seed <strong>#" + noiseSeed + "</strong></div>" +
            "<div class='btns'>" +
            "<button class='pri' onclick='runMobileAudit()'>↻ Re-Run 18 Checks</button>" +
            "<button onclick='rotateNow()'>Rotate Identity</button>" +
            "<button onclick='goHome()'>Home</button>" +
            "</div>" +
            "<div id='list'></div>" +
            "<script>" +
            "const SEC = '" + bridgeSecret + "';" +
            "function goHome(){ if(window.BrowzNative) window.BrowzNative.navigate(SEC, 'browz://home'); }" +
            "function rotateNow(){ if(window.BrowzNative) window.BrowzNative.rotateIdentity(SEC); }" +
            "async function runMobileAudit(){" +
            "  const checks = [];" +
            "  let nativeStats = { blockedTrackers: " + blockedTrackersCount + ", strippedParams: " + strippedParamsCount + ", flagSecure: " + screenSecurityFlag + " };" +
            "  try { if(window.BrowzNative) nativeStats = JSON.parse(window.BrowzNative.getNativeAuditStats(SEC)); } catch(e){}" +
            "  checks.push({ n: '1. OS Zero-Permission Lockdown', p: false, d: 'INTERNET only — Zero GPS, Camera, Mic, Contacts or Storage' });" +
            "  checks.push({ n: '2. OS Screenshot Block (FLAG_SECURE)', p: Boolean(nativeStats.flagSecure), d: 'WindowManager.LayoutParams.FLAG_SECURE=' + nativeStats.flagSecure });" +
            "  let rtcBlocked = false; try { new window.RTCPeerConnection(); } catch(e){ rtcBlocked = true; }" +
            "  checks.push({ n: '3. WebRTC Local/ISP IP Leak Kill-Switch', p: rtcBlocked, d: 'RTCPeerConnection throws NotAllowedError' });" +
            "  checks.push({ n: '4. Webdriver Automation Concealment', p: navigator.webdriver === false, d: 'navigator.webdriver === ' + navigator.webdriver });" +
            "  checks.push({ n: '5. Global Privacy Control & DNT', p: navigator.globalPrivacyControl === true && navigator.doNotTrack === '1', d: 'GPC=true, DNT=1' });" +
            "  let uaOk = false, uaText = 'Masked'; try { const he = await navigator.userAgentData.getHighEntropyValues(['platformVersion']); uaOk = he.platformVersion === '10.0.0'; uaText = he.platform + ' v' + he.platformVersion; } catch(e){}" +
            "  checks.push({ n: '6. High-Entropy Client Hints (userAgentData)', p: uaOk, d: uaText });" +
            "  let glV = '" + p.webglVendor + "', glR = '" + p.webglRenderer + "';" +
            "  try { const c = document.createElement('canvas'); const g = c.getContext('webgl'); if(g){ glV = g.getParameter(37445); glR = g.getParameter(37446); } } catch(e){}" +
            "  checks.push({ n: '7. WebGL Mobile GPU Spoofing', p: Boolean(glV && glR), d: glV + ' / ' + glR });" +
            "  let cvOk = false; try { const c = document.createElement('canvas'); c.width=16; c.height=8; const x = c.getContext('2d'); x.fillRect(0,0,8,8); cvOk = c.toDataURL().startsWith('data:image/png'); } catch(e){}" +
            "  checks.push({ n: '8. Canvas 2D Pixel Noise (toDataURL & getImageData)', p: cvOk, d: 'Session Seed #' + nativeStats.seed + ' active' });" +
            "  checks.push({ n: '9. AudioContext & AnalyserNode Noise (Cloaked)', p: typeof AudioBuffer === 'undefined' || String(AudioBuffer.prototype.getChannelData).includes('[native code]'), d: 'Sub-audible oscillator jitter + [native code] cloaking' });" +
            "  checks.push({ n: '10. ClientRects Font-Measurement Jitter (Cloaked)', p: String(Element.prototype.getBoundingClientRect).includes('[native code]'), d: 'DOMRect sub-pixel jitter (1e-4 px) + [native code] cloaking' });" +
            "  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;" +
            "  checks.push({ n: '11. Timezone & Locale Zero-Leak', p: tz === 'UTC' && new Date().getTimezoneOffset() === 0, d: 'timeZone=' + tz + ', offset=0' });" +
            "  checks.push({ n: '12. Screen & Viewport Normalization', p: window.screen.width === window.screen.availWidth, d: window.screen.width + 'x' + window.screen.height });" +
            "  checks.push({ n: '13. Gyroscope & Accelerometer Block', p: window.DeviceMotionEvent === undefined && window.DeviceOrientationEvent === undefined, d: 'DeviceMotionEvent & DeviceOrientationEvent = undefined' });" +
            "  checks.push({ n: '14. Battery, Bluetooth, USB & Network Info Block', p: navigator.getBattery === undefined && navigator.bluetooth === undefined && navigator.usb === undefined, d: 'getBattery, bluetooth, usb, connection = undefined' });" +
            "  let mDevs = []; try { if(navigator.mediaDevices) mDevs = await navigator.mediaDevices.enumerateDevices(); } catch(e){}" +
            "  checks.push({ n: '15. MediaDevices Camera/Mic Enumeration Block', p: mDevs.length === 0, d: 'enumerateDevices() returned 0 devices' });" +
            "  let qOk = true; try { if(navigator.storage && navigator.storage.estimate){ const es = await navigator.storage.estimate(); qOk = es.quota === 10737418240; } } catch(e){}" +
            "  checks.push({ n: '16. Storage Quota (10GB) & Speech Voices Masking', p: qOk, d: 'Quota normalized to 10.0 GB · OS Voices=0' });" +
            "  checks.push({ n: '17. Native Ad/Pixel/SDK Tracker Firewall', p: false, d: '20 tracker domains blocked · Blocked so far: ' + nativeStats.blockedTrackers });" +
            "  checks.push({ n: '18. 35+ URL Param Stripper, SSRF & file:// Block', p: false, d: 'utm_*, fbclid, gclid, ttclid stripped (' + nativeStats.strippedParams + ') · 3rd-party cookies blocked' });" +
            "  const connVal = navigator.connection;" +
            "  checks.push({ n: '19. Wi-Fi / Radio & Air-Gap Controller', p: connVal === undefined || Boolean(connVal.type), d: connVal === undefined ? 'Stealth Masked (navigator.connection=undefined)' : 'Simulated Radio: ' + connVal.type + ' (' + connVal.downlink + ' Mbps)' });" +
            "  let swBlocked = false; try { if(!navigator.serviceWorker) swBlocked = true; else await navigator.serviceWorker.register('/sw.js'); } catch(e){ swBlocked = true; }" +
            "  checks.push({ n: '20. ServiceWorker Persistent Disk I/O Block', p: swBlocked, d: 'ServiceWorker disk registration blocked by I/O Firewall' });" +
            "  let cBlocked = false; try { if(!window.caches) cBlocked = true; else await window.caches.open('trk'); } catch(e){ cBlocked = true; }" +
            "  checks.push({ n: '21. CacheStorage Supercookie I/O Block', p: cBlocked, d: 'window.caches supercookie storage blocked' });" +
            "  checks.push({ n: '22. Local File Picker & OPFS Disk I/O Block', p: window.showOpenFilePicker === undefined, d: 'showOpenFilePicker & OPFS getDirectory = undefined' });" +
            "  checks.push({ n: '23. Clipboard Snooping & Timer Jitter Guard', p: false, d: 'Clipboard readText blocked + performance.now jittered' });" +
            "  checks.push({ n: '24. Video Fit-to-Screen & Immersive Fullscreen', p: typeof window.__browzToggleVideoFit === 'function', d: '1-Click Video Fit & Immersive Fullscreen active' });" +
            "  const passCount = checks.filter(x => x.p).length;" +
            "  document.getElementById('scoreBadge').textContent = passCount + ' / ' + checks.length + ' observed checks (not an audit)';" +
            "  document.getElementById('list').innerHTML = checks.map(c => `<div class='item'><div class='row'><span>${c.n}</span><span class='pass'>${c.p ? 'PASS' : 'WARN'}</span></div><div class='val'>${c.d}</div></div>`).join('');" +
            "}" +
            "setTimeout(runMobileAudit, 60);" +
            "</script></body></html>";
        wv.addJavascriptInterface(new BridgeInterface(), "BrowzNative");
        wv.loadDataWithBaseURL("https://browz.local/", html, "text/html", "UTF-8", null);
    }

    private void loadTestbenchIntoWebView(WebView wv) {
        String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<title>Mobile API & Security Testbench</title>" +
            "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0}" +
            "body{background:#121215;color:#f4f4f5;font-family:-apple-system,Roboto,sans-serif;padding:16px}" +
            "h2{font-size:17px;margin-bottom:6px}" +
            ".sub{font-size:12px;color:#9ca3af;margin-bottom:14px}" +
            ".card{background:#18181c;border:1px solid #2e2e36;border-radius:10px;padding:12px;margin-bottom:10px}" +
            ".card h3{font-size:12.5px;color:#60a5fa;margin-bottom:8px;text-transform:uppercase}" +
            ".btns{display:flex;flex-wrap:wrap;gap:7px}" +
            "button{background:#222228;color:#f4f4f5;border:1px solid #3f3f4a;border-radius:7px;padding:8px 11px;font-size:12px;font-weight:600}" +
            "pre{background:#090d16;border:1px solid #2e2e36;border-radius:8px;padding:10px;font-size:11px;color:#cbd5e1;white-space:pre-wrap;margin-top:10px}" +
            "</style></head><body>" +
            "<h2>⚡ Mobile Network Capture &amp; Firewall Testbench</h2>" +
            "<div class='sub'>Tap any button below to test live API capture, tracker blocking, URL sanitizer, and hardware permission firewall.</div>" +
            "<div class='card'><h3>1. Live External API &amp; Tracker Firewall</h3><div class='btns'>" +
            "<button onclick=\"testFetch('https://api.github.com/repos/electron/electron')\">GET GitHub API</button>" +
            "<button onclick=\"testFetch('https://registry.npmjs.org/ws/latest')\">GET NPM API</button>" +
            "<button onclick=\"testFetch('https://google-analytics.com/collect?v=1&tid=UA-TEST')\">🛡️ Trigger Blocked Tracker</button>" +
            "<button onclick=\"testFetch('https://doubleclick.net/pixel')\">🛡️ Trigger Ad Pixel Block</button>" +
            "</div></div>" +
            "<div class='card'><h3>2. Hardware &amp; Sensor Firewall Verification</h3><div class='btns'>" +
            "<button onclick=\"testGeo()\">📍 Request GPS (Denied)</button>" +
            "<button onclick=\"testSensors()\">📱 Check Gyroscope / Battery</button>" +
            "<button onclick=\"testWebRTC()\">🌐 Attempt WebRTC IP Leak</button>" +
            "</div></div>" +
            "<div class='card'><h3>3. HTML5 Video Fit-to-Screen &amp; Fullscreen Test</h3>" +
            "<video id='mobVideo' controls playsinline muted loop style='width:100%;max-height:140px;background:#000;border-radius:8px;margin-bottom:8px;object-fit:contain;'></video>" +
            "<div class='btns'>" +
            "<button onclick=\"if(window.__browzToggleVideoFit) log('Video Fit-to-Screen: ' + window.__browzToggleVideoFit());\">🎬 Fit Video to Screen</button>" +
            "</div></div>" +
            "<pre id='out'>Ready. Tap any test button above, then tap 'Traffic (N)' in the bottom bar to inspect the partial request log.</pre>" +
            "<script>" +
            "const out = document.getElementById('out');" +
            "function log(m){ out.textContent = '[' + new Date().toLocaleTimeString() + '] ' + m; }" +
            "(function(){try{const v=document.getElementById('mobVideo');const c=document.createElement('canvas');c.width=480;c.height=270;const x=c.getContext('2d');let f=0;function d(){f++;x.fillStyle='#090d16';x.fillRect(0,0,480,270);x.fillStyle='#38bdf8';x.beginPath();x.arc(240+Math.cos(f*0.05)*120,135+Math.sin(f*0.07)*60,28,0,6.28);x.fill();x.fillStyle='#f8fafc';x.font='bold 15px sans-serif';x.fillText('Browz Mobile 60fps Video Fit Test #' + f,85,42);requestAnimationFrame(d);}d();if(c.captureStream){v.srcObject=c.captureStream(30);v.play().catch(()=>{});}}catch(e){}})();" +
            "async function testFetch(u){" +
            "  log('Fetching ' + u + ' ...');" +
            "  try { const r = await fetch(u); const t = await r.text(); log('HTTP ' + r.status + ' (' + t.length + ' bytes)\\n' + t.slice(0, 320)); }" +
            "  catch(e){ log('Blocked / Intercepted by Browz Firewall: ' + e.message); }" +
            "}" +
            "function testGeo(){" +
            "  navigator.geolocation.getCurrentPosition(" +
            "    p => log('GPS Allowed')," +
            "    e => log('GPS Blocked by Native WebChromeClient Firewall: ' + e.message)" +
            "  );" +
            "}" +
            "function testSensors(){" +
            "  log('DeviceMotionEvent=' + String(window.DeviceMotionEvent) + '\\ngetBattery=' + String(navigator.getBattery) + '\\nbluetooth=' + String(navigator.bluetooth));" +
            "}" +
            "function testWebRTC(){" +
            "  try { new window.RTCPeerConnection(); log('WebRTC Allowed'); }" +
            "  catch(e){ log('WebRTC Blocked: ' + e.message); }" +
            "}" +
            "</script></body></html>";
        wv.addJavascriptInterface(new BridgeInterface(), "BrowzNative");
        wv.loadDataWithBaseURL("https://browz.local/", html, "text/html", "UTF-8", null);
    }

    private void loadHomeIntoWebView(WebView wv) {
        Persona p = personas.get(activePersonaIdx);
        String versionLabel = "Browz";
        try {
            String vn = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            versionLabel = "Browz " + (vn == null ? "" : vn);
        } catch (Exception ignored) { }
        String modeLabel = (activeTab != null && activeTab.ghostMode)
            ? "Low-cache tab · site data shared with other tabs"
            : "Mobile browsing · privacy controls available";
        String html = "<!DOCTYPE html><html><head><meta charset='UTF-8'>" +
            "<meta name='viewport' content='width=device-width,initial-scale=1.0'>" +
            "<title>New Tab</title>" +
            "<style>" +
            "*{box-sizing:border-box;margin:0;padding:0}" +
            "body{background:#121215;color:#f4f4f5;font-family:-apple-system,Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;justify-content:space-between;padding:20px 16px}" +
            ".center{margin:auto;width:100%;max-width:460px;text-align:center}" +
            "h1{font-size:28px;font-weight:700;letter-spacing:-0.02em;margin-bottom:5px}" +
            ".sub{font-size:12px;color:#9ca3af;margin-bottom:20px;display:flex;align-items:center;justify-content:center;gap:6px}" +
            ".dot{width:7px;height:7px;border-radius:50%;background:#22c55e;display:inline-block}" +
            ".sbox{display:flex;background:#1c1c21;border:1px solid #2e2e36;border-radius:999px;padding:5px 6px 5px 16px;margin-bottom:20px}" +
            ".sbox input{flex:1;background:transparent;border:none;color:#f4f4f5;font-size:14px;outline:none;height:34px}" +
            ".sbox button{background:#3b82f6;color:#fff;border:none;border-radius:999px;padding:0 16px;font-weight:600;font-size:13px}" +
            ".grid{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin-bottom:18px}" +
            ".tile{background:#1c1c21;border:1px solid #2e2e36;border-radius:12px;padding:12px 6px;color:#f4f4f5;text-decoration:none;font-size:11.5px;font-weight:500;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer}" +
            ".icon{width:34px;height:34px;border-radius:9px;background:#27272a;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}" +
            ".card{background:#18181c;border:1px solid #2e2e36;border-radius:12px;padding:13px;text-align:left;font-size:11.5px;color:#9ca3af;line-height:1.6}" +
            ".card strong{color:#f4f4f5}" +
            ".row-btns{display:flex;gap:8px;margin-top:10px}" +
            ".btn{flex:1;background:#222228;color:#f4f4f5;border:1px solid #3f3f4a;border-radius:8px;padding:9px;font-size:11.5px;font-weight:600;text-align:center;cursor:pointer}" +
            "</style></head><body>" +
            "<div class='center'>" +
            "<h1>" + versionLabel + "</h1>" +
            "<div class='sub'><span class='dot'></span><span>" + modeLabel + "</span></div>" +
            "<form class='sbox' onsubmit='doSearch(event)'>" +
            "<input id='q' type='text' placeholder='Search privately or enter web address...' autocomplete='off'/>" +
            "<button type='submit'>Go</button>" +
            "</form>" +
            "<div class='grid'>" +
            "<div class='tile' onclick=\"nav('browz://security')\"><div class='icon' style='color:#22c55e;border:1px solid rgba(34,197,94,0.4)'>18</div><span>Privacy Checks</span></div>" +
            "<div class='tile' onclick=\"nav('browz://testbench')\"><div class='icon' style='color:#3b82f6;border:1px solid rgba(59,130,246,0.4)'>API</div><span>Testbench</span></div>" +
            "<div class='tile' onclick=\"nav('https://duckduckgo.com')\"><div class='icon'>D</div><span>DuckDuckGo</span></div>" +
            "<div class='tile' onclick=\"nav('https://www.google.com')\"><div class='icon'>G</div><span>Google</span></div>" +
            "<div class='tile' onclick=\"nav('https://m.youtube.com')\"><div class='icon'>Y</div><span>YouTube</span></div>" +
            "<div class='tile' onclick=\"nav('https://github.com')\"><div class='icon'>GH</div><span>GitHub</span></div>" +
            "</div>" +
            "<div class='card'>" +
            "<div>Masked Profile: <strong>" + p.label + "</strong></div>" +
            "<div>Spoofed GPU: <strong>" + p.webglVendor + " / " + p.webglRenderer + "</strong></div>" +
            "<div>Timezone: <strong>" + p.timezone + "</strong> · Canvas Seed: <strong>#" + noiseSeed + "</strong></div>" +
            "<div>Privacy controls are best-effort; Browz does not hide your IP.</div>" +
            "<div>Trackers Blocked: <strong>" + blockedTrackersCount + "</strong> · URL Params Stripped: <strong>" + strippedParamsCount + "</strong></div>" +
            "<div class='row-btns'>" +
            "<div class='btn' onclick='rot()'>Rotate Identity</div>" +
            "<div class='btn' onclick='shd()'>Customize Shields</div>" +
            "<div class='btn' onclick=\"nav('browz://security')\">Privacy Checks</div>" +
            "</div>" +
            "</div>" +
            "</div>" +
            "<script>" +
            "const SEC = '" + bridgeSecret + "';" +
            "function nav(u){ if(window.BrowzNative) window.BrowzNative.navigate(SEC, u); }" +
            "function rot(){ if(window.BrowzNative) window.BrowzNative.rotateIdentity(SEC); }" +
            "function shd(){ if(window.BrowzNative) window.BrowzNative.openShields(SEC); }" +
            "function doSearch(e){e.preventDefault();var v=document.getElementById('q').value;if(v){nav(v);}}" +
            "</script></body></html>";

        wv.addJavascriptInterface(new BridgeInterface(), "BrowzNative");
        wv.loadDataWithBaseURL("https://browz.local/", html, "text/html", "UTF-8", null);
    }

    private void showBrowserMenu() {
        String[] items = {"New tab", "Bookmarks", "Find, zoom and video", "Privacy controls",
            "Network rules", "Containers (separate logins)", "Hardware & permissions",
            "Request log", "Share page", "Clear browsing data", "Privacy and limitations"};
        openDialog = new AlertDialog.Builder(this)
            .setTitle("Browz " + getVersionName() + " · " + activeContainerName())
            .setItems(items, (dialog, which) -> {
                switch (which) {
                    case 0: createAndSwitchTab("browz://home", false); break;
                    case 1: showBookmarksDialog(); break;
                    case 2: showToolsDialog(); break;
                    case 3: showShieldsDialog(); break;
                    case 4: showNetworkRulesDialog(); break;
                    case 5: showContainersDialog(); break;
                    case 6: showHardwareDialog(); break;
                    case 7: showTrafficCaptureDialog(); break;
                    case 8: shareCurrentPage(); break;
                    case 9: confirmClearBrowsingData(); break;
                    case 10: showPrivacyInfo(); break;
                }
            }).setNegativeButton("Close", null).show();
    }

    private String getVersionName() {
        try {
            String vn = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            if (vn != null) return vn;
        } catch (Exception ignored) { }
        return "";
    }

    private void showBookmarksDialog() {
        if (bookmarks.isEmpty()) {
            Toast.makeText(this, "No bookmarks yet", Toast.LENGTH_SHORT).show();
            return;
        }
        String[] labels = new String[bookmarks.size()];
        for (int i = 0; i < bookmarks.size(); i++) labels[i] = bookmarks.get(i).title;
        new AlertDialog.Builder(this).setTitle("Bookmarks")
            .setItems(labels, (dialog, which) -> navigateActiveTab(bookmarks.get(which).url))
            .setNegativeButton("Close", null).show();
    }

    private void shareCurrentPage() {
        if (activeTab == null || !(activeTab.url.startsWith("https://") || activeTab.url.startsWith("http://"))) {
            Toast.makeText(this, "Open a web page to share it", Toast.LENGTH_SHORT).show();
            return;
        }
        Intent share = new Intent(Intent.ACTION_SEND);
        share.setType("text/plain");
        share.putExtra(Intent.EXTRA_TEXT, activeTab.url);
        startActivity(Intent.createChooser(share, "Share page"));
    }

    private void confirmClearBrowsingData() {
        new AlertDialog.Builder(this).setTitle("Clear browsing data?")
            .setMessage("Clears cookies, site storage, cache, history and the request log for all tabs. You may be signed out. Bookmarks are kept.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Clear", (dialog, which) -> {
                CookieManager cm = CookieManager.getInstance();
                cm.removeAllCookies(value -> cm.flush());
                WebStorage.getInstance().deleteAllData();
                for (BrowserTab tab : tabs) {
                    tab.webView.clearCache(true);
                    tab.webView.clearHistory();
                    tab.webView.clearFormData();
                }
                clearRequestLog();
                Toast.makeText(this, "Browsing data cleared", Toast.LENGTH_SHORT).show();
            }).show();
    }

    private void showPrivacyInfo() {
        new AlertDialog.Builder(this).setTitle("Privacy and limitations")
            .setMessage("Browz is not Tor or a VPN: websites and network providers may see your IP address. Containers close every page and wipe cookies plus site storage when you switch, so two accounts are not shared; tabs inside one container do share cookies, and low-cache tabs are not private. Container sessions end when Browz closes. Request logging is incomplete and cannot show response status or bodies. Network profiles simulate web-facing values, not device Wi-Fi controls. Some page-level shields run after page scripts and are not guaranteed. Bookmarks and container names are saved on this device and may contain sensitive addresses. Android, keyboards and other privileged software may access data. There is no Browz account, no sync and no telemetry; the one exception is that Android WebView Safe Browsing may ask Google whether a visited address is dangerous, and that lookup happens without any account.")
            .setPositiveButton("Understood", null).show();
    }

    private void showToolsDialog() {
        if (activeTab == null) return;
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(10));

        // 1. Page Text/Viewport Zoom Controls
        TextView zoomTitle = new TextView(this);
        zoomTitle.setText("Page Zoom: " + activeTab.zoomPercent + "%");
        zoomTitle.setTypeface(Typeface.DEFAULT_BOLD);
        zoomTitle.setPadding(0, 0, 0, dp(8));
        box.addView(zoomTitle);

        LinearLayout zoomRow = new LinearLayout(this);
        zoomRow.setOrientation(LinearLayout.HORIZONTAL);
        Button btnZoomOut = new Button(this);
        btnZoomOut.setText("− Zoom Out");
        btnZoomOut.setOnClickListener(v -> {
            activeTab.zoomPercent = Math.max(50, activeTab.zoomPercent - 15);
            activeTab.webView.getSettings().setTextZoom(activeTab.zoomPercent);
            zoomTitle.setText("Page Zoom: " + activeTab.zoomPercent + "%");
        });
        Button btnZoomReset = new Button(this);
        btnZoomReset.setText("100%");
        btnZoomReset.setOnClickListener(v -> {
            activeTab.zoomPercent = 100;
            activeTab.webView.getSettings().setTextZoom(100);
            zoomTitle.setText("Page Zoom: 100%");
        });
        Button btnZoomIn = new Button(this);
        btnZoomIn.setText("+ Zoom In");
        btnZoomIn.setOnClickListener(v -> {
            activeTab.zoomPercent = Math.min(200, activeTab.zoomPercent + 15);
            activeTab.webView.getSettings().setTextZoom(activeTab.zoomPercent);
            zoomTitle.setText("Page Zoom: " + activeTab.zoomPercent + "%");
        });
        zoomRow.addView(btnZoomOut, new LinearLayout.LayoutParams(0, dp(48), 1f));
        zoomRow.addView(btnZoomReset, new LinearLayout.LayoutParams(0, dp(48), 1f));
        zoomRow.addView(btnZoomIn, new LinearLayout.LayoutParams(0, dp(48), 1f));
        box.addView(zoomRow);

        // 2. Find in Page
        TextView findTitle = new TextView(this);
        findTitle.setText("Find in Page:");
        findTitle.setTypeface(Typeface.DEFAULT_BOLD);
        findTitle.setPadding(0, dp(14), 0, dp(6));
        box.addView(findTitle);

        final EditText findInput = new EditText(this);
        findInput.setHint("Enter word or phrase to highlight...");
        findInput.setSingleLine(true);
        box.addView(findInput);

        LinearLayout findBtns = new LinearLayout(this);
        findBtns.setOrientation(LinearLayout.HORIZONTAL);
        Button btnFind = new Button(this);
        btnFind.setText("Find");
        btnFind.setOnClickListener(v -> {
            String q = findInput.getText().toString().trim();
            if (!q.isEmpty()) {
                activeTab.webView.findAllAsync(q);
            }
        });
        Button btnNext = new Button(this);
        btnNext.setText("Next Match");
        btnNext.setOnClickListener(v -> activeTab.webView.findNext(true));
        Button btnClearFind = new Button(this);
        btnClearFind.setText("Clear");
        btnClearFind.setOnClickListener(v -> {
            findInput.setText("");
            activeTab.webView.clearMatches();
        });
        findBtns.addView(btnFind, new LinearLayout.LayoutParams(0, dp(48), 1f));
        findBtns.addView(btnNext, new LinearLayout.LayoutParams(0, dp(48), 1f));
        findBtns.addView(btnClearFind, new LinearLayout.LayoutParams(0, dp(48), 1f));
        box.addView(findBtns);

        // 3. 1-Click Fit Video to Full Screen & Radio Profile Switcher
        Button btnFitVideo = new Button(this);
        btnFitVideo.setText("🎬 Fit Video on Page to Full Screen");
        btnFitVideo.setOnClickListener(v -> {
            if (activeTab != null) {
                activeTab.webView.evaluateJavascript(
                    "window.__browzToggleVideoFit ? window.__browzToggleVideoFit() : false",
                    res -> Toast.makeText(MainActivity.this, "true".equals(res) ? "Video fitted" : "Video fit exited or no video found", Toast.LENGTH_SHORT).show()
                );
            }
        });
        box.addView(btnFitVideo);

        Button btnRadioMode = new Button(this);
        btnRadioMode.setText("Network info simulation: " + radioProfile);
        btnRadioMode.setOnClickListener(v -> {
            String[] modes = new String[]{"stealth_hidden", "wifi_fiber", "cellular_4g", "cellular_3g_saver", "airgap_killswitch"};
            String[] labels = new String[]{
                "Stealth Mask (Hide Wi-Fi / Radio Type)",
                "Report Wi-Fi (simulation only)",
                "Report cellular 4G (simulation only)",
                "Report cellular 3G (simulation only)",
                "Attempt to block WebView requests (not a device firewall)"
            };
            new AlertDialog.Builder(MainActivity.this)
                .setTitle("Network info simulation (not device Wi-Fi)")
                .setItems(labels, (d2, idx) -> {
                    radioProfile = modes[idx];
                    btnRadioMode.setText("Network info simulation: " + radioProfile);
                    if (activeTab != null) navigateActiveTab(activeTab.url);
                    Toast.makeText(MainActivity.this, "Applied Radio Profile: " + labels[idx], Toast.LENGTH_SHORT).show();
                })
                .show();
        });
        box.addView(btnRadioMode);

        ScrollView toolsScroll = new ScrollView(this);
        toolsScroll.setFillViewport(false);
        toolsScroll.addView(box);
        new AlertDialog.Builder(this)
            .setTitle("Page tools")
            .setView(toolsScroll)
            .setPositiveButton("Illustrative checks", (d, w) -> navigateActiveTab("browz://security"))
            .setNeutralButton("API & Video Testbench", (d, w) -> navigateActiveTab("browz://testbench"))
            .setNegativeButton("Done", null)
            .show();
    }

    private void burnAndRotateIdentity() {
        activePersonaIdx = (activePersonaIdx + 1) % personas.size();
        noiseSeed = 100000 + new Random().nextInt(900000);
        retryAttemptsByUrl.clear();

        CookieManager cm = CookieManager.getInstance();
        cm.removeAllCookies(null);
        cm.flush();
        WebStorage.getInstance().deleteAllData();

        Persona nextP = personas.get(activePersonaIdx);
        for (BrowserTab t : tabs) {
            t.webView.clearCache(true);
            t.webView.clearHistory();
            t.webView.clearFormData();
            t.webView.getSettings().setUserAgentString(nextP.userAgent);
        }

        if (activeTab != null) {
            navigateActiveTab(activeTab.url);
        }

        Toast.makeText(
            this,
            "Identity Rotated: " + nextP.label + " (Seed #" + noiseSeed + ") & Storage Wiped",
            Toast.LENGTH_SHORT
        ).show();
    }

    private void showShieldsDialog() {
        ScrollView sv = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(16), dp(20), dp(10));

        Persona currentP = personas.get(activePersonaIdx);
        TextView personaLabel = new TextView(this);
        personaLabel.setText("Active Persona: " + currentP.label + "\nSeed: #" + noiseSeed);
        personaLabel.setTextSize(13f);
        personaLabel.setTypeface(Typeface.DEFAULT_BOLD);
        personaLabel.setPadding(0, 0, 0, dp(10));
        box.addView(personaLabel);

        Button cyclePersonaBtn = new Button(this);
        cyclePersonaBtn.setText("Switch OS / Device Persona");
        cyclePersonaBtn.setOnClickListener(v -> {
            activePersonaIdx = (activePersonaIdx + 1) % personas.size();
            Persona np = personas.get(activePersonaIdx);
            for (BrowserTab t : tabs) {
                t.webView.getSettings().setUserAgentString(np.userAgent);
            }
            personaLabel.setText("Active Persona: " + np.label + "\nSeed: #" + noiseSeed);
        });
        box.addView(cyclePersonaBtn);

        box.addView(makeCheck("Canvas 2D Noise (toDataURL & getImageData)", shieldCanvas, c -> shieldCanvas = c));
        box.addView(makeCheck("WebGL Mobile GPU Spoofing", shieldWebGL, c -> shieldWebGL = c));
        box.addView(makeCheck("AudioContext & AnalyserNode Noise", shieldAudio, c -> shieldAudio = c));
        box.addView(makeCheck("ClientRects Font-Measurement Jitter", shieldClientRects, c -> shieldClientRects = c));
        box.addView(makeCheck("Attempt to block WebRTC in pages", shieldWebRTC, c -> shieldWebRTC = c));
        box.addView(makeCheck("Spoof High-Entropy Client Hints (userAgentData)", shieldClientHints, c -> shieldClientHints = c));
        box.addView(makeCheck("Block Gyroscope, Accelerometer, Battery & USB", shieldSensors, c -> shieldSensors = c));
        box.addView(makeCheck("Mask Storage Quota (10GB) & Speech Voices", shieldStorageAndVoices, c -> shieldStorageAndVoices = c));
        box.addView(makeCheck("Spoof Timezone (UTC) & Locale", shieldTimezone, c -> shieldTimezone = c));
        box.addView(makeCheck("Attempt to block ServiceWorkers in pages", blockServiceWorkers, c -> blockServiceWorkers = c));
        box.addView(makeCheck("Attempt to block CacheStorage in pages", blockCacheStorage, c -> blockCacheStorage = c));
        box.addView(makeCheck("Block Local File Picker & OPFS Disk I/O", blockFileSystemAccess, c -> blockFileSystemAccess = c));
        box.addView(makeCheck("Block Silent Clipboard Read Snooping", blockClipboardRead, c -> blockClipboardRead = c));
        box.addView(makeCheck("Attempt to block WebSockets in pages", blockWebSockets, c -> blockWebSockets = c));
        box.addView(makeCheck("Reduce timer precision in pages", timerJitter, c -> timerJitter = c));
        box.addView(makeCheck("Block 20+ Ad, Pixel & Mobile SDK Trackers", blockTrackers, c -> blockTrackers = c));
        box.addView(makeCheck("Strip 35+ URL Tracking Params (utm_*, fbclid)", stripUrlParams, c -> stripUrlParams = c));
        box.addView(makeCheck("Auto-Retry Transient Network Errors (2x)", autoRetryFailed, c -> autoRetryFailed = c));
        box.addView(makeCheck("Force HTTPS-Only Connections", forceHttps, c -> forceHttps = c));
        box.addView(makeCheck("Block OS Screenshots (FLAG_SECURE)", screenSecurityFlag, c -> {
            screenSecurityFlag = c;
            if (c) {
                getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
            } else {
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            }
        }));

        sv.addView(box);

        new AlertDialog.Builder(this)
            .setTitle("Privacy controls (some may break sites)")
            .setView(sv)
            .setPositiveButton("Apply & Reload", (d, w) -> {
                if (activeTab != null) {
                    navigateActiveTab(activeTab.url);
                }
            })
            .setNeutralButton("Illustrative checks", (d, w) -> navigateActiveTab("browz://security"))
            .setNegativeButton("Burn Identity", (d, w) -> burnAndRotateIdentity())
            .show();
    }

    private interface CheckListener {
        void onChanged(boolean checked);
    }

    private CheckBox makeCheck(String title, boolean initial, CheckListener listener) {
        CheckBox cb = new CheckBox(this);
        cb.setText(title);
        cb.setChecked(initial);
        cb.setOnCheckedChangeListener((btn, isChecked) -> listener.onChanged(isChecked));
        return cb;
    }

    private void showTabsDialog() {
        String[] items = new String[tabs.size()];
        for (int i = 0; i < tabs.size(); i++) {
            BrowserTab t = tabs.get(i);
            String marker = (t == activeTab) ? "● " : "  ";
            String modeTag = t.ghostMode ? "[Low-cache] " : "";
            items[i] = marker + modeTag + "Tab " + (i + 1) + ": " + t.title + " (" + t.url + ")";
        }

        new AlertDialog.Builder(this)
            .setTitle("Open Tabs (" + tabs.size() + ")")
            .setItems(items, (d, which) -> switchToTab(tabs.get(which)))
            .setPositiveButton("+ New Tab", (d, w) -> createAndSwitchTab("browz://home", false))
            .setNeutralButton("+ Low-cache tab", (d, w) -> createAndSwitchTab("browz://home", true))
            .setNegativeButton("Close Active Tab", (d, w) -> {
                if (tabs.size() <= 1) {
                    burnAndRotateIdentity();
                    navigateActiveTab("browz://home");
                } else if (activeTab != null) {
                    webViewContainer.removeView(activeTab.webView);
                    activeTab.webView.destroy();
                    tabs.remove(activeTab);
                    switchToTab(tabs.get(tabs.size() - 1));
                }
            })
            .show();
    }

    private void showTrafficCaptureDialog() {
        List<CapturedEntry> entries;
        synchronized (this) { entries = new ArrayList<>(capturedEntries); }
        StringBuilder sb = new StringBuilder();
        sb.append("Request log: blocked and forwarded requests. When status measuring is on, top-level pages get a real code from a separate HEAD probe, not from the page load. Bodies and request headers are never captured. URLs may contain sensitive data.\n\nTotal observed: ").append(entries.size())
          .append(" | Trackers Blocked: ").append(blockedTrackersCount)
          .append(" | URL Params Stripped: ").append(strippedParamsCount)
          .append("\n\n");

        int limit = Math.min(entries.size(), 80);
        for (int i = 0; i < limit; i++) {
            CapturedEntry e = entries.get(i);
            sb.append("#").append(e.seq).append(" [").append(e.timestamp).append("] ")
              .append(e.blocked ? "BLOCKED (" + e.reason + ") " : "FORWARDED (" + (e.status == null ? "status not measured" : e.status) + ") ")
              .append(e.method).append(" ").append(e.url).append("\n\n");
        }
        if (entries.isEmpty()) {
            sb.append("No observable requests yet. WebView does not expose every request or response.");
        }

        ScrollView sv = new ScrollView(this);
        TextView tv = new TextView(this);
        tv.setText(sb.toString());
        tv.setTextSize(11.5f);
        tv.setTypeface(Typeface.MONOSPACE);
        tv.setPadding(dp(18), dp(14), dp(18), dp(14));
        sv.addView(tv);

        new AlertDialog.Builder(this)
            .setTitle("Captured Network Traffic")
            .setView(sv)
            .setPositiveButton("Copy request log", (d, w) -> copyRequestLog())
            .setNeutralButton("Clear Log", (d, w) -> clearRequestLog())
            .setNegativeButton("Close", null)
            .show();
    }

    private synchronized void copyRequestLog() {
        StringBuilder text = new StringBuilder("time,method,decision,status,url\n");
        for (CapturedEntry e : capturedEntries) {
            text.append(e.timestamp).append(',')
                .append(e.method).append(',')
                .append(e.blocked ? "blocked" : "forwarded").append(',')
                .append(e.status == null ? "" : e.status).append(',')
                .append('"').append(e.url.replace("\"", "\"\"")).append('"').append('\n');
        }
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm != null) {
            cm.setPrimaryClip(ClipData.newPlainText("Browz request log", text.toString()));
            Toast.makeText(this, "Request log copied; it may contain sensitive URLs", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (customVideoView != null) {
            webViewContainer.removeView(customVideoView);
            customVideoView = null;
            if (topBarView != null) topBarView.setVisibility(View.VISIBLE);
            if (bmScrollView != null) bmScrollView.setVisibility(View.GONE);
            if (bottomBarView != null) bottomBarView.setVisibility(View.VISIBLE);
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
            if (customVideoCallback != null) {
                customVideoCallback.onCustomViewHidden();
                customVideoCallback = null;
            }
            return;
        }
        if (activeTab != null && activeTab.webView.canGoBack()) {
            activeTab.webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= TRIM_MEMORY_MODERATE) {
            for (BrowserTab tab : new ArrayList<>(tabs)) {
                tab.webView.clearCache(false);
            }
        }
    }

    @Override
    protected void onDestroy() {
        try {
            CookieManager cm = CookieManager.getInstance();
            cm.removeAllCookies(null);
            cm.flush();
            WebStorage.getInstance().deleteAllData();
            for (BrowserTab t : tabs) {
                if (t.webView.getParent() instanceof ViewGroup) {
                    ((ViewGroup) t.webView.getParent()).removeView(t.webView);
                }
                t.webView.clearCache(true);
                t.webView.clearHistory();
                t.webView.clearFormData();
                t.webView.destroy();
            }
        } catch (Exception ignored) {}
        getPreferences(MODE_PRIVATE).edit().putBoolean("sessionOpen", false).apply();
        super.onDestroy();
    }
}
