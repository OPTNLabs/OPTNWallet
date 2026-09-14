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
        waitForJavascriptTrue(scenario, javascript, failureMessage, 30_000L);
    }

    private void waitForJavascriptTrue(
        ActivityScenario<MainActivity> scenario,
        String javascript,
        String failureMessage,
        long timeoutMs
    ) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
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
            assertWatchOnlyLandingVisible(scenario);
            clickWatchOnlyLanding(scenario);
            waitForJavascriptTrue(
                scenario,
                "Boolean([...document.querySelectorAll('h1,h2')].find(" +
                    "el => el.textContent?.includes('Create Watch-Only Wallet')))",
                "Watch-Only action did not open the mobile watch-only setup screen"
            );
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"watch-only-fingerprint\"]'))",
                "Mobile watch-only setup did not expose the optional master fingerprint"
            );
        } finally {
            scenario.close();
        }
    }

    @Test
    public void androidLanding_watchOnlyCreate() throws Exception {
        // Chipnet account tpub from the BIP39 all-abandon mnemonic at m/44'/1'/0'.
        // Public key material only; this test never imports a seed.
        final String chipnetAccountTpub =
            "tpubDC5FSnBiZDMmhiuCmWAYsLwgLYrrT9rAqvTySfuCCrgsWz8wxMXUS9Tb9iVMvcRbvFcAHGkMD5Kx8koh4GquNGNTfohfk7pgjhaPCdXpoba";
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        try {
            assertWatchOnlyLandingVisible(scenario);
            clickWatchOnlyLanding(scenario);

            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"watch-only-create\"]'))",
                "Watch-only setup did not render the create action"
            );

            scenario.onActivity(activity ->
                activity.getBridge().getWebView().evaluateJavascript(
                    fillWatchOnlyFormScript(chipnetAccountTpub),
                    ignored -> {}
                )
            );

            waitForJavascriptTrue(
                scenario,
                "Boolean(document.body.innerText.includes('bchtest:q'))",
                "Watch-only setup did not derive a Chipnet receive address from the account xPub"
            );

            scenario.onActivity(activity ->
                activity.getBridge().getWebView().evaluateJavascript(
                    "document.querySelector('[data-testid=\"watch-only-create\"]').click()",
                    ignored -> {}
                )
            );

            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"home-receive-action\"]'))",
                "Watch-only wallet was not created from the packaged Android app",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                noSeedSigningScript(),
                "New watch-only wallet exposed a seed-signing path"
            );
        } finally {
            scenario.close();
        }
    }

    @Test
    public void androidLanding_watchOnlyRelaunch() throws Exception {
        // CI runs this in a new instrumentation invocation after the create
        // test exits and the workflow force-stops the target app. Android's
        // runner treats killing the target inside a live instrumentation
        // session as a process crash, so process-death persistence must span
        // two invocations rather than one test method.
        ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class);
        try {
            // The mobile home screen does not display the wallet name or its
            // receive address. Wait for its real action, then prove the saved
            // public keys and watch-only type through Receive and Send below.
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"home-receive-action\"]'))",
                "Watch-only wallet did not survive Android force-stop and process relaunch",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                noSeedSigningScript(),
                "Relaunched watch-only wallet exposed a seed-signing path"
            );

            openHashRoute(scenario, "/receive");
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"receive-address\"]') || " +
                    "document.body.innerText.includes('bchtest:q'))",
                "Force-stopped watch-only wallet did not expose receive derivation",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                noSeedSigningScript(),
                "Receive on a watch-only wallet exposed a seed-signing path"
            );
            waitForJavascriptTrue(
                scenario,
                "Boolean(![...document.querySelectorAll('button')].some(" +
                    "el => el.textContent?.trim() === 'PrivKey'))",
                "Public-only watch-only wallet offered private-key export"
            );

            openHashRoute(scenario, "/send");
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"watch-only-send-workspace\"]') || " +
                    "document.body.innerText.includes('Watch-only Send'))",
                "Force-stopped watch-only wallet did not open the unsigned-PSBT send path",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                "Boolean(document.querySelector('[data-testid=\"watch-only-build-unsigned\"]') || " +
                    "document.body.innerText.includes('Build unsigned transaction'))",
                "Watch-only send path did not expose unsigned PSBT construction",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                "Boolean([...document.querySelectorAll('span')].some(el => " +
                    "/Change\\s*→\\s*bchtest:/.test(el.textContent || '')) && " +
                    "!document.body.innerText.includes('no such column'))",
                "Relaunched watch-only send failed to load its persisted public metadata and change address",
                45_000L
            );
            waitForJavascriptTrue(
                scenario,
                noSeedSigningScript() +
                    " && Boolean(!document.body.innerText.includes('Enter your secret recovery phrase'))",
                "Watch-only send path exposed seed signing"
            );
        } finally {
            scenario.close();
        }
    }

    private void assertWatchOnlyLandingVisible(ActivityScenario<MainActivity> scenario)
        throws Exception {
        waitForJavascriptTrue(
            scenario,
            "(() => {" +
                "const el = document.querySelector('[data-testid=\"watch-only-landing-action\"], a[href*=\"watch-only\"]');" +
                "if (!el) return false;" +
                "const r = el.getBoundingClientRect();" +
                "return r.width > 0 && r.height > 0 && r.top >= 0 && " +
                "r.bottom <= (window.innerHeight + 8);" +
            "})()",
            "Android landing page did not expose Watch Only in the initial viewport"
        );
    }

    private void openHashRoute(ActivityScenario<MainActivity> scenario, String route) {
        scenario.onActivity(activity ->
            activity.getBridge().getWebView().evaluateJavascript(
                "window.location.hash = '#" + route + "'",
                ignored -> {}
            )
        );
    }

    private String noSeedSigningScript() {
        return "Boolean(" +
            "!document.body.innerText.includes('Enter your secret recovery phrase') && " +
            "!document.body.innerText.includes('Your secret recovery phrase') && " +
            "!document.querySelector('textarea[name=\"mnemonic\"], input[name=\"mnemonic\"]')" +
            ")";
    }

    private void clickWatchOnlyLanding(ActivityScenario<MainActivity> scenario) {
        scenario.onActivity(activity ->
            activity.getBridge().getWebView().evaluateJavascript(
                "document.querySelector('[data-testid=\"watch-only-landing-action\"], a[href*=\"watch-only\"]').click()",
                ignored -> {}
            )
        );
    }

    private String fillWatchOnlyFormScript(String tpub) {
        return "(() => {" +
            "function setValue(el, value) {" +
            "  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
            "  const desc = Object.getOwnPropertyDescriptor(proto, 'value');" +
            "  desc.set.call(el, value);" +
            "  el.dispatchEvent(new Event('input', { bubbles: true }));" +
            "  el.dispatchEvent(new Event('change', { bubbles: true }));" +
            "}" +
            "const network = document.querySelector('[data-testid=\"watch-only-network\"]');" +
            "if (network) {" +
            "  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;" +
            "  setter.call(network, 'chipnet');" +
            "  network.dispatchEvent(new Event('input', { bubbles: true }));" +
            "  network.dispatchEvent(new Event('change', { bubbles: true }));" +
            "}" +
            "setValue(document.querySelector('[data-testid=\"watch-only-wallet-name\"]'), 'E2E Watch Only');" +
            "setValue(document.querySelector('[data-testid=\"watch-only-account-xpub\"]'), '" + tpub + "');" +
            "setValue(document.querySelector('[data-testid=\"watch-only-fingerprint\"]'), 'deadbeef');" +
            "return true;" +
            "})()";
    }
}

