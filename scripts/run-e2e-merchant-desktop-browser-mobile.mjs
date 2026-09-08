import assert from 'node:assert/strict';
import { access, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import * as bip39 from 'bip39';
import { remote } from 'webdriverio';

const projectRoot = process.cwd();
const captureDirectory = process.env.MERCHANT_E2E_CAPTURE_DIR?.trim() || '';

// The mnemonic stays in this Node process and is entered through the two
// isolated wallet UIs. It is never passed to Vite, Tauri, Firefox, or logged.
loadDotenv({ path: path.join(projectRoot, '.env'), override: false });
const mnemonic = process.env.OPTN_MERCHANT_E2E_MNEMONIC?.trim() ?? '';
if (!mnemonic) {
  console.error(
    'OPTN_MERCHANT_E2E_MNEMONIC is required. This runner never prints it.'
  );
  process.exit(2);
}
assert.equal(
  bip39.validateMnemonic(mnemonic, bip39.wordlists.english),
  true,
  'OPTN_MERCHANT_E2E_MNEMONIC is not a valid English mnemonic'
);

const appBinary =
  process.env.TAURI_E2E_APP_BINARY ??
  path.join(
    projectRoot,
    'src-tauri',
    'target',
    'debug',
    process.platform === 'win32'
      ? 'optn-wallet-desktop.exe'
      : 'optn-wallet-desktop'
  );
const tauriDriverBinary =
  process.env.TAURI_E2E_DRIVER_PATH ??
  path.join(
    homedir(),
    '.cargo',
    'bin',
    process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'
  );
const geckodriverBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'geckodriver.cmd' : 'geckodriver'
);
const viteBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite'
);
const browserPort = Number(process.env.MOBILE_UI_WEB_PORT ?? '4173');
const browserDriverPort = Number(process.env.MOBILE_UI_DRIVER_PORT ?? '4445');
const browserWidth = Number(process.env.MERCHANT_E2E_BROWSER_WIDTH ?? '390');
const browserHeight = Number(process.env.MERCHANT_E2E_BROWSER_HEIGHT ?? '844');
const desktopWebPort = 5174;
const desktopDriverPort = Number(
  process.env.MERCHANT_E2E_TAURI_DRIVER_PORT ?? '4444'
);
const desktopNativeDriverPort = Number(
  process.env.MERCHANT_E2E_TAURI_NATIVE_DRIVER_PORT ?? '4446'
);

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizedEnvironment(profileRoot) {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      /^(SNAP|GTK_|GDK_PIXBUF|GIO_|GSETTINGS|LOCPATH|VSCODE_NLS_CONFIG$|XDG_DATA_HOME$|XDG_DATA_DIRS$)/.test(
        key
      )
    ) {
      delete environment[key];
    }
  }
  delete environment.OPTN_MERCHANT_E2E_MNEMONIC;
  environment.XDG_DATA_HOME = path.join(profileRoot, 'data');
  environment.XDG_CONFIG_HOME = path.join(profileRoot, 'config');
  environment.XDG_CACHE_HOME = path.join(profileRoot, 'cache');
  environment.TAURI_E2E_ALLOW_MUTATION = '1';
  return environment;
}

async function waitForHttp(url, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Startup is asynchronous.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitFor(session, selector, timeout = 30_000) {
  const element = await session.$(selector);
  await element.waitForDisplayed({ timeout });
  return element;
}

async function waitForText(session, selector, text, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const element = await session.$(selector);
    if (
      (await element.isDisplayed().catch(() => false)) &&
      (await element.getText().catch(() => '')).includes(text)
    ) {
      return element;
    }
    await sleep(250);
  }
  throw new Error(`Expected ${selector} to contain "${text}"`);
}

async function captureSession(session, name) {
  if (!captureDirectory) return;
  mkdirSync(captureDirectory, { recursive: true });
  const screenshotPath = path.join(captureDirectory, `${name}.png`);
  await session.saveScreenshot(screenshotPath);
  console.log(
    `[merchant-pay-desktop-browser-mobile] captured ${screenshotPath}`
  );
}

async function click(session, selector, timeout = 30_000) {
  const element = await waitFor(session, selector, timeout);
  await element.waitForEnabled({ timeout });
  await element.click();
}

async function clickButtonContaining(session, text) {
  await click(session, `button*=${text}`);
}

async function assertChipnetUnit(session, label) {
  const homeText = await session
    .$('/html/body')
    .then((element) => element.getText());
  assert.match(
    homeText,
    /\btBCH\b/,
    `${label} Home should label the Chipnet native balance as tBCH.`
  );
}

async function importWallet(
  session,
  label,
  initialHeading,
  browserWallet = false
) {
  const words = mnemonic.split(/\s+/).filter(Boolean);
  try {
    await waitForText(session, 'h1', initialHeading, 60_000);
  } catch (error) {
    const body = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => 'unavailable');
    console.error(
      `[merchant-pay-desktop-browser-mobile] ${label} startup state: ${body.replace(/\s+/g, ' ').slice(0, 2200)}`
    );
    throw error;
  }
  await click(session, 'a=Import Wallet');
  await waitFor(session, 'h1=Import Wallet');

  if (words.length !== 12) {
    await (
      await waitFor(session, 'select[aria-label="Phrase length"]')
    ).selectByAttribute('value', String(words.length));
  }
  const inputs = await session.$$('input[placeholder="word"]');
  assert.equal(inputs.length, words.length);
  for (const [index, input] of inputs.entries()) {
    await input.setValue(words[index]);
  }
  if (browserWallet) {
    const mainnetSwitch = await session.$(
      'button[aria-label*="Current: Mainnet"]'
    );
    if (await mainnetSwitch.isExisting()) await mainnetSwitch.click();
    await click(session, 'button=Import Wallet');
    await waitFor(session, 'h1=Home', 60_000);
    // Home renders before the wallet worker has necessarily published the
    // imported wallet's UTXOs. Merchant Pay needs that spendable BCH set when
    // the buyer prepares the fixed-output transaction.
    await waitFor(session, 'button=Sync', 120_000);
    await assertChipnetUnit(session, label);
    console.log(`[merchant-pay-desktop-browser-mobile] ${label} wallet ready`);
    return;
  }

  await click(session, 'button=Continue');
  await waitFor(session, 'h1=Wallet Setup');
  const mainnetSwitch = await session.$(
    'button[aria-label*="Current: Mainnet"]'
  );
  if (await mainnetSwitch.isExisting()) await mainnetSwitch.click();
  await click(session, 'button=Continue');
  await waitFor(session, 'h1=Name This Wallet');

  const password = `optn-merchant-${label}-e2e-password`;
  await (
    await waitFor(session, 'input[placeholder="Wallet name"]')
  ).setValue(`Merchant Pay ${label} ${Date.now()}`);
  await (
    await waitFor(session, 'input[placeholder="Password (min 8 characters)"]')
  ).setValue(password);
  await (
    await waitFor(session, 'input[placeholder="Confirm password"]')
  ).setValue(password);
  await click(session, 'button=Import Wallet');
  await waitFor(session, 'h1=Home', 60_000);
  await assertChipnetUnit(session, label);
  console.log(`[merchant-pay-desktop-browser-mobile] ${label} wallet ready`);
}

async function waitForMerchantRequestOutcome(session, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const qr = await session.$('[data-merchant-proposal-payload]');
    if (await qr.isDisplayed().catch(() => false)) {
      return { kind: 'qr', element: qr };
    }

    const alert = await session.$('[role="alert"]');
    if (await alert.isDisplayed().catch(() => false)) {
      return { kind: 'error', message: await alert.getText() };
    }
    await sleep(250);
  }
  throw new Error(
    `Merchant request did not produce a QR or error within ${timeout}ms.`
  );
}

async function createMerchantProposal(session) {
  await click(session, 'a[href="#/settings"]');
  await waitForText(session, 'body', 'Connections & features');
  await clickButtonContaining(session, 'Connections & features');
  await clickButtonContaining(session, 'Merchant Pay');
  const defaultConversionSlider = await waitFor(
    session,
    '[data-testid="merchant-pay-default-conversion-slider"]'
  );
  assert.equal(
    await defaultConversionSlider.getAttribute('value'),
    '10000',
    'New wallets should default Merchant Pay conversion to 100 percent.'
  );
  await click(session, 'button=Back');
  await click(session, 'button=Back');

  await click(session, 'a[href="#/apps"]');
  await waitFor(session, 'h1=Apps');
  await clickButtonContaining(session, 'Merchant Pay');
  await waitFor(session, 'h1=Merchant Pay');
  await captureSession(session, 'desktop-merchant-amount');
  const merchantReceivesToggle = await waitFor(
    session,
    '[data-testid="merchant-settlement-toggle"]'
  );
  assert.equal(
    await merchantReceivesToggle.getAttribute('aria-expanded'),
    'false',
    'Settlement split should start collapsed.'
  );
  await merchantReceivesToggle.click();
  assert.equal(
    await merchantReceivesToggle.getAttribute('aria-expanded'),
    'true',
    'Settlement split should expand on demand.'
  );
  await captureSession(session, 'desktop-merchant-amount-expanded');
  await merchantReceivesToggle.click();
  assert.equal(
    await merchantReceivesToggle.getAttribute('aria-expanded'),
    'false',
    'Settlement split should collapse on demand.'
  );
  await merchantReceivesToggle.click();
  const conversionSlider = await waitFor(
    session,
    '[data-testid="merchant-conversion-slider"]'
  );
  assert.equal(await conversionSlider.getAttribute('min'), '0');
  assert.equal(await conversionSlider.getAttribute('max'), '10000');
  await conversionSlider.setValue('5000');
  assert.equal(
    await conversionSlider.getAttribute('value'),
    '5000',
    'Merchant conversion slider should update in single-cent precision.'
  );

  const convertedPortion = await waitFor(
    session,
    'button[aria-label^="Toggle converted portion between"]'
  );
  const convertedMerchantText = await convertedPortion.getText();
  assert.match(convertedMerchantText, /PUSD/);
  await convertedPortion.click();
  const convertedCustomerText = await convertedPortion.getText();
  assert.notEqual(
    convertedCustomerText,
    convertedMerchantText,
    'Converted portion should toggle between merchant and customer amounts.'
  );
  assert.match(convertedCustomerText, /BCH/);
  await convertedPortion.click();

  const paidDirectly = await waitFor(
    session,
    'button[aria-label^="Toggle direct portion between"]'
  );
  const directMerchantText = await paidDirectly.getText();
  assert.match(directMerchantText, /BCH/);
  await paidDirectly.click();
  const directCustomerText = await paidDirectly.getText();
  assert.notEqual(
    directCustomerText,
    directMerchantText,
    'Paid directly should toggle between merchant and customer amounts.'
  );
  assert.match(directCustomerText, /PUSD/);
  await paidDirectly.click();

  await click(session, '[data-testid="merchant-target-asset-bch"]');
  const bchTargetConversionSlider = await waitFor(
    session,
    '[data-testid="merchant-conversion-slider"]'
  );
  assert.match(
    await bchTargetConversionSlider.getAttribute('aria-label'),
    /PUSD/,
    'BCH target payments should still expose conversion to PUSD.'
  );
  await click(session, '[data-testid="merchant-target-asset-token"]');

  for (const key of ['0', '.', '0', '2']) {
    const keyId = key === '.' ? 'decimal' : key;
    await click(session, `[data-testid="merchant-key-${keyId}"]`);
    const amountDisplay = await waitFor(
      session,
      '[data-testid="merchant-amount-display"]'
    );
    console.log(
      `[merchant-pay-desktop-browser-mobile] keypad ${key} -> ${await amountDisplay.getText()}`
    );
  }
  const enteredAmount = await waitFor(
    session,
    '[data-testid="merchant-amount-display"]'
  );
  assert.equal(
    await enteredAmount.getText(),
    '0.02',
    'Merchant keypad should preserve the PUSD decimal amount.'
  );
  console.log(
    '[merchant-pay-desktop-browser-mobile] merchant requested 0.02 PUSD'
  );

  const createRequest = await waitFor(session, 'button*=Request');
  await createRequest.waitForEnabled({ timeout: 120_000 });
  await createRequest.click();
  console.log(
    '[merchant-pay-desktop-browser-mobile] merchant request creation started'
  );
  await captureSession(session, 'desktop-merchant-request-preparing');

  const requestTimeout =
    Number.parseInt(process.env.MERCHANT_E2E_QR_TIMEOUT_MS ?? '', 10) || 60_000;
  const outcome = await waitForMerchantRequestOutcome(session, requestTimeout);
  if (outcome.kind === 'error') {
    throw new Error(`Merchant request failed: ${outcome.message}`);
  }

  const qr = outcome.element;
  await waitFor(session, '[data-merchant-proposal-payload]');
  assert.match(
    await session.$('/html/body').then((element) => element.getText()),
    /BCH/
  );
  const payload = await qr.getAttribute('data-merchant-proposal-payload');
  const payloadObject = JSON.parse(payload ?? 'null');
  assert.equal(
    payloadObject?.application?.applicationId,
    'optn.builtin.merchant-pay.transaction-proposal'
  );
  console.log(
    `[merchant-pay-desktop-browser-mobile] merchant QR ready (${payload?.length ?? 0} chars)`
  );
  await captureSession(session, 'desktop-merchant-request');
  const qrDialog = await waitFor(
    session,
    '[role="dialog"][aria-label="Merchant payment QR code"]'
  );
  const popupQrVisible = await qrDialog
    .$('svg')
    .isDisplayed()
    .catch(() => false);
  const popupStreamVisible = await qrDialog
    .$('[data-testid="merchant-payment-stream-qr"]')
    .isDisplayed()
    .catch(() => false);
  assert.equal(
    popupQrVisible || popupStreamVisible,
    true,
    'Merchant QR popup should display either a normal or streamed QR.'
  );
  await captureSession(session, 'desktop-merchant-request-qr');
  await click(session, 'button[aria-label="Close QR code"]');
  await waitFor(session, '[data-testid="merchant-payment-waiting"]');
  await captureSession(session, 'desktop-merchant-request-waiting');
  await waitForText(session, 'body', 'Customer pays BCH');
  await waitFor(session, 'button=Show QR code');
  await click(session, 'button=Show QR code');
  await waitFor(
    session,
    '[role="dialog"][aria-label="Merchant payment QR code"]'
  );
  await waitFor(session, 'div*=Waiting for buyer');
  return payload;
}

async function routeProposalToBrowserBuyer(session, payload) {
  await waitFor(session, 'h1=Home');
  await click(session, 'button[aria-label="Scan QR"]');
  const payloadInput = await waitFor(
    session,
    '[data-testid="home-scan-input"]'
  );
  await payloadInput.setValue(payload);
  await click(session, '[data-testid="home-scan-continue"]');
  try {
    await waitForText(session, 'body', 'Pay merchant', 30_000);
  } catch (error) {
    const body = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => 'unavailable');
    const url = await session.getUrl().catch(() => 'unavailable');
    console.error(
      `[merchant-pay-desktop-browser-mobile] buyer route state: url=${url} body=${body.replace(/\s+/g, ' ').slice(0, 3000)}`
    );
    throw error;
  }

  const merchantPageText = await session
    .$('/html/body')
    .then((element) => element.getText());
  assert.match(merchantPageText, /Merchant receives[\s\S]*(PUSD|BCH)/i);
  await captureSession(session, 'browser-mobile-buyer-payment');

  const deadline = Date.now() + 120_000;
  const prepare = await session.$('button=Prepare payment');
  if (await prepare.isExisting().catch(() => false)) {
    await prepare.scrollIntoView({ block: 'center' }).catch(() => undefined);
  }
  if (await prepare.isEnabled().catch(() => false)) {
    await prepare.click();
    await sleep(800);
    const preparationBody = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => 'unavailable');
    console.log(
      `[merchant-pay-desktop-browser-mobile] buyer preparation state: ${preparationBody.replace(/\s+/g, ' ').slice(0, 1800)}`
    );
    if (preparationBody.includes('Not enough BCH UTXOs')) {
      throw new Error(
        'Buyer fixture has no spendable BCH UTXO after wallet sync; fund the Chipnet fixture before running the full payment cycle.'
      );
    }
  }
  let paymentButton;
  while (Date.now() < deadline) {
    const review = await session.$(
      '[data-testid="merchant-payment-review-cta"]'
    );
    if (
      (await review.isDisplayed().catch(() => false)) &&
      (await review.isEnabled().catch(() => false))
    ) {
      paymentButton = review;
      break;
    }
    await sleep(250);
  }

  if (!paymentButton) {
    const browserLogs = session.getLogs
      ? await session.getLogs('browser').catch(() => [])
      : [];
    const state = await session
      .execute(() => ({
        body: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 2200),
        buttons: [...document.querySelectorAll('button')].map((button) => ({
          text: button.textContent?.trim() ?? '',
          disabled: button.disabled,
        })),
        consoleErrors: window.__optnE2eErrors ?? [],
      }))
      .catch(() => null);
    throw new Error(
      `Buyer payment CTA did not become available: ${JSON.stringify({ state: state?.value ?? state, browserLogs: browserLogs.slice(-12) })}`
    );
  }
  await paymentButton.click();
  await captureSession(session, 'browser-mobile-buyer-after-pay-click');
  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-label="Review Merchant Payment"]',
    30_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Merchant receives[\s\S]*(PUSD|BCH)/i);
  assert.match(reviewText, /You pay[\s\S]*BCH/i);
  assert.match(reviewText, /Merchant[\s\S]*Change/i);
  assert.match(reviewText, /Remaining BCH returns to your wallet/);
  assert.equal(
    await reviewDialog
      .$('[data-testid="swipe-confirm-track"]')
      .isDisplayed()
      .catch(() => false),
    true,
    'Merchant review should expose the swipe confirmation control.'
  );
  console.log(
    '[merchant-pay-desktop-browser-mobile] browser mobile buyer reached fixed-output review'
  );
}

async function broadcastBuyerPayment(session) {
  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-label="Review Merchant Payment"]',
    30_000
  );
  const track = await waitFor(session, '[data-testid="swipe-confirm-track"]');
  const handle = await waitFor(session, '[data-testid="swipe-confirm-handle"]');
  const trackLocation = await track.getLocation();
  const trackSize = await track.getSize();
  const handleLocation = await handle.getLocation();
  const handleSize = await handle.getSize();
  await session.performActions([
    {
      type: 'pointer',
      id: 'merchant-payment-confirm',
      parameters: { pointerType: 'mouse' },
      actions: [
        {
          type: 'pointerMove',
          x: Math.round(handleLocation.x + handleSize.width / 2),
          y: Math.round(handleLocation.y + handleSize.height / 2),
        },
        { type: 'pointerDown', button: 0 },
        {
          type: 'pointerMove',
          x: Math.round(trackLocation.x + trackSize.width - 4),
          y: Math.round(trackLocation.y + trackSize.height / 2),
          duration: 500,
        },
        { type: 'pointerUp', button: 0 },
      ],
    },
  ]);
  await session.releaseActions();

  const broadcastDeadline = Date.now() + 60_000;
  while (Date.now() < broadcastDeadline) {
    const body = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => '');
    if (body.includes('0-conf accepted') && body.includes('Transaction ID')) {
      await captureSession(session, 'browser-mobile-payment-sent');
      await click(session, '[data-testid="merchant-payment-done"]');
      await waitForText(session, 'h1', 'Merchant Pay', 30_000);
      await waitFor(session, '[data-testid="merchant-amount-display"]');
      console.log(
        '[merchant-pay-desktop-browser-mobile] buyer signed and broadcast the Chipnet payment, then returned to Merchant Pay'
      );
      return;
    }
    await sleep(250);
  }
  const body = await session
    .$('/html/body')
    .then((element) => element.getText())
    .catch(() => 'unavailable');
  throw new Error(
    `Buyer confirmation did not report broadcast completion. State: ${body.replace(/\s+/g, ' ').slice(0, 2200)}`
  );
}

async function waitForMerchantPayment(session) {
  await waitForText(session, 'body', 'Payment received · 0-conf', 120_000);
  await waitForText(session, 'body', 'PUSD', 30_000);
  const qrDialog = await session.$(
    '[role="dialog"][aria-label="Merchant payment QR code"]'
  );
  assert.equal(
    await qrDialog.isDisplayed().catch(() => false),
    false,
    'Merchant QR dialog should close when the payment is detected.'
  );
  await waitFor(session, '[data-testid="merchant-amount-display"]', 10_000);
  assert.match(
    await session.$('/html/body').then((element) => element.getText()),
    /Ready for a new payment/,
    'Merchant should return to the amount keypad after receiving payment.'
  );
  await captureSession(session, 'desktop-merchant-payment-received');
  console.log(
    '[merchant-pay-desktop-browser-mobile] merchant detected the exact payment output at 0-conf and returned to the amount keypad'
  );
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'optn-merchant-desktop-browser-mobile-e2e-')
);
const profileRoot = path.join(temporaryRoot, 'desktop-profile');
for (const directory of ['data', 'config', 'cache']) {
  mkdirSync(path.join(profileRoot, directory), { recursive: true });
}

let tauriDriver;
let geckodriver;
let viteProcess;
let desktopViteProcess;
let merchantSession;
let buyerSession;
try {
  await new Promise((resolve, reject) =>
    access(appBinary, (error) => (error ? reject(error) : resolve()))
  );
  const allowBroadcast = process.env.OPTN_MERCHANT_E2E_ALLOW_BROADCAST === '1';
  if (process.env.OPTN_MERCHANT_E2E_ALLOW_BROADCAST && !allowBroadcast) {
    throw new Error(
      'Set OPTN_MERCHANT_E2E_ALLOW_BROADCAST to 1 for the live Chipnet broadcast test, or omit it for review-only mode.'
    );
  }

  viteProcess = spawn(
    viteBinary,
    [
      '--config',
      path.join(projectRoot, 'vite.e2e.config.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      String(browserPort),
      '--strictPort',
    ],
    {
      cwd: projectRoot,
      env: sanitizedEnvironment(path.join(temporaryRoot, 'browser-profile')),
      stdio: 'ignore',
    }
  );
  await waitForHttp(`http://127.0.0.1:${browserPort}/`);

  geckodriver = spawn(
    geckodriverBinary,
    ['--port', String(browserDriverPort), '--log', 'fatal'],
    {
      cwd: projectRoot,
      env: sanitizedEnvironment(profileRoot),
      stdio: 'ignore',
    }
  );
  await waitForHttp(`http://127.0.0.1:${browserDriverPort}/status`);
  buyerSession = await remote({
    hostname: '127.0.0.1',
    port: browserDriverPort,
    logLevel: 'warn',
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 2,
    capabilities: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless'] },
    },
  });
  await buyerSession.setWindowSize(browserWidth, browserHeight);
  await buyerSession.url(`http://127.0.0.1:${browserPort}/`);
  await importWallet(
    buyerSession,
    'Browser Buyer',
    'Powered with Bitcoin Covenants for Bitcoin Cash',
    true
  );

  desktopViteProcess = spawn(
    viteBinary,
    [
      '--config',
      path.join(projectRoot, 'vite.desktop.config.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      String(desktopWebPort),
      '--strictPort',
    ],
    {
      cwd: projectRoot,
      env: sanitizedEnvironment(profileRoot),
      stdio: 'ignore',
    }
  );
  await waitForHttp(`http://127.0.0.1:${desktopWebPort}/`);

  tauriDriver = spawn(
    tauriDriverBinary,
    [
      '--port',
      String(desktopDriverPort),
      '--native-port',
      String(desktopNativeDriverPort),
    ],
    {
      cwd: projectRoot,
      env: sanitizedEnvironment(profileRoot),
      stdio: 'ignore',
    }
  );
  await waitForHttp(`http://127.0.0.1:${desktopDriverPort}/status`);
  merchantSession = await remote({
    hostname: '127.0.0.1',
    port: desktopDriverPort,
    logLevel: 'warn',
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 2,
    capabilities: { 'tauri:options': { application: appBinary } },
  });
  await importWallet(merchantSession, 'Desktop Merchant', 'OPTN Wallet');

  const payload = await createMerchantProposal(merchantSession);
  await routeProposalToBrowserBuyer(buyerSession, payload);
  if (allowBroadcast) {
    await broadcastBuyerPayment(buyerSession);
    await waitForMerchantPayment(merchantSession);
    console.log(
      '[merchant-pay-desktop-browser-mobile] PASS: Chipnet payment broadcast and merchant 0-conf receipt verified'
    );
  } else {
    console.log(
      '[merchant-pay-desktop-browser-mobile] PASS: desktop merchant + browser mobile buyer reached review; no broadcast performed'
    );
  }
} finally {
  await merchantSession?.deleteSession().catch(() => undefined);
  await buyerSession?.deleteSession().catch(() => undefined);
  if (tauriDriver && tauriDriver.exitCode == null) tauriDriver.kill('SIGTERM');
  if (geckodriver && geckodriver.exitCode == null) geckodriver.kill('SIGTERM');
  if (viteProcess && viteProcess.exitCode == null) viteProcess.kill('SIGTERM');
  if (desktopViteProcess && desktopViteProcess.exitCode == null)
    desktopViteProcess.kill('SIGTERM');
  rmSync(temporaryRoot, { recursive: true, force: true });
}
