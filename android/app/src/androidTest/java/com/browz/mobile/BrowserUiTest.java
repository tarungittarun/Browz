package com.browz.mobile;

import android.content.Context;
import android.content.Intent;
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

    public void testBookmarkRemovalPersistsAfterRelaunch() throws Throwable {
        Context target = getInstrumentation().getTargetContext();
        // Reset only the isolated emulator's test app preferences.
        target.getSharedPreferences("MainActivity", Context.MODE_PRIVATE).edit().clear().commit();
        MainActivity first = getActivity();
        getInstrumentation().waitForIdleSync();
        View star = findByDescription(first.getWindow().getDecorView(), "Remove bookmark");
        assertNotNull("Home begins bookmarked", star);
        runTestOnUiThread(star::performClick);
        getInstrumentation().waitForIdleSync();
        assertNotNull(findByDescription(first.getWindow().getDecorView(), "Bookmark this page"));
        runTestOnUiThread(first::finish);
        getInstrumentation().waitForIdleSync();
        Intent intent = new Intent(target, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity relaunched = (MainActivity) getInstrumentation().startActivitySync(intent);
        try {
            getInstrumentation().waitForIdleSync();
            View unbookmarked = findByDescription(relaunched.getWindow().getDecorView(), "Bookmark this page");
            assertNotNull("Removed bookmark must stay removed after relaunch", unbookmarked);
            runTestOnUiThread(unbookmarked::performClick);
            getInstrumentation().waitForIdleSync();
            assertNotNull(findByDescription(relaunched.getWindow().getDecorView(), "Remove bookmark"));
        } finally {
            runTestOnUiThread(relaunched::finish);
            getInstrumentation().waitForIdleSync();
            target.getSharedPreferences("MainActivity", Context.MODE_PRIVATE).edit().clear().commit();
        }
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
