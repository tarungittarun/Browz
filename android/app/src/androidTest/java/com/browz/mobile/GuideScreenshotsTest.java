package com.browz.mobile;

import android.graphics.Bitmap;
import android.content.ContentValues;
import android.net.Uri;
import android.provider.MediaStore;
import android.test.ActivityInstrumentationTestCase2;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import java.io.OutputStream;

/** Captures documentation on a clean emulator. Screen protection is disabled only in this test. */
@SuppressWarnings("deprecation")
public class GuideScreenshotsTest extends ActivityInstrumentationTestCase2<MainActivity> {
    public GuideScreenshotsTest() { super(MainActivity.class); }
    private View find(View v, String description) {
        if (description.contentEquals(v.getContentDescription() == null ? "" : v.getContentDescription())) return v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup)v).getChildCount(); i++) {
            View match = find(((ViewGroup)v).getChildAt(i), description);
            if (match != null) return match;
        }
        return null;
    }
    private void capture(MainActivity activity, String name) throws Exception {
        Thread.sleep(1500);
        Bitmap image = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Emulator screenshot", image);
        ContentValues values = new ContentValues();
        values.put(MediaStore.Images.Media.DISPLAY_NAME, name + ".png");
        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
        values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/BrowzGuide");
        Uri uri = activity.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
        assertNotNull(uri);
        try (OutputStream output = activity.getContentResolver().openOutputStream(uri)) {
            assertNotNull(output);
            assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output));
        }
        image.recycle();
    }
    public void testCapture() throws Throwable {
        MainActivity activity = getActivity();
        runTestOnUiThread(() -> activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE));
        getInstrumentation().waitForIdleSync();
        capture(activity, "mobile-home");
        View menu = find(activity.getWindow().getDecorView(), "Browser menu");
        assertNotNull(menu);
        runTestOnUiThread(menu::performClick);
        getInstrumentation().waitForIdleSync();
        capture(activity, "mobile-menu");
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        View tabs = find(activity.getWindow().getDecorView(), "Open tabs");
        assertNotNull(tabs);
        runTestOnUiThread(tabs::performClick);
        getInstrumentation().waitForIdleSync();
        capture(activity, "mobile-tabs");
    }
}
