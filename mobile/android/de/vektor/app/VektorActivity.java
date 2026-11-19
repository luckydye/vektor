package de.vektor.app;

import android.app.NativeActivity;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * GPUI's NativeActivity plus the web UI in Android's WebView (see vektor-mobile/src/android.rs).
 *
 * The native surface owns the activity's window, which then draws no views of its own: the
 * WebView lives in a panel window above it, placed over the area GPUI lays out for it. Every
 * WebView call runs on the UI thread, in the order the app made it.
 */
public final class VektorActivity extends NativeActivity {
    /** Whether the main frame's navigation to `url` leaves the app, which opens it elsewhere. */
    static native boolean leaves(String url);

    /** A `window.ipc.postMessage` from the page. */
    static native void message(String json);

    /** A link to the app's URL scheme, e.g. a browser sign-in handing back its code. */
    static native void opened(String link);

    private WebView page;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Edge to edge on every version, as from Android 15 on: GPUI's surface covers the screen
        // and lays out the page in the same pixels the panel is placed in.
        getWindow().setDecorFitsSystemWindows(false);
    }

    /**
     * Shows `url`. The page finds `app` as `vektorAndroid.app()`, before any of its scripts runs;
     * `script` runs once each document has loaded.
     */
    public void showPage(String url, String app, String script) {
        runOnUiThread(() -> {
            WebView view = new WebView(this);
            WebSettings settings = view.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            view.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public void postMessage(String json) {
                    message(json);
                }
            }, "ipc");
            view.addJavascriptInterface(new Object() {
                @JavascriptInterface
                public String app() {
                    return app;
                }
            }, "vektorAndroid");
            view.setWebViewClient(new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    // Frames (e.g. Figma embeds) load whatever they like.
                    return request.isForMainFrame() && leaves(request.getUrl().toString());
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    view.evaluateJavascript(script, null);
                }
            });
            // The panel has the keyboard focus, so Back arrives here: it goes back in the page's
            // history, and from its first page to the home screen, like any root screen.
            view.setOnKeyListener((v, keyCode, event) -> {
                if (keyCode != KeyEvent.KEYCODE_BACK) return false;
                if (event.getAction() == KeyEvent.ACTION_UP) {
                    if (view.canGoBack()) view.goBack();
                    else moveTaskToBack(true);
                }
                return true;
            });
            WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
                    // Touches outside the panel go to the native surface below.
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.OPAQUE);
            params.token = getWindow().getDecorView().getWindowToken();
            params.gravity = Gravity.TOP | Gravity.START;
            params.width = 0;
            params.height = 0;
            // Placed in screen pixels exactly where GPUI lays it out, system bars or not.
            params.setFitInsetsTypes(0);
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            // Moves the panel up so the focused field stays above the keyboard.
            params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN;
            getWindowManager().addView(view, params);
            view.loadUrl(url);
            page = view;
        });
    }

    /** Places the page at `x`, `y` with the given size, in physical pixels. */
    public void placePage(int x, int y, int width, int height) {
        runOnUiThread(() -> {
            WindowManager.LayoutParams params = (WindowManager.LayoutParams) page.getLayoutParams();
            if (params.x == x && params.y == y && params.width == width && params.height == height) {
                return;
            }
            params.x = x;
            params.y = y;
            params.width = width;
            params.height = height;
            getWindowManager().updateViewLayout(page, params);
        });
    }

    public void loadPage(String url) {
        runOnUiThread(() -> page.loadUrl(url));
    }

    public void evaluate(String script) {
        runOnUiThread(() -> page.evaluateJavascript(script, null));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) opened(intent.getDataString());
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (page != null) page.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (page != null) page.onResume();
    }

    @Override
    protected void onDestroy() {
        // The panel must not outlive the window it is attached to.
        if (page != null) getWindowManager().removeViewImmediate(page);
        super.onDestroy();
    }
}
