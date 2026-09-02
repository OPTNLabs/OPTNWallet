import assert from 'node:assert/strict';
import {
  access,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import * as bip39 from 'bip39';
import { remote } from 'webdriverio';

const projectRoot = process.cwd();

// This is the only runner that reads the local mnemonic. It is kept in this
// Node process, is never passed to either app process, and is never printed.
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
const viteBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite.cmd' : 'vite'
);
const driverBinary =
  process.env.TAURI_E2E_DRIVER_PATH ??
  path.join(
    homedir(),
    '.cargo',
    'bin',
    process.platform === 'win32' ? 'tauri-driver.exe' : 'tauri-driver'
  );
const packageName = 'optn.wallet.app';
const emulatorName = process.env.ANDROID_AVD ?? 'Pixel_9';
const cdpPort = Number(process.env.ANDROID_UI_CDP_PORT ?? '9222');

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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

async function waitForDriver(driver) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (driver.exitCode != null) {
      throw new Error(`tauri-driver exited with code ${driver.exitCode}`);
    }
    try {
      const response = await fetch('http://127.0.0.1:4444/status');
      if (response.status < 500) return;
    } catch {
      // Driver startup is asynchronous.
    }
    await sleep(250);
  }
  throw new Error('Timed out waiting for tauri-driver');
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

async function startDesktopDriver(profileRoot) {
  const driver = spawn(driverBinary, [], {
    env: sanitizedEnvironment(profileRoot),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  driver.stdout.on('data', (chunk) =>
    process.stderr.write(`[driver] ${chunk}`)
  );
  driver.stderr.on('data', (chunk) =>
    process.stderr.write(`[driver] ${chunk}`)
  );
  await waitForDriver(driver);
  return driver;
}

async function waitFor(session, selector, timeout = 30_000) {
  const element = await session.$(selector);
  await element.waitForDisplayed({ timeout });
  return element;
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

async function click(session, selector, timeout = 30_000) {
  const element = await waitFor(session, selector, timeout);
  await element.waitForEnabled({ timeout });
  await element.click();
}

async function clickButtonContaining(session, text) {
  await click(session, `button*=${text}`);
}

async function importDesktopWallet(session) {
  const words = mnemonic.split(/\s+/).filter(Boolean);
  await waitFor(session, 'h1=OPTN Wallet', 60_000);
  console.log('[merchant-pay-desktop-mobile] desktop landing ready');
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
  await click(session, 'button=Continue');
  await waitFor(session, 'h1=Wallet Setup');
  const mainnetSwitch = await session.$(
    'button[aria-label*="Current: Mainnet"]'
  );
  if (await mainnetSwitch.isExisting()) await mainnetSwitch.click();
  await click(session, 'button=Continue');
  await waitFor(session, 'h1=Name This Wallet');

  const password = 'optn-merchant-desktop-mobile-e2e-password';
  await (
    await waitFor(session, 'input[placeholder="Wallet name"]')
  ).setValue(`Merchant Pay Desktop ${Date.now()}`);
  await (
    await waitFor(session, 'input[placeholder="Password (min 8 characters)"]')
  ).setValue(password);
  await (
    await waitFor(session, 'input[placeholder="Confirm password"]')
  ).setValue(password);
  await click(session, 'button=Import Wallet');
  await waitFor(session, 'h1=Home', 60_000);
  console.log('[merchant-pay-desktop-mobile] desktop merchant wallet ready');
}

async function createMerchantProposal(session) {
  await click(session, 'a[href="#/apps"]');
  await waitFor(session, 'h1=Apps');
  await clickButtonContaining(session, 'Merchant Pay');
  await waitFor(session, 'h1=Merchant Pay');
  for (const key of ['0', '.', '0', '2']) {
    const keyId = key === '.' ? 'decimal' : key;
    await click(session, `[data-testid="merchant-key-${keyId}"]`);
  }
  console.log('[merchant-pay-desktop-mobile] merchant set 0.02 BCH');

  const createRequest = await waitFor(session, 'button*=Request');
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await createRequest.isEnabled()) break;
    await sleep(500);
  }
  if (!(await createRequest.isEnabled())) {
    const body = await (await session.$('body')).getText();
    throw new Error(
      `Merchant quote did not become ready: ${body.replace(/\s+/g, ' ').slice(-300)}`
    );
  }
  await createRequest.click();
  console.log('[merchant-pay-desktop-mobile] create request clicked');

  let qr;
  try {
    const qrTimeout =
      Number.parseInt(process.env.MERCHANT_E2E_QR_TIMEOUT_MS ?? '', 10) ||
      150_000;
    const outcome = await waitForMerchantRequestOutcome(session, qrTimeout);
    if (outcome.kind === 'error') {
      throw new Error(`Merchant request failed: ${outcome.message}`);
    }
    qr = outcome.element;
  } catch (error) {
    const body = await (await session.$('body'))
      .getText()
      .catch(() => 'unavailable');
    const diagnostics = await session
      .execute(() => ({
        readyState: document.readyState,
        url: window.location.href,
        bodyText:
          document.body?.innerText?.replace(/\s+/g, ' ').slice(-600) ?? '',
        rootText:
          document.querySelector('#root')?.textContent?.replace(/\s+/g, '')
            .length ?? 0,
        htmlLength: document.documentElement?.outerHTML.length ?? 0,
      }))
      .catch(() => null);
    const browserLogs = session.getLogs
      ? await session.getLogs('browser').catch(() => [])
      : [];
    console.error(
      `[merchant-pay-desktop-mobile] merchant proposal failed: ${body.replace(/\s+/g, ' ').slice(-420)}`
    );
    console.error(
      `[merchant-pay-desktop-mobile] merchant page diagnostics: ${JSON.stringify(diagnostics?.value ?? diagnostics)}`
    );
    console.error(
      `[merchant-pay-desktop-mobile] desktop browser logs: ${JSON.stringify(browserLogs.slice(-8))}`
    );
    throw error;
  }
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
    `[merchant-pay-desktop-mobile] merchant QR ready (${payload?.length ?? 0} chars)`
  );
  await waitFor(session, 'div*=Waiting for buyer');
  console.log('[merchant-pay-desktop-mobile] merchant proposal ready');
  return payload;
}

function resolveSdkRoot() {
  const configured = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  if (configured) return configured;
  const adbPath = execFileSync('which', ['adb'], { encoding: 'utf8' }).trim();
  if (adbPath.endsWith('/platform-tools/adb')) {
    return path.dirname(path.dirname(adbPath));
  }
  throw new Error('Set ANDROID_SDK_ROOT or put adb on PATH.');
}

const sdkRoot = resolveSdkRoot();
const adbPath = path.join(
  sdkRoot,
  'platform-tools',
  process.platform === 'win32' ? 'adb.exe' : 'adb'
);
const emulatorPath = path.join(
  sdkRoot,
  'emulator',
  process.platform === 'win32' ? 'emulator.exe' : 'emulator'
);

function runAdb(args, allowFailure = false) {
  try {
    return execFileSync(adbPath, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return '';
    throw error;
  }
}

function findApk() {
  const root = path.join(
    projectRoot,
    'android',
    'app',
    'build',
    'outputs',
    'apk'
  );
  for (const variant of ['play/debug', 'debug']) {
    const directory = path.join(root, variant);
    if (!existsSync(directory)) continue;
    const apk = readdirSync(directory)
      .filter((name) => name.endsWith('.apk'))
      .map((name) => path.join(directory, name))
      .find((candidate) => statSync(candidate).isFile());
    if (apk) return apk;
  }
  throw new Error('No Android debug APK found.');
}

function buildAndroidApk() {
  if (process.env.ANDROID_UI_SKIP_BUILD !== '1') {
    const web = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', 'build:e2e:mobile'],
      { cwd: projectRoot, stdio: 'inherit' }
    );
    if (web.status !== 0) throw new Error('Mobile web build failed.');

    const publicAssets = path.join(
      projectRoot,
      'android',
      'app',
      'src',
      'main',
      'assets',
      'public'
    );
    rmSync(publicAssets, { recursive: true, force: true });
    cpSync(path.join(projectRoot, 'dist'), publicAssets, { recursive: true });

    const gradle = path.join(
      projectRoot,
      'android',
      process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'
    );
    const result = spawnSync(gradle, ['assemblePlayDebug'], {
      cwd: path.join(projectRoot, 'android'),
      stdio: 'inherit',
    });
    if (result.status !== 0) throw new Error('Android debug APK build failed.');
  }
  return findApk();
}

function findEmulatorSerial() {
  return runAdb(['devices'], true)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(
      ([serial, state]) => serial?.startsWith('emulator-') && state === 'device'
    )?.[0];
}

function waitForDevice(serial) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (
      runAdb(['-s', serial, 'get-state'], true).trim() === 'device' &&
      runAdb(
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
        true
      ).trim() === '1'
    ) {
      return;
    }
    waitSync(1000);
  }
  throw new Error(`Timed out waiting for Android emulator ${serial}.`);
}

async function waitForWebViewSocket(serial) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const sockets = runAdb(
      ['-s', serial, 'shell', 'cat', '/proc/net/unix'],
      true
    );
    const match = sockets.match(/@((?:webview|chrome)_devtools_remote[^\s]*)/);
    if (match?.[1]) return match[1];
    await sleep(500);
  }
  throw new Error('Android WebView DevTools socket did not appear.');
}

async function waitForWebViewTarget(port) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(
        (candidate) =>
          candidate.type === 'page' && candidate.webSocketDebuggerUrl
      );
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Forwarding and WebView startup are asynchronous.
    }
    await sleep(500);
  }
  throw new Error('Android WebView page target did not appear.');
}

class CdpClient {
  constructor(socket) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id == null) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(message.error.message ?? 'CDP command failed')
        );
      else request.resolve(message);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener(
          'error',
          () => reject(new Error('Could not connect to Android WebView CDP.')),
          { once: true }
        );
      }),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error('Timed out connecting to Android WebView CDP.')),
          10_000
        )
      ),
    ]).catch((error) => {
      socket.close();
      throw error;
    });
    return new CdpClient(socket);
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for CDP command ${method}.`));
      }, 10_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.text ?? 'WebView evaluation failed'
      );
    }
    return response.result?.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function androidWait(client, expression, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await client.evaluate(expression)) return;
    } catch {
      // The React tree can be replaced while navigating.
    }
    await sleep(250);
  }
  throw new Error(message);
}

async function androidClickText(client, selector, text) {
  await androidWait(
    client,
    `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((candidate) => candidate.textContent?.trim() === ${JSON.stringify(text)} && !candidate.disabled); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`,
    `Could not click ${selector} with text "${text}" on Android`
  );
}

async function androidClickSelector(client, selector) {
  await androidWait(
    client,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`,
    `Could not click ${selector} on Android`
  );
}

async function androidSetInput(client, selector, index, value) {
  await androidWait(
    client,
    `(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!el) return false; el.focus(); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    `Could not set ${selector}[${index}] on Android`
  );
}

async function androidWaitHeading(client, text, timeout = 60_000) {
  await androidWait(
    client,
    `([...document.querySelectorAll('h1')].some((el) => el.textContent?.includes(${JSON.stringify(text)})))`,
    `Expected Android h1 to contain "${text}"`,
    timeout
  );
}

async function androidImportWallet(client) {
  await androidWaitHeading(
    client,
    'Powered with Bitcoin Covenants for Bitcoin Cash'
  );
  await androidClickText(client, 'a', 'Import Wallet');
  await androidWaitHeading(client, 'Import Wallet');
  await androidClickSelector(client, 'button[aria-label*="Current: Mainnet"]');
  await androidWait(
    client,
    `document.querySelectorAll('input[placeholder="word"]').length === 12`,
    'Android import form did not load.'
  );

  for (const [index, word] of mnemonic.split(/\s+/).entries()) {
    await androidSetInput(client, 'input[placeholder="word"]', index, word);
  }
  await androidClickText(client, 'button', 'Import Wallet');
  await androidWaitHeading(client, 'Home', 120_000);
  console.log('[merchant-pay-desktop-mobile] mobile buyer wallet ready');
}

async function routeProposalToMobile(client, payload) {
  await androidClickSelector(client, 'button[aria-label="Scan QR"]');
  await androidWait(
    client,
    `Boolean(document.querySelector('[data-testid="home-scan-input"]'))`,
    'Android QR input did not open.'
  );
  await androidSetInput(client, '[data-testid="home-scan-input"]', 0, payload);
  await androidClickText(client, 'button', 'Connect');
  await androidWaitHeading(client, 'Cauldron', 120_000);
  try {
    await androidWait(
      client,
      `document.body?.innerText?.includes('Pay merchant') === true`,
      'Android did not recognize the merchant proposal.',
      15_000
    );
  } catch (error) {
    const state = await client
      .evaluate(
        `({ url: location.href, historyStateKeys: Object.keys(history.state?.usr ?? {}), proposalLength: history.state?.usr?.merchantProposalQrPayload?.length ?? 0, body: document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 1400) ?? '' })`
      )
      .catch(() => null);
    console.error(
      `[merchant-pay-desktop-mobile] buyer proposal state: ${JSON.stringify(state)}`
    );
    throw error;
  }
  try {
    await androidWait(
      client,
      `(() => [...document.querySelectorAll('button')].some((candidate) => (candidate.textContent?.trim() === 'Prepare payment' || candidate.textContent?.trim().startsWith('Pay ')) && !candidate.disabled))()`,
      'Android merchant payment preparation did not become available.',
      120_000
    );
    const needsPreparation = await client.evaluate(
      `(() => { const el = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Prepare payment' && !candidate.disabled); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`
    );
    if (needsPreparation) {
      await sleep(1000);
      const preparationState = await client
        .evaluate(
          `({ buttons: [...document.querySelectorAll('button')].map((candidate) => ({ text: candidate.textContent?.trim() ?? '', disabled: candidate.disabled })).filter((candidate) => candidate.text === 'Preparing payment…' || candidate.text === 'Prepare payment' || candidate.text.startsWith('Pay ')), body: document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 650) ?? '' })`
        )
        .catch(() => null);
      console.log(
        `[merchant-pay-desktop-mobile] buyer preparation state: ${JSON.stringify(preparationState)}`
      );
      await androidWait(
        client,
        `(() => { const el = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith('Pay ')); return Boolean(el && !el.disabled); })()`,
        'Android merchant payment review did not become available.',
        120_000
      );
    }
  } catch (error) {
    const state = await client
      .evaluate(
        `({ body: document.body?.innerText?.replace(/\\s+/g, ' ').slice(0, 1800) ?? '', paymentButton: [...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith('Pay '))?.outerHTML.slice(0, 300) ?? '' })`
      )
      .catch(() => null);
    console.error(
      `[merchant-pay-desktop-mobile] buyer review state: ${JSON.stringify(state)}`
    );
    throw error;
  }
  const payButtonText = await client.evaluate(
    `([...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim().startsWith('Pay '))?.textContent?.trim() ?? '')`
  );
  await androidClickText(client, 'button', payButtonText);
  await androidWait(
    client,
    `Boolean(document.querySelector('[role="dialog"][aria-label="Review Merchant Payment"]'))`,
    'Android merchant review dialog did not open.'
  );
  const reviewText = await client.evaluate(
    `document.querySelector('[role="dialog"][aria-label="Review Merchant Payment"]')?.innerText ?? ''`
  );
  assert.match(reviewText ?? '', /Merchant receives[\s\S]*(PUSD|BCH)/i);
  assert.match(reviewText ?? '', /You pay[\s\S]*BCH/i);
  assert.match(reviewText ?? '', /Change/i);
  console.log(
    '[merchant-pay-desktop-mobile] mobile buyer reached fixed-output review'
  );
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'optn-merchant-desktop-mobile-e2e-')
);
const profileRoot = path.join(temporaryRoot, 'desktop-profile');
for (const directory of ['data', 'config', 'cache'])
  mkdirSync(path.join(profileRoot, directory), { recursive: true });

let desktopDriver;
let desktopSession;
let desktopViteProcess;
let androidClient;
let androidSerial = process.env.ANDROID_SERIAL;
let emulatorProcess;
let startedEmulator = false;
try {
  await new Promise((resolve, reject) =>
    access(appBinary, (error) => (error ? reject(error) : resolve()))
  );
  if (process.env.OPTN_MERCHANT_E2E_ALLOW_BROADCAST === '1') {
    throw new Error(
      'This desktop + mobile fixture is review-only; broadcast is intentionally disabled.'
    );
  }

  const apk = buildAndroidApk();
  console.log(
    `[merchant-pay-desktop-mobile] using ${path.relative(projectRoot, apk)}`
  );
  if (!existsSync(emulatorPath))
    throw new Error(`Android emulator not found at ${emulatorPath}.`);
  if (!androidSerial) androidSerial = findEmulatorSerial();
  if (!androidSerial) {
    emulatorProcess = spawn(
      emulatorPath,
      [
        '-avd',
        emulatorName,
        '-no-snapshot',
        '-no-boot-anim',
        '-no-audio',
        '-no-window',
        '-gpu',
        process.env.ANDROID_EMULATOR_GPU ?? 'host',
      ],
      { cwd: projectRoot, stdio: 'ignore' }
    );
    startedEmulator = true;
    androidSerial = 'emulator-5554';
  }
  waitForDevice(androidSerial);
  runAdb(['-s', androidSerial, 'install', '-r', '-g', apk]);
  runAdb(['-s', androidSerial, 'shell', 'pm', 'clear', packageName], true);
  runAdb(
    [
      '-s',
      androidSerial,
      'shell',
      'pm',
      'grant',
      packageName,
      'android.permission.POST_NOTIFICATIONS',
    ],
    true
  );
  runAdb(['-s', androidSerial, 'shell', 'am', 'force-stop', packageName], true);
  runAdb([
    '-s',
    androidSerial,
    'shell',
    'am',
    'start',
    '-n',
    `${packageName}/.MainActivity`,
  ]);
  const socket = await waitForWebViewSocket(androidSerial);
  runAdb([
    '-s',
    androidSerial,
    'forward',
    `tcp:${cdpPort}`,
    `localabstract:${socket}`,
  ]);
  const target = await waitForWebViewTarget(cdpPort);
  androidClient = await CdpClient.connect(target.webSocketDebuggerUrl);
  await androidClient.command('Runtime.enable');
  await androidImportWallet(androidClient);

  desktopViteProcess = spawn(
    viteBinary,
    [
      '--config',
      path.join(projectRoot, 'vite.desktop.config.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      '5174',
      '--strictPort',
    ],
    {
      cwd: projectRoot,
      env: sanitizedEnvironment(profileRoot),
      stdio: 'ignore',
    }
  );
  await waitForHttp('http://127.0.0.1:5174/');

  desktopDriver = await startDesktopDriver(profileRoot);
  desktopSession = await remote({
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'warn',
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 2,
    capabilities: { 'tauri:options': { application: appBinary } },
  });
  await importDesktopWallet(desktopSession);
  const payload = await createMerchantProposal(desktopSession);
  await routeProposalToMobile(androidClient, payload);
  console.log(
    '[merchant-pay-desktop-mobile] PASS: desktop merchant + Android buyer reached review; no broadcast performed'
  );
} finally {
  await desktopSession?.deleteSession().catch(() => undefined);
  if (desktopDriver && desktopDriver.exitCode == null)
    desktopDriver.kill('SIGTERM');
  if (desktopViteProcess && desktopViteProcess.exitCode == null)
    desktopViteProcess.kill('SIGTERM');
  androidClient?.close();
  if (androidSerial) runAdb(['forward', '--remove', `tcp:${cdpPort}`], true);
  if (startedEmulator && androidSerial)
    runAdb(['-s', androidSerial, 'emu', 'kill'], true);
  emulatorProcess?.kill('SIGTERM');
  rmSync(temporaryRoot, { recursive: true, force: true });
}
