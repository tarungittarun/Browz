package com.browz.mobile;

import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.test.ActivityInstrumentationTestCase2;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

/**
 * Enforces the usability contract that was previously only eyeballed:
 * 48 dp touch targets, WCAG AA contrast, readable label sizes and a usable
 * viewport in both orientations.
 */
@SuppressWarnings("deprecation")
public class UxContractTest extends ActivityInstrumentationTestCase2<MainActivity> {

    private static final double MIN_TOUCH_DP = 48.0;
    private static final double MIN_CONTRAST = 4.5;

    public UxContractTest() { super(MainActivity.class); }

    private float density() {
        return getActivity().getResources().getDisplayMetrics().density;
    }

    private static void collect(View view, java.util.List<View> out) {
        out.add(view);
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) collect(group.getChildAt(i), out);
        }
    }

    private View find(View root, String description) {
        if (description.equals(root.getContentDescription())) return root;
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = find(group.getChildAt(i), description);
                if (found != null) return found;
            }
        }
        return null;
    }

    private static int backgroundColor(View view) {
        Drawable background = view.getBackground();
        if (background instanceof ColorDrawable) return ((ColorDrawable) background).getColor();
        if (background instanceof GradientDrawable) {
            try {
                android.content.res.ColorStateList csl = ((GradientDrawable) background).getColor();
                if (csl != null) return csl.getDefaultColor();
            } catch (Exception ignored) { }
        }
        return Color.TRANSPARENT;
    }

    private static double relativeLuminance(int color) {
        double[] channels = new double[]{
                Color.red(color) / 255.0, Color.green(color) / 255.0, Color.blue(color) / 255.0};
        for (int i = 0; i < channels.length; i++) {
            channels[i] = channels[i] <= 0.03928
                    ? channels[i] / 12.92
                    : Math.pow((channels[i] + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    }

    private static double contrastRatio(int a, int b) {
        double la = relativeLuminance(a);
        double lb = relativeLuminance(b);
        double lighter = Math.max(la, lb);
        double darker = Math.min(la, lb);
        return (lighter + 0.05) / (darker + 0.05);
    }

    /** Every labelled control the user is meant to tap must be at least 48 dp. */
    public void testTouchTargetsMeetAccessibilityMinimum() throws Throwable {
        final MainActivity activity = getActivity();
        final java.util.List<View> all = new java.util.ArrayList<>();
        runTestOnUiThread(() -> collect(activity.getWindow().getDecorView(), all));
        int checked = 0;
        for (View v : all) {
            CharSequence description = v.getContentDescription();
            if (description == null || !(v instanceof TextView) || !v.isShown()) continue;
            String label = description.toString();
            boolean tappable = "Browser menu".equals(label) || "Open tabs".equals(label)
                    || "Bookmark this page".equals(label) || "Remove bookmark".equals(label)
                    || label.contains("Back") || label.contains("Fwd") || "Home".equals(label)
                    || label.contains("Reload") || "Tabs".equals(label);
            if (!tappable) continue;
            checked++;
            float heightDp = v.getHeight() / density();
            float widthDp = v.getWidth() / density();
            assertTrue(label + " height " + heightDp + "dp is below the 48dp minimum",
                    heightDp >= MIN_TOUCH_DP - 1.0);
            assertTrue(label + " width " + widthDp + "dp is below the 48dp minimum",
                    widthDp >= MIN_TOUCH_DP - 1.0);
        }
        assertTrue("no tappable controls were found; the test verified nothing", checked >= 6);
    }

    /** Labels must stay readable: WCAG AA contrast and at least 11sp text. */
    public void testLabelContrastAndSize() throws Throwable {
        final MainActivity activity = getActivity();
        final java.util.List<View> all = new java.util.ArrayList<>();
        runTestOnUiThread(() -> collect(activity.getWindow().getDecorView(), all));
        int checked = 0;
        for (View v : all) {
            if (!(v instanceof TextView) || !v.isShown()) continue;
            TextView text = (TextView) v;
            if (text.getText() == null || text.getText().length() == 0) continue;
            if (text.getContentDescription() == null) continue;
            int fg = text.getCurrentTextColor();
            int bg = backgroundColor(text);
            if (bg == Color.TRANSPARENT) bg = backgroundColor((View) text.getParent());
            if (bg == Color.TRANSPARENT) continue;
            checked++;
            double ratio = contrastRatio(fg, bg);
            assertTrue("contrast for '" + text.getText() + "' is only " + String.format("%.2f", ratio)
                    + ":1 (needs " + MIN_CONTRAST + ")", ratio >= MIN_CONTRAST);
            float sp = text.getTextSize() / activity.getResources().getDisplayMetrics().scaledDensity;
            assertTrue("text size for '" + text.getText() + "' is " + sp + "sp, below 11sp", sp >= 10.5f);
        }
        assertTrue("no labels were checked", checked >= 4);
    }

    /** Rotating must not clip the page or hide the navigation bar. */
    public void testRotationKeepsViewportUsable() throws Throwable {
        final MainActivity activity = getActivity();
        final int[] sizes = new int[4];
        runTestOnUiThread(() -> {
            View root = activity.getWindow().getDecorView().findViewById(android.R.id.content);
            sizes[0] = root.getHeight();
            sizes[1] = root.getWidth();
        });
        assertTrue("activity has no measurable size", sizes[0] > 0 && sizes[1] > 0);

        runTestOnUiThread(() -> activity.setRequestedOrientation(
                ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE));
        getInstrumentation().waitForIdleSync();
        Thread.sleep(1200);
        runTestOnUiThread(() -> {
            View tabs = find(activity.getWindow().getDecorView(), "Open tabs");
            View menu = find(activity.getWindow().getDecorView(), "Browser menu");
            sizes[2] = (tabs != null && tabs.isShown()) ? 1 : 0;
            sizes[3] = (menu != null && menu.isShown()) ? 1 : 0;
        });
        assertEquals("tab control must remain visible in landscape", 1, sizes[2]);
        assertEquals("menu must remain visible in landscape", 1, sizes[3]);

        runTestOnUiThread(() -> activity.setRequestedOrientation(
                ActivityInfo.SCREEN_ORIENTATION_PORTRAIT));
        getInstrumentation().waitForIdleSync();
    }

    /** A cold start must reach an interactive page within a generous budget. */
    public void testColdStartBudget() throws Throwable {
        long start = android.os.SystemClock.uptimeMillis();
        MainActivity activity = getActivity();
        final boolean[] ready = {false};
        runTestOnUiThread(() -> {
            View menu = find(activity.getWindow().getDecorView(), "Browser menu");
            ready[0] = menu != null && menu.isShown();
        });
        long elapsed = android.os.SystemClock.uptimeMillis() - start;
        assertTrue("browser toolbar was not interactive after 10s", ready[0] && elapsed < 10000);
    }
}
