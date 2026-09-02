package com.getcapacitor.myapp;

import static org.junit.Assert.*;

import android.content.Context;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import optn.wallet.app.MainActivity;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Instrumented test, which will execute on an Android device.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4.class)
public class ExampleInstrumentedTest {

    @Test
    public void useAppContext() throws Exception {
        // Context of the app under test.
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();

        assertEquals("optn.wallet.app", appContext.getPackageName());
    }

    @Test
    public void mainActivity_launchesInExpectedPackage() {
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        scenario.onActivity(activity ->
            assertEquals("optn.wallet.app", activity.getPackageName())
        );
        scenario.close();
    }

    private boolean evaluateBoolean(
        ActivityScenario<MainActivity> scenario,
        String javascript
    ) throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>("false");
        scenario.onActivity(activity ->
            activity.getBridge().getWebView().evaluateJavascript(javascript, result -> {
                value.set(result);
                latch.countDown();
            })
        );
        if (!latch.await(5, TimeUnit.SECONDS)) return false;
        return "true".equals(value.get());
    }

    private void waitForJavascriptTrue(
        ActivityScenario<MainActivity> scenario,
        String javascript,
        String failureMessage
    ) throws Exception {
        long deadline = System.currentTimeMillis() + 30_000L;
        while (System.currentTimeMillis() < deadline) {
            if (evaluateBoolean(scenario, javascript)) return;
            Thread.sleep(250L);
        }
        fail(failureMessage);
    }

    @Test
    public void androidLanding_exposesAndOpensWatchOnlyWallet() throws Exception {
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        try {
            // This exercises the actual APK WebView and real platform capability
            // detection. A mocked React test cannot catch a mobile artifact that
            // silently drops the watch-only action.
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('a[href$=\"#/watch-only\"]'))",
                "Android landing page did not expose the Watch-Only wallet action"
            );

            waitForJavascriptTrue(
                scenario,
                "(() => {" +
                    "const el = document.querySelector('a[href$=\"#/watch-only\"]');" +
                    "if (!el) return false;" +
                    "const r = el.getBoundingClientRect();" +
                    "return r.width > 0 && r.height > 0 && r.top >= 0 && " +
                    "r.bottom <= window.innerHeight;" +
                "})()",
                "Watch-Only action exists but is outside the initial Android viewport"
            );

            scenario.onActivity(activity ->
                activity.getBridge().getWebView().evaluateJavascript(
                    "document.querySelector('a[href$=\"#/watch-only\"]').click()",
                    ignored -> {}
                )
            );

            waitForJavascriptTrue(
                scenario,
                "Boolean([...document.querySelectorAll('h1,h2')].find(" +
                    "el => el.textContent?.includes('Create Watch-Only Wallet')))",
                "Watch-Only action did not open the mobile watch-only setup screen"
            );

            waitForJavascriptTrue(
                scenario,
                "Boolean([...document.querySelectorAll('label')].find(" +
                    "el => el.textContent?.includes('Master fingerprint')))",
                "Mobile watch-only setup did not expose the optional master fingerprint"
            );
        } finally {
            scenario.close();
        }
    }
}

