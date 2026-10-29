package com.browz.mobile;

import android.app.AlertDialog;
import android.test.ActivityInstrumentationTestCase2;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

/** Device tests use the actual Activity and Android WebView, not source-code matching. */
@SuppressWarnings("deprecation")
public class BrowserUiTest extends ActivityInstrumentationTestCase2<MainActivity> {
    public BrowserUiTest() { super(MainActivity.class); }

    private View findByDescription(View view, String description) {
        if (description.contentEquals(view.getContentDescription() == null ? "" : view.getContentDescription())) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = findByDescription(group.getChildAt(i), description);
                if (found != null) return found;
            }
        }
        return null;
    }

    public void testMenuAndTabsAreReachable() throws Throwable {
        MainActivity activity = getActivity();
        View menu = findByDescription(activity.getWindow().getDecorView(), "Browser menu");
        View tabs = findByDescription(activity.getWindow().getDecorView(), "Open tabs");
        assertNotNull(menu);
        assertNotNull(tabs);
        assertTrue(menu.isShown());
        assertTrue(tabs.isShown());
        assertTrue(menu.getHeight() >= 48 * activity.getResources().getDisplayMetrics().density - 1);
        runTestOnUiThread(menu::performClick);
        getInstrumentation().waitForIdleSync();
        // A second press must not crash even when the menu is open.
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        runTestOnUiThread(tabs::performClick);
        getInstrumentation().waitForIdleSync();
    }
}
