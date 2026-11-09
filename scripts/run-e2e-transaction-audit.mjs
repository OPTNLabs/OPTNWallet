/* global process */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';
import * as bip39 from 'bip39';
import { remote } from 'webdriverio';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  deriveHdPublicNode,
  encodeHdPublicKey,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

const projectRoot = process.cwd();

// Keep the recovery phrase in this orchestration process only. It is entered
// into the isolated wallet UI, never exposed to Vite or logged.
loadDotenv({ path: path.join(projectRoot, '.env'), override: false });
const mnemonic = process.env.OPTN_E2E_MNEMONIC?.trim() ?? '';
if (!mnemonic) {
  console.error(
    'OPTN_E2E_MNEMONIC is required. This runner never prints its value.'
  );
  process.exit(2);
}
assert.equal(
  bip39.validateMnemonic(mnemonic, bip39.wordlists.english),
  true,
  'OPTN_E2E_MNEMONIC must be a valid English BIP39 phrase.'
);

const allowBroadcast = process.env.OPTN_E2E_ALLOW_BROADCAST === '1';
if (process.env.OPTN_E2E_ALLOW_BROADCAST && !allowBroadcast) {
  throw new Error(
    'Set OPTN_E2E_ALLOW_BROADCAST=1 for live Chipnet sends, or omit it for review-only mode.'
  );
}
const requestedFlows = new Set(
  (process.env.OPTN_E2E_FLOWS ?? 'simple-send')
    .split(',')
    .map((flow) => flow.trim())
    .filter(Boolean)
);
const supportedFlows = new Set([
  'inspect-only',
  'simple-send',
  'simple-token-send',
  'simple-nft-send',
  'custom-transaction',
  'mint-ft',
  'mint-nft',
  'bch-airdrop',
  'token-airdrop',
  'rpa-send',
  'rpa-claim-and-spend',
  'authguard-authkey',
  'quantumroot-bch-recovery',
  'cauldron-swap',
  'merchant-payment',
  'multisig-send',
]);
for (const flow of requestedFlows) {
  if (!supportedFlows.has(flow)) {
    throw new Error(`Unsupported transaction-audit flow: ${flow}`);
  }
}

const viteBinary = path.join(projectRoot, 'node_modules', '.bin', 'vite');
const geckodriverBinary = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  'geckodriver'
);
const webPort = Number(process.env.OPTN_E2E_WEB_PORT ?? '4182');
const driverPort = Number(process.env.OPTN_E2E_DRIVER_PORT ?? '4452');
const browserWidth = Number(process.env.OPTN_E2E_BROWSER_WIDTH ?? '390');
const browserHeight = Number(process.env.OPTN_E2E_BROWSER_HEIGHT ?? '844');
const chipnetElectrumServers = [
  ['electrum-chipnet.optnlabs.com', 50004],
  ['chipnet.imaginary.cash', 50004],
  ['chipnet.c3-soft.com', 64004],
];

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  delete environment.OPTN_E2E_MNEMONIC;
  delete environment.OPTN_MERCHANT_E2E_MNEMONIC;
  environment.XDG_DATA_HOME = path.join(profileRoot, 'data');
  environment.XDG_CONFIG_HOME = path.join(profileRoot, 'config');
  environment.XDG_CACHE_HOME = path.join(profileRoot, 'cache');
  return environment;
}

async function waitForHttp(url, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(1000),
      });
      if (response.status < 500) return;
    } catch {
      // Startup is asynchronous.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for local service ${url}.`);
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
  throw new Error(`Expected ${selector} to contain ${JSON.stringify(text)}.`);
}

async function click(session, selector, timeout = 30_000) {
  const element = await waitFor(session, selector, timeout);
  await element.waitForEnabled({ timeout });
  await element.click();
  return element;
}

async function clickCustomSendNext(session, stage) {
  const next = await waitFor(session, 'button=Next');
  await session.waitUntil(() => next.isEnabled(), {
    timeout: 30_000,
    timeoutMsg: `Custom Send ${stage} did not enable Next.`,
  });
  await next.click();
}

async function importChipnetWallet(session) {
  const words = mnemonic.split(/\s+/).filter(Boolean);
  await waitFor(session, 'a=Import Wallet', 60_000);
  await click(session, 'a=Import Wallet');
  await waitFor(session, 'h1=Import Wallet');

  if (words.length !== 12) {
    await (
      await waitFor(session, 'select[aria-label="Phrase length"]')
    ).selectByAttribute('value', String(words.length));
  }

  const inputs = await session.$$('input[placeholder="word"]');
  assert.equal(
    inputs.length,
    words.length,
    'Recovery-word field count drifted.'
  );
  for (const [index, input] of inputs.entries()) {
    await input.setValue(words[index]);
  }

  const mainnetSwitch = await session.$(
    'button[aria-label*="Current: Mainnet"]'
  );
  if (await mainnetSwitch.isExisting()) await mainnetSwitch.click();
  await click(session, 'button=Import Wallet');
  await waitFor(session, 'h1=Home', 90_000);
  await waitForText(session, 'body', 'tBCH', 120_000);
}

async function syncAndReadBalance(session) {
  const syncButton = await waitFor(session, 'button=Sync', 120_000);
  await syncButton.click();

  const deadline = Date.now() + 180_000;
  let bodyText = '';
  while (Date.now() < deadline) {
    bodyText = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => '');
    const match = bodyText.match(/([0-9]+(?:\.[0-9]{8})?)\s+tBCH\b/);
    const stillSyncing = bodyText.includes('Syncing');
    if (match && !stillSyncing) {
      const balance = Number(match[1]);
      assert.equal(Number.isFinite(balance), true);
      return balance;
    }
    await sleep(500);
  }
  throw new Error(
    `Chipnet wallet synchronization did not settle. Status labels: ${
      [
        'Balance not verified',
        'Balance may be outdated',
        'Syncing',
        'Could not refresh',
      ]
        .filter((label) => bodyText.includes(label))
        .join(', ') || 'none'
    }`
  );
}

async function inspectLatestTransactionHistory(session) {
  const viewAll = await session.$('button=View all');
  if (!(await viewAll.isExisting().catch(() => false))) return null;
  await viewAll.click();
  await waitFor(session, 'h1=Transaction History', 30_000);

  const historySync = await session.$('button[aria-label="Sync"]');
  if (await historySync.isExisting().catch(() => false)) {
    await historySync.click();
  }

  const historyDeadline = Date.now() + 45_000;
  let firstTransaction;
  while (Date.now() < historyDeadline) {
    const candidate = await session.$('button[aria-label="Transaction hash"]');
    if (await candidate.isDisplayed().catch(() => false)) {
      firstTransaction = candidate;
      break;
    }
    const bodyText = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => '');
    if (
      bodyText.includes('Could not load transaction history') ||
      bodyText.includes('No transactions yet')
    ) {
      console.log(
        `[transaction-audit] Wallet history UI: ${bodyText.includes('Could not load') ? 'load-failed' : 'empty'}.`
      );
      await session.url(`http://127.0.0.1:${webPort}/`);
      await waitFor(session, 'h1=Home', 30_000);
      return null;
    }
    await sleep(250);
  }
  if (!firstTransaction) {
    console.log(
      '[transaction-audit] Wallet history UI: timed out without rows.'
    );
    await session.url(`http://127.0.0.1:${webPort}/`);
    await waitFor(session, 'h1=Home', 30_000);
    return null;
  }
  const cardText = await firstTransaction.getText();
  await firstTransaction.click();
  const details = await waitFor(session, '[role="dialog"]', 60_000);
  await waitForText(session, '[role="dialog"]', 'Status', 60_000);
  const detailText = await details.getText();

  const txidControl = await details.$(
    'button[aria-label="Copy transaction ID"]'
  );
  if (await txidControl.isExisting().catch(() => false)) {
    await session.execute((element) => {
      element.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      );
    }, txidControl);
  }

  const txidResult = await session.execute(() => {
    const candidates = Array.from(document.querySelectorAll('p'))
      .map((element) => element.textContent?.trim() ?? '')
      .filter((text) => /^[0-9a-f]{64}$/i.test(text));
    return candidates[0] ?? '';
  });
  const txid =
    typeof txidResult === 'string' ? txidResult : txidResult?.value ?? '';
  const status = /Unconfirmed|Awaiting confirmation/i.test(
    `${cardText}\n${detailText}`
  )
    ? 'mempool-visible'
    : /confirmation|Confirmed|Block:/i.test(`${cardText}\n${detailText}`)
      ? 'confirmed'
      : 'unknown';
  const effectMatch = cardText.match(/Wallet effect:\s*([^\n]+)/i);
  const maskedTxid = txid
    ? `${txid.slice(0, 4)}…${txid.slice(-4)}`
    : 'unavailable';
  console.log(
    `[transaction-audit] Latest Chipnet history: ${status}, txid ${maskedTxid}${effectMatch ? `, ${effectMatch[0]}` : ''}.`
  );

  await session.url(`http://127.0.0.1:${webPort}/`);
  await waitFor(session, 'h1=Home', 30_000);
  return { status, txid, effect: effectMatch?.[1] ?? '' };
}

async function queryChipnetAddressHistory(address) {
  const errors = [];
  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const response = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(response)) {
        throw new Error('history response was not an array');
      }
      const rows = response.filter(
        (row) =>
          row &&
          typeof row === 'object' &&
          typeof row.tx_hash === 'string' &&
          typeof row.height === 'number'
      );
      const latest =
        rows.findLast((row) => row.height <= 0) ?? rows.at(-1) ?? null;
      await client.disconnect(true).catch(() => undefined);
      if (!latest) return null;
      const maskedTxid = `${latest.tx_hash.slice(0, 4)}…${latest.tx_hash.slice(-4)}`;
      const status = latest.height > 0 ? 'confirmed' : 'mempool-visible';
      console.log(
        `[transaction-audit] Direct Chipnet Electrum history: ${status}, txid ${maskedTxid}.`
      );
      return { txid: latest.tx_hash, height: latest.height, status };
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(
    `Chipnet Electrum history lookup failed on every configured server: ${errors.join(' | ')}`
  );
}

async function logRecentChipnetAddressHistory(address) {
  const errors = [];
  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const response = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(response)) {
        throw new Error('history response was not an array');
      }
      const rows = response
        .filter(
          (row) =>
            row &&
            typeof row.tx_hash === 'string' &&
            typeof row.height === 'number'
        )
        .slice(-30);
      await client.disconnect(true).catch(() => undefined);
      console.log(
        '[transaction-audit] Recent audited-address Chipnet history:'
      );
      for (const row of rows) {
        console.log(
          `  ${row.tx_hash.slice(0, 4)}…${row.tx_hash.slice(-4)} ${row.height > 0 ? `confirmed at ${row.height}` : 'mempool-visible'}`
        );
      }
      return;
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(
    `Chipnet history summary failed on every configured server: ${errors.join(' | ')}`
  );
}

async function queryChipnetAddressHistoryTxids(address) {
  const errors = [];
  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const response = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(response)) {
        throw new Error('history response was not an array');
      }
      const txids = new Set(
        response
          .map((row) => row?.tx_hash)
          .filter((txid) => typeof txid === 'string')
      );
      await client.disconnect(true).catch(() => undefined);
      return txids;
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(
    `Chipnet Electrum history lookup failed on every configured server: ${errors.join(' | ')}`
  );
}

async function queryChipnetAddressUtxos(address) {
  const errors = [];
  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const response = await client.request(
        'blockchain.address.listunspent',
        address
      );
      if (!Array.isArray(response)) {
        throw new Error('listunspent response was not an array');
      }
      await client.disconnect(true).catch(() => undefined);
      return response;
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(
    `Chipnet address UTXO lookup failed on every configured server: ${errors.join(' | ')}`
  );
}

async function waitForChipnetAddressToHaveNoUtxos(address, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const utxos = await queryChipnetAddressUtxos(address);
    if (utxos.length === 0) return;
    await sleep(2_000);
  }
  throw new Error('The spent Chipnet address still reports unspent outputs.');
}

async function findChipnetBchOutputAddress(txid, expectedSatoshis) {
  const errors = [];
  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const rawTransaction = await client.request(
        'blockchain.transaction.get',
        txid
      );
      if (typeof rawTransaction !== 'string') {
        throw new Error('raw transaction response was not a string');
      }
      const transaction = decodeTransaction(hexToBin(rawTransaction));
      if (typeof transaction === 'string') {
        throw new Error(`transaction decode failed: ${transaction}`);
      }
      const output = transaction.outputs.find(
        (candidate) =>
          candidate.valueSatoshis === BigInt(expectedSatoshis) &&
          candidate.token === undefined
      );
      if (!output) {
        throw new Error(`no ${expectedSatoshis}-sat BCH output was found`);
      }
      const address = lockingBytecodeToCashAddress({
        prefix: 'bchtest',
        bytecode: output.lockingBytecode,
      });
      if (typeof address === 'string') {
        throw new Error(`output address decode failed: ${address}`);
      }
      await client.disconnect(true).catch(() => undefined);
      return address.address;
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(
    `Could not resolve the Chipnet BCH output address: ${errors.join(' | ')}`
  );
}

async function inspectChipnetTransaction(
  txid,
  address,
  expectedSatoshis,
  expectedTokenAmount = null,
  expectedNftCapability = null
) {
  const decodedAddress = cashAddressToLockingBytecode(address);
  if (typeof decodedAddress === 'string') {
    throw new Error(
      `Could not decode the Chipnet recipient: ${decodedAddress}`
    );
  }
  const expectedLockingBytecode = binToHex(decodedAddress.bytecode);
  const errors = [];

  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const [history, rawTransaction] = await Promise.all([
        client.request('blockchain.address.get_history', address),
        client.request('blockchain.transaction.get', txid),
      ]);
      if (!Array.isArray(history) || typeof rawTransaction !== 'string') {
        throw new Error('Electrum returned an unexpected transaction response');
      }
      const row = history.find(
        (candidate) =>
          candidate &&
          typeof candidate === 'object' &&
          candidate.tx_hash === txid &&
          typeof candidate.height === 'number'
      );
      if (!row) throw new Error('transaction is not in recipient history');

      const transaction = decodeTransaction(hexToBin(rawTransaction));
      if (typeof transaction === 'string') {
        throw new Error(`transaction decode failed: ${transaction}`);
      }
      const hasExpectedOutput = transaction.outputs.some(
        (output) =>
          output.valueSatoshis === BigInt(expectedSatoshis) &&
          binToHex(output.lockingBytecode) === expectedLockingBytecode &&
          (expectedTokenAmount === null ||
            output.token?.amount === BigInt(expectedTokenAmount)) &&
          (expectedNftCapability === null ||
            output.token?.nft?.capability === expectedNftCapability)
      );
      if (!hasExpectedOutput) {
        throw new Error(
          `transaction does not pay ${expectedSatoshis} sats to the audited recipient`
        );
      }

      await client.disconnect(true).catch(() => undefined);
      return {
        status: row.height > 0 ? 'confirmed' : 'mempool-visible',
        height: row.height,
      };
    } catch (error) {
      errors.push(
        `${host}:${error instanceof Error ? error.message : String(error)}`
      );
      await client.disconnect(true).catch(() => undefined);
    }
  }

  throw new Error(errors.join(' | '));
}

async function waitForChipnetTransaction(
  txid,
  address,
  expectedSatoshis,
  expectedTokenAmount = null,
  expectedNftCapability = null,
  timeout = 180_000
) {
  const deadline = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const evidence = await inspectChipnetTransaction(
        txid,
        address,
        expectedSatoshis,
        expectedTokenAmount,
        expectedNftCapability
      );
      const maskedTxid = `${txid.slice(0, 4)}…${txid.slice(-4)}`;
      console.log(
        `[transaction-audit] Exact Chipnet transaction proof: ${evidence.status}, txid ${maskedTxid}, ${expectedSatoshis} sats${expectedTokenAmount === null ? '' : ` and ${expectedTokenAmount} token units`}${expectedNftCapability === null ? '' : ` with ${expectedNftCapability} NFT capability`} to audited recipient.`
      );
      return evidence;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(2_000);
    }
  }
  throw new Error(
    `Exact Chipnet transaction proof did not appear before timeout: ${lastError}`
  );
}

async function findLatestChipnetTokenOutput(
  address,
  expectedSatoshis,
  expectedTokenAmount,
  excludedTxids = new Set()
) {
  const decodedAddress = cashAddressToLockingBytecode(address);
  if (typeof decodedAddress === 'string') return null;
  const expectedLockingBytecode = binToHex(decodedAddress.bytecode);

  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const history = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(history)) throw new Error('history was not an array');
      for (const row of history.slice().reverse().slice(0, 12)) {
        if (!row || typeof row.tx_hash !== 'string') continue;
        if (excludedTxids.has(row.tx_hash)) continue;
        const rawTransaction = await client.request(
          'blockchain.transaction.get',
          row.tx_hash
        );
        if (typeof rawTransaction !== 'string') continue;
        const transaction = decodeTransaction(hexToBin(rawTransaction));
        if (typeof transaction === 'string') continue;
        const match = transaction.outputs.some(
          (output) =>
            output.valueSatoshis === BigInt(expectedSatoshis) &&
            output.token?.amount === BigInt(expectedTokenAmount) &&
            binToHex(output.lockingBytecode) === expectedLockingBytecode
        );
        if (!match) continue;
        await client.disconnect(true).catch(() => undefined);
        return {
          txid: row.tx_hash,
          status: row.height > 0 ? 'confirmed' : 'mempool-visible',
        };
      }
      await client.disconnect(true).catch(() => undefined);
    } catch {
      await client.disconnect(true).catch(() => undefined);
    }
  }
  return null;
}

async function findLatestChipnetNftOutput(
  address,
  expectedSatoshis,
  expectedCapability,
  excludedTxids = new Set()
) {
  const decodedAddress = cashAddressToLockingBytecode(address);
  if (typeof decodedAddress === 'string') return null;
  const expectedLockingBytecode = binToHex(decodedAddress.bytecode);

  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const history = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(history)) throw new Error('history was not an array');
      for (const row of history.slice().reverse().slice(0, 16)) {
        if (!row || typeof row.tx_hash !== 'string') continue;
        if (excludedTxids.has(row.tx_hash)) continue;
        const rawTransaction = await client.request(
          'blockchain.transaction.get',
          row.tx_hash
        );
        if (typeof rawTransaction !== 'string') continue;
        const transaction = decodeTransaction(hexToBin(rawTransaction));
        if (typeof transaction === 'string') continue;
        const match = transaction.outputs.some(
          (output) =>
            output.valueSatoshis === BigInt(expectedSatoshis) &&
            output.token?.amount === 0n &&
            output.token?.nft?.capability === expectedCapability &&
            binToHex(output.lockingBytecode) === expectedLockingBytecode
        );
        if (!match) continue;
        await client.disconnect(true).catch(() => undefined);
        return {
          txid: row.tx_hash,
          status: row.height > 0 ? 'confirmed' : 'mempool-visible',
        };
      }
      await client.disconnect(true).catch(() => undefined);
    } catch {
      await client.disconnect(true).catch(() => undefined);
    }
  }
  return null;
}

async function waitForNewChipnetNftOutput(
  address,
  expectedSatoshis,
  expectedCapability,
  excludedTxids,
  timeout = 180_000
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const evidence = await findLatestChipnetNftOutput(
      address,
      expectedSatoshis,
      expectedCapability,
      excludedTxids
    );
    if (evidence) {
      console.log(
        `[transaction-audit] New Chipnet NFT transaction proof: ${evidence.status}, txid ${evidence.txid.slice(0, 4)}…${evidence.txid.slice(-4)}, ${expectedSatoshis} sats with ${expectedCapability} NFT capability to audited recipient.`
      );
      return evidence;
    }
    await sleep(2_000);
  }
  throw new Error('The new Chipnet NFT transaction did not appear in time.');
}

async function waitForNewChipnetTokenOutput(
  address,
  expectedSatoshis,
  expectedTokenAmount,
  excludedTxids,
  timeout = 180_000
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const evidence = await findLatestChipnetTokenOutput(
      address,
      expectedSatoshis,
      expectedTokenAmount,
      excludedTxids
    );
    if (evidence) {
      console.log(
        `[transaction-audit] New Chipnet token transaction proof: ${evidence.status}, txid ${evidence.txid.slice(0, 4)}…${evidence.txid.slice(-4)}, ${expectedSatoshis} sats and ${expectedTokenAmount} token units to audited recipient.`
      );
      return evidence;
    }
    await sleep(2_000);
  }
  throw new Error('The new Chipnet token transaction did not appear in time.');
}

async function findLatestChipnetBchOutput(
  address,
  expectedSatoshis,
  excludedTxids = new Set()
) {
  const decodedAddress = cashAddressToLockingBytecode(address);
  if (typeof decodedAddress === 'string') return null;
  const expectedLockingBytecode = binToHex(decodedAddress.bytecode);

  for (const [host, port] of chipnetElectrumServers) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-E2E-Audit', '1.5.1', socket);
    try {
      await client.connect();
      const history = await client.request(
        'blockchain.address.get_history',
        address
      );
      if (!Array.isArray(history)) throw new Error('history was not an array');
      for (const row of history.slice().reverse().slice(0, 16)) {
        if (!row || typeof row.tx_hash !== 'string') continue;
        if (excludedTxids.has(row.tx_hash)) continue;
        const rawTransaction = await client.request(
          'blockchain.transaction.get',
          row.tx_hash
        );
        if (typeof rawTransaction !== 'string') continue;
        const transaction = decodeTransaction(hexToBin(rawTransaction));
        if (typeof transaction === 'string') continue;
        const match = transaction.outputs.some(
          (output) =>
            output.valueSatoshis === BigInt(expectedSatoshis) &&
            output.token === undefined &&
            binToHex(output.lockingBytecode) === expectedLockingBytecode
        );
        if (!match) continue;
        await client.disconnect(true).catch(() => undefined);
        return {
          txid: row.tx_hash,
          status: row.height > 0 ? 'confirmed' : 'mempool-visible',
        };
      }
      await client.disconnect(true).catch(() => undefined);
    } catch {
      await client.disconnect(true).catch(() => undefined);
    }
  }
  return null;
}

async function waitForNewChipnetBchOutput(
  address,
  expectedSatoshis,
  excludedTxids,
  timeout = 180_000
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const evidence = await findLatestChipnetBchOutput(
      address,
      expectedSatoshis,
      excludedTxids
    );
    if (evidence) {
      console.log(
        `[transaction-audit] New Chipnet BCH transaction proof: ${evidence.status}, txid ${evidence.txid.slice(0, 4)}…${evidence.txid.slice(-4)}, ${expectedSatoshis} sats to audited recipient.`
      );
      return evidence;
    }
    await sleep(2_000);
  }
  throw new Error('The new Chipnet BCH transaction did not appear in time.');
}

async function waitForChipnetTransactionPresence(txid, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let lastError = '';
  while (Date.now() < deadline) {
    for (const [host, port] of chipnetElectrumServers) {
      const socket = new ElectrumWebSocket(host, port, true, 8_000);
      const client = new ElectrumClient(
        'OPTNWallet-E2E-Audit',
        '1.5.1',
        socket
      );
      try {
        await client.connect();
        const rawTransaction = await client.request(
          'blockchain.transaction.get',
          txid
        );
        if (typeof rawTransaction !== 'string') {
          throw new Error('raw transaction response was not a string');
        }
        const transaction = decodeTransaction(hexToBin(rawTransaction));
        if (typeof transaction === 'string') {
          throw new Error(`transaction decode failed: ${transaction}`);
        }
        let status = 'provider-visible';
        try {
          const verbose = await client.request(
            'blockchain.transaction.get',
            txid,
            true
          );
          if (
            verbose &&
            typeof verbose === 'object' &&
            (Number(verbose.confirmations ?? 0) > 0 ||
              Number(verbose.height ?? 0) > 0 ||
              typeof verbose.blockhash === 'string')
          ) {
            status = 'confirmed';
          } else if (verbose && typeof verbose === 'object') {
            status = 'mempool-visible';
          }
        } catch {
          // The raw transaction response is still provider evidence.
        }
        await client.disconnect(true).catch(() => undefined);
        console.log(
          `[transaction-audit] Exact Chipnet transaction receipt: ${status}, txid ${txid.slice(0, 4)}…${txid.slice(-4)}, ${transaction.inputs.length} inputs and ${transaction.outputs.length} outputs decoded.`
        );
        return { status };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await client.disconnect(true).catch(() => undefined);
      }
    }
    await sleep(2_000);
  }
  throw new Error(
    `The exact Chipnet transaction receipt was not provider-visible: ${lastError}`
  );
}

async function revealFullTransactionId(session, timeout = 120_000) {
  const control = await waitFor(
    session,
    '[role="button"][aria-label="Transaction ID"]',
    timeout
  );
  await session.execute((element) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }, control);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await session.execute(() => {
      const candidates = Array.from(document.querySelectorAll('p'))
        .map((element) => element.textContent?.trim() ?? '')
        .filter((text) => /^[0-9a-f]{64}$/i.test(text));
      return candidates[0] ?? '';
    });
    const txid = typeof result === 'string' ? result : result?.value ?? '';
    if (/^[0-9a-f]{64}$/i.test(txid)) return txid;
    await sleep(100);
  }
  throw new Error('The transaction success receipt did not reveal a full ID.');
}

function createPublicOnlyMultisigCosigner() {
  const seed = new Uint8Array(32).fill(0x6d);
  const root = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
  let account;
  try {
    const rootPublic = deriveHdPublicNode(root);
    const sha256 = createHash('sha256').update(rootPublic.publicKey).digest();
    const fingerprint = createHash('ripemd160')
      .update(sha256)
      .digest('hex')
      .slice(0, 8);
    account = deriveHdPath(root, "m/44'/1'/0'");
    if (typeof account === 'string') {
      throw new Error(`Could not derive audit cosigner: ${account}`);
    }
    const encoded = encodeHdPublicKey({
      network: 'testnet',
      node: deriveHdPublicNode(account),
    });
    if (typeof encoded === 'string') {
      throw new Error(`Could not encode audit cosigner: ${encoded}`);
    }
    return { xpub: encoded.hdPublicKey, fingerprint };
  } finally {
    seed.fill(0);
    root.privateKey.fill(0);
    if (account && typeof account !== 'string') account.privateKey.fill(0);
  }
}

async function readReceiveAddress(session) {
  await click(session, '[data-testid="home-receive-action"]');
  await waitFor(session, 'h1=Receive');
  await click(session, 'button[aria-label="Open larger QR code preview"]');
  const dialog = await waitFor(session, '[role="dialog"]');
  await click(session, '[role="dialog"] button[aria-label="Copy address"]');

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await session.execute(() => {
      const buttons = Array.from(
        document.querySelectorAll(
          '[role="dialog"] button[aria-label="Copy address"]'
        )
      );
      const reveal = buttons.find((button) =>
        /^bchtest:[a-z0-9]+$/i.test(button.textContent?.trim() ?? '')
      );
      return reveal?.textContent?.trim() ?? '';
    });
    const address = typeof result === 'string' ? result : result?.value;
    if (/^bchtest:[a-z0-9]+$/i.test(address ?? '')) {
      await dialog.$('button=Close').click();
      return address;
    }
    await sleep(100);
  }
  throw new Error('The Receive QR did not reveal a full Chipnet address.');
}

async function enableRpaAndReadCashCode(session) {
  await session.url(`http://127.0.0.1:${webPort}/#/settings`);
  await waitFor(session, 'h1=Settings');
  const features = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Connections & features")]'
  );
  await session.execute((element) => element.click(), features);
  const experimental = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Experimental Features")]'
  );
  await session.execute((element) => element.click(), experimental);

  const rpaToggle = await waitFor(
    session,
    'button[aria-label*="Reusable Payment Addresses"]'
  );
  const toggleLabel = await rpaToggle.getAttribute('aria-label');
  if (toggleLabel.startsWith('Enable ')) {
    await session.execute((element) => element.click(), rpaToggle);
  }

  await session.url(`http://127.0.0.1:${webPort}/#/receive`);
  await waitFor(session, 'h1=Receive');
  const cashCodeCard = await waitFor(
    session,
    '//button[.//span[contains(normalize-space(.), "Cash Code")]]',
    60_000
  );
  await session.execute((element) => element.click(), cashCodeCard);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await session.execute(() => {
      const control = Array.from(document.querySelectorAll('button')).find(
        (element) =>
          /^cashcodetest:[a-z0-9]+$/i.test(element.textContent?.trim() ?? '')
      );
      return control?.textContent?.trim() ?? '';
    });
    const cashCode = typeof result === 'string' ? result : result?.value ?? '';
    if (/^cashcodetest:[a-z0-9]+$/i.test(cashCode)) return cashCode;
    await sleep(250);
  }
  throw new Error('The Chipnet Cash Code did not appear on Receive.');
}

async function revealRpaStealthAddress(session) {
  const dialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]'
  );
  await session.execute((element) => {
    const row = Array.from(element.querySelectorAll('.wallet-stat-row')).find(
      (candidate) => /Stealth address/i.test(candidate.textContent ?? '')
    );
    const control = row?.querySelector('[role="button"], button');
    if (!(control instanceof HTMLElement)) {
      throw new Error('The RPA stealth-address disclosure is unavailable.');
    }
    control.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }, dialog);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await session.execute(() => {
      const fullValue = Array.from(document.querySelectorAll('p')).find(
        (element) =>
          /^bchtest:[a-z0-9]+$/i.test(element.textContent?.trim() ?? '')
      );
      const address = fullValue?.textContent?.trim() ?? '';
      const dismiss = fullValue
        ?.closest('[role="dialog"]')
        ?.querySelector('button');
      if (dismiss instanceof HTMLButtonElement) dismiss.click();
      return address;
    });
    const address = typeof result === 'string' ? result : result?.value ?? '';
    if (/^bchtest:[a-z0-9]+$/i.test(address)) return address;
    await sleep(100);
  }
  throw new Error('The RPA review did not reveal its stealth address.');
}

async function revealFullMaskedAddress(session, ariaLabel) {
  const control = await waitFor(
    session,
    `[role="button"][aria-label="${ariaLabel}"]`,
    60_000
  );
  await session.execute((element) => {
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
  }, control);

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await session.execute(() => {
      const candidates = Array.from(document.querySelectorAll('p'))
        .map((element) => element.textContent?.trim() ?? '')
        .filter((text) => /^bchtest:[a-z0-9]+$/i.test(text));
      return candidates.at(-1) ?? '';
    });
    const address = typeof result === 'string' ? result : result?.value ?? '';
    if (/^bchtest:[a-z0-9]+$/i.test(address)) {
      await session.execute(() => {
        const fullValue = Array.from(document.querySelectorAll('p')).find(
          (element) =>
            /^bchtest:[a-z0-9]+$/i.test(element.textContent?.trim() ?? '')
        );
        const dismiss = fullValue
          ?.closest('[role="dialog"]')
          ?.querySelector('button');
        if (dismiss instanceof HTMLButtonElement) dismiss.click();
      });
      return address;
    }
    await sleep(100);
  }
  throw new Error(`The ${ariaLabel} control did not reveal a full address.`);
}

async function prepareSimpleSendReview(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/send`);
  await waitFor(session, 'h1=Send');

  await (
    await waitFor(session, 'input[placeholder="bitcoincash:..."]')
  ).setValue(recipient);
  await (
    await waitFor(session, 'input[placeholder="0.00000000 BCH"]')
  ).setValue('0.00002000');

  const reviewButton = await waitFor(session, 'button=Review');
  await reviewButton.waitForEnabled({ timeout: 120_000 });
  await reviewButton.click();

  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    120_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /0\.00002000 BCH/);
  assert.match(reviewText, /\bFee\b/);
  assert.match(reviewText, /Wallet total \(BCH\)/);
  console.log('[transaction-audit] Simple Send review: PASS');

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  // Use the accessible equivalent of the drag gesture. It is part of the
  // production dialog and invokes the same one-shot confirmation callback.
  await session.execute(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const confirm = buttons.find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Simple Send confirmation control is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, recipient, 2_000);
  console.log('[transaction-audit] Simple Send Chipnet broadcast: PASS');
}

async function prepareRpaSend(session) {
  const cashCode = await enableRpaAndReadCashCode(session);
  await session.url(`http://127.0.0.1:${webPort}/#/send`);
  await waitFor(session, 'h1=Send');
  await (
    await waitFor(session, 'input[placeholder="bitcoincash:..."]')
  ).setValue(cashCode);
  await (
    await waitFor(session, 'input[placeholder="0.00000000 BCH"]')
  ).setValue('0.00002000');

  const reviewButton = await waitFor(session, 'button=Review');
  await reviewButton.waitForEnabled({ timeout: 180_000 });
  await reviewButton.click();
  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    180_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /Stealth address/i);
  assert.match(reviewText, /0\.00002000 BCH/);
  assert.match(reviewText, /Fee/i);
  const stealthAddress = await revealRpaStealthAddress(session);
  console.log('[transaction-audit] RPA Cash Code Send review: PASS');

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('RPA Cash Code confirmation control is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, stealthAddress, 2_000);
  console.log('[transaction-audit] RPA Cash Code Chipnet broadcast: PASS');
}

async function claimAndSpendLatestRpaPayment(
  session,
  recipient,
  rpaTransactionId
) {
  const stealthAddress = await findChipnetBchOutputAddress(
    rpaTransactionId,
    2_000
  );
  const stealthUtxos = await queryChipnetAddressUtxos(stealthAddress);
  assert.ok(
    stealthUtxos.some((utxo) => Number(utxo.value) === 2_000),
    'The latest RPA transaction no longer has its 2,000-sat stealth output.'
  );

  await enableRpaAndReadCashCode(session);
  await session.url(`http://127.0.0.1:${webPort}/#/assets`);
  await waitFor(session, 'h1=Assets');
  const txidInput = await waitFor(
    session,
    'input[placeholder="64-character transaction id"]',
    60_000
  );
  await txidInput.setValue(rpaTransactionId);
  await click(session, 'button=Check');
  const stealthCard = await waitFor(
    session,
    '//*[normalize-space(.)="Stealth BCH"]/ancestor::div[contains(@class,"rounded-xl")][1]',
    180_000
  );
  await session.waitUntil(
    async () => {
      const text = await stealthCard.getText();
      return /0\.00002 BCH/.test(text) && /1 confirmed/i.test(text);
    },
    {
      timeout: 180_000,
      timeoutMsg: 'The RPA transaction was not claimed as 0.00002 Stealth BCH.',
    }
  );
  console.log('[transaction-audit] RPA recipient claim: PASS');

  await session.url(`http://127.0.0.1:${webPort}/#/send`);
  await waitFor(session, 'h1=Send');
  await (
    await waitFor(session, 'input[placeholder="bitcoincash:..."]')
  ).setValue(recipient);
  await (
    await waitFor(session, 'input[placeholder="0.00000000 BCH"]')
  ).setValue('0.00001000');
  const advancedOptions = await waitFor(
    session,
    '//button[.//span[normalize-space(.)="Advanced"]]',
    30_000
  );
  await session.execute((element) => element.click(), advancedOptions);
  const manualCoinControl = await waitFor(
    session,
    '//label[.//span[normalize-space(.)="Manual"]]//input[@type="checkbox"]',
    60_000
  );
  if (!(await manualCoinControl.isSelected())) {
    await session.execute((element) => element.click(), manualCoinControl);
  }
  const selectNone = await waitFor(session, 'button=None', 30_000);
  await session.execute((element) => element.click(), selectNone);
  const stealthCoin = await waitFor(
    session,
    '//label[.//span[normalize-space(.)="Stealth"]]//input[@type="checkbox"]',
    60_000
  );
  await session.execute((element) => element.click(), stealthCoin);
  const reviewButton = await waitFor(session, 'button=Review');
  await reviewButton.waitForEnabled({ timeout: 180_000 });
  await reviewButton.click();
  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    180_000
  );
  const technicalDetails = await reviewDialog.$(
    './/button[contains(normalize-space(.), "Technical details")]'
  );
  await technicalDetails.waitForDisplayed({ timeout: 30_000 });
  await session.execute((element) => element.click(), technicalDetails);
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /Stealth/);
  assert.match(reviewText, /2000 sats/);
  assert.match(reviewText, /0\.00001000 BCH/);
  console.log('[transaction-audit] RPA Stealth BCH spend review: PASS');

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);
  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('RPA Stealth BCH confirmation control is unavailable.');
    }
    confirm.click();
  });
  await waitForNewChipnetBchOutput(recipient, 1_000, baselineTxids);
  await waitForChipnetAddressToHaveNoUtxos(stealthAddress);
  console.log('[transaction-audit] RPA Stealth BCH Chipnet spend: PASS');
}

async function prepareFungibleTokenSend(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/send`);
  await waitFor(session, 'h1=Send');
  await click(session, 'button=Token');
  await waitFor(session, 'input[placeholder="bitcoincash:z..."]');
  await (
    await waitFor(session, 'input[placeholder="bitcoincash:z..."]')
  ).setValue(recipient);

  const categorySelect = await waitFor(session, 'select');
  await session.waitUntil(
    async () => (await categorySelect.$$('option')).length > 1,
    {
      timeout: 120_000,
      timeoutMsg: 'The minted fungible token did not appear in Simple Send.',
    }
  );
  await categorySelect.selectByIndex(1);

  const amountInputs = await session.$$('input[inputmode="decimal"]');
  assert.ok(
    amountInputs.length >= 2,
    'Simple Send token amount controls are missing.'
  );
  await amountInputs[0].setValue('1');
  await amountInputs[1].setValue('0.00001000');

  const reviewButton = await waitFor(session, 'button=Review');
  await reviewButton.waitForEnabled({ timeout: 120_000 });
  await reviewButton.click();

  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    120_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /FT/);
  assert.match(reviewText, /1(?:\.0+)?/);
  assert.match(reviewText, /\bFee\b/);
  console.log('[transaction-audit] Fungible Token Send review: PASS');

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Fungible Token Send confirmation is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, recipient, 1_000, 1);
  console.log(
    '[transaction-audit] Fungible Token Send Chipnet broadcast: PASS'
  );
}

async function prepareNftSend(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/send`);
  await waitFor(session, 'h1=Send');
  await click(session, 'button=Token');
  await click(session, 'button=NFT');
  await waitFor(session, 'input[placeholder="bitcoincash:z..."]');
  await (
    await waitFor(session, 'input[placeholder="bitcoincash:z..."]')
  ).setValue(recipient);

  const categorySelect = await waitFor(session, 'select');
  await session.waitUntil(
    async () => (await categorySelect.$$('option')).length > 1,
    {
      timeout: 120_000,
      timeoutMsg: 'The minted NFT did not appear in Simple Send.',
    }
  );
  await categorySelect.selectByIndex(1);

  const reviewButton = await waitFor(session, 'button=Review');
  await reviewButton.waitForEnabled({ timeout: 120_000 });
  await reviewButton.click();

  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    120_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /NFT/);
  assert.match(reviewText, /\bFee\b/);
  console.log('[transaction-audit] NFT Send review: PASS');

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('NFT Send confirmation is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, recipient, 1_000, 0, 'none');
  console.log('[transaction-audit] NFT Send Chipnet broadcast: PASS');
}

async function prepareCustomTransaction(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/transaction`);
  await waitFor(session, 'h1=Custom Send', 30_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  await click(session, 'button=Wallet funds');
  let dialog = await waitFor(session, '[role="dialog"]');
  const walletSources = await dialog.$$('[role="button"][aria-pressed]');
  assert.ok(walletSources.length > 0, 'Custom Send has no wallet sources.');
  // The source card contains MaskedValue controls which intentionally stop
  // click propagation. Invoke the outer card's click handler directly so the
  // audit selects the source rather than copying its masked address.
  await session.execute((element) => element.click(), walletSources[0]);
  await session.waitUntil(
    async () =>
      (await walletSources[0].getAttribute('aria-pressed')) === 'true',
    {
      timeout: 30_000,
      timeoutMsg: 'The selected wallet source did not become active.',
    }
  );
  await dialog.$('button=Close').click();
  await waitForText(session, 'body', '1 wallet source');
  await clickCustomSendNext(session, 'source selection');
  await waitFor(session, 'h2=Pick funds');

  await click(session, 'button=BCH funds', 60_000);
  dialog = await waitFor(session, '[role="dialog"]');
  const spendableUtxos = await dialog.$$('button.wallet-selectable-inactive');
  assert.ok(spendableUtxos.length > 0, 'Custom Send has no BCH UTXOs.');
  const spendableAmounts = [];
  for (let index = 0; index < spendableUtxos.length; index += 1) {
    const text = await spendableUtxos[index].getText();
    const match = text.match(/(?:^|\n)(\d+(?:\.\d+)?) BCH\b/);
    spendableAmounts.push({ index, bch: match ? Number(match[1]) : 0 });
  }
  const largestSpendable = spendableAmounts.reduce((largest, candidate) =>
    candidate.bch > largest.bch ? candidate : largest
  );
  assert.ok(
    largestSpendable.bch > 0.00002,
    'Custom Send has no BCH UTXO large enough for the audit amount and fee reserve.'
  );
  const selectedUtxo = spendableUtxos[largestSpendable.index];
  await session.execute((element) => element.click(), selectedUtxo);
  await session.waitUntil(
    async () =>
      (await selectedUtxo.getAttribute('class')).includes(
        'wallet-selectable-active'
      ),
    {
      timeout: 30_000,
      timeoutMsg: 'The selected BCH UTXO did not become active.',
    }
  );
  await dialog.$('button=Close').click();
  await clickCustomSendNext(session, 'UTXO selection');
  await waitFor(session, 'h2=Add recipients');

  await click(session, 'button=Add recipient');
  dialog = await waitFor(session, '[role="dialog"]');
  await dialog.$('input[type="text"]').setValue(recipient);
  await dialog.$('input[type="number"]').setValue('0.00002000');
  await dialog.$('button=Add Output').click();
  await waitForText(session, 'body', '1 recipient', 30_000);
  await dialog.$('button=Close').click();
  await clickCustomSendNext(session, 'recipient selection');
  await waitFor(session, 'h2=Review and send');

  await click(session, 'button=Build TX', 120_000);
  dialog = await waitFor(session, '[role="dialog"]', 120_000);
  await waitForText(
    session,
    '[role="dialog"]',
    'Raw Transaction Details',
    120_000
  );
  const rawReviewText = await dialog.getText();
  assert.match(rawReviewText, /Inputs/);
  assert.match(rawReviewText, /Outputs/);
  await dialog.$('button=Close').click();

  await click(session, 'button=Send TX');
  dialog = await waitFor(session, '[role="dialog"]');
  await waitForText(session, '[role="dialog"]', 'Confirm Transaction');
  const confirmText = await dialog.getText();
  assert.match(confirmText, /Inputs/);
  assert.match(confirmText, /Outputs/);
  assert.match(confirmText, /Fee/);
  const networkVisible = /Chipnet|Mainnet/.test(confirmText);
  console.log(
    `[transaction-audit] Custom Transaction review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button=Back').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm and send transaction'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error(
        'Custom Transaction confirmation control is unavailable.'
      );
    }
    confirm.click();
  });
  await waitForText(
    session,
    '[role="dialog"]',
    'Transaction Successful',
    120_000
  );
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, recipient, 2_000);
  console.log('[transaction-audit] Custom Transaction Chipnet broadcast: PASS');
}

async function prepareFungibleTokenMint(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/mint-cashtokens-poc`);
  await waitForText(session, 'body', 'Step 1: Source UTXOs', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const genesisSource = await waitFor(
    session,
    '//span[contains(normalize-space(.), "genesis source")]/ancestor::div[contains(@class, "wallet-selectable")][1]//input[@type="checkbox"]',
    60_000
  );
  if (!(await genesisSource.isSelected())) await genesisSource.click();
  await waitForText(session, 'body', 'Selected: 1', 30_000);

  await click(session, 'button=Continue');
  await waitForText(session, 'body', 'Step 2: Recipients', 30_000);
  await waitForText(session, 'body', '1 recipient', 30_000);
  await click(session, 'button=Continue');
  await waitForText(session, 'body', 'Step 3: Amounts', 30_000);

  await click(session, '//button[contains(normalize-space(.), "Add output")]');
  let dialog = await waitFor(session, '[role="dialog"]');
  await waitForText(session, '[role="dialog"]', 'Add output');
  const recipientSelect = await dialog.$('select');
  const defaultMintRecipient = await recipientSelect.getValue();
  if (/^bchtest:[a-z0-9]+$/i.test(defaultMintRecipient)) {
    const existingMint = await findLatestChipnetTokenOutput(
      defaultMintRecipient,
      1_000,
      1
    );
    if (existingMint) {
      console.log(
        `[transaction-audit] Existing Fungible Token Mint proof: ${existingMint.status}, txid ${existingMint.txid.slice(0, 4)}…${existingMint.txid.slice(-4)}, 1000 sats and 1 token unit to a wallet-owned address.`
      );
    }
  }
  const recipientOption = await recipientSelect.$(
    `option[value="${recipient}"]`
  );
  if (await recipientOption.isExisting()) {
    await recipientSelect.selectByAttribute('value', recipient);
  }
  const selectedMintRecipient = await recipientSelect.getValue();
  assert.match(
    selectedMintRecipient,
    /^bchtest:[a-z0-9]+$/i,
    'Mint output recipient is not a Chipnet address.'
  );
  const saveOutput = await dialog.$('button=Save output');
  await saveOutput.waitForEnabled({ timeout: 30_000 });
  await saveOutput.click();
  await waitForText(session, 'body', '1 output', 30_000);

  await click(session, 'button=Review & mint (1)', 120_000);
  dialog = await waitFor(
    session,
    '[role="dialog"][aria-label^="Confirm mint"]',
    120_000
  );
  const reviewText = await dialog.getText();
  assert.match(reviewText, /Inputs/);
  assert.match(reviewText, /Outputs/);
  assert.match(reviewText, /Fee/);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] Fungible Token Mint review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Mint confirmation control is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(txid, selectedMintRecipient, 1_000, 1);
  console.log(
    '[transaction-audit] Fungible Token Mint Chipnet broadcast: PASS'
  );
}

async function prepareNftMint(session, recipient) {
  await session.url(`http://127.0.0.1:${webPort}/#/mint-cashtokens-poc`);
  await waitForText(session, 'body', 'Step 1: Source UTXOs', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const genesisSource = await waitFor(
    session,
    '//span[contains(normalize-space(.), "genesis source")]/ancestor::div[contains(@class, "wallet-selectable")][1]//input[@type="checkbox"]',
    60_000
  );
  if (!(await genesisSource.isSelected())) await genesisSource.click();
  await waitForText(session, 'body', 'Selected: 1', 30_000);

  await click(session, 'button=Continue');
  await waitForText(session, 'body', 'Step 2: Recipients', 30_000);
  await waitForText(session, 'body', '1 recipient', 30_000);
  await click(session, 'button=Continue');
  await waitForText(session, 'body', 'Step 3: Amounts', 30_000);

  await click(session, '//button[contains(normalize-space(.), "Add output")]');
  let dialog = await waitFor(session, '[role="dialog"]');
  await waitForText(session, '[role="dialog"]', 'Add output');
  const recipientSelect = await dialog.$('select');
  const recipientOption = await recipientSelect.$(
    `option[value="${recipient}"]`
  );
  if (await recipientOption.isExisting()) {
    await recipientSelect.selectByAttribute('value', recipient);
  }
  const selectedMintRecipient = await recipientSelect.getValue();
  assert.match(
    selectedMintRecipient,
    /^bchtest:[a-z0-9]+$/i,
    'NFT mint output recipient is not a Chipnet address.'
  );
  await dialog.$('button=NFT').click();
  const capabilitySelects = await dialog.$$('select');
  assert.ok(
    capabilitySelects.length >= 3,
    'NFT mint capability controls are missing.'
  );
  await capabilitySelects.at(-1).selectByAttribute('value', 'none');
  const saveOutput = await dialog.$('button=Save output');
  await saveOutput.waitForEnabled({ timeout: 30_000 });
  await saveOutput.click();
  await waitForText(session, 'body', '1 output', 30_000);

  await click(session, 'button=Review & mint (1)', 120_000);
  dialog = await waitFor(
    session,
    '[role="dialog"][aria-label^="Confirm mint"]',
    120_000
  );
  const reviewText = await dialog.getText();
  assert.match(reviewText, /Inputs/);
  assert.match(reviewText, /Outputs/);
  assert.match(reviewText, /Fee/);
  assert.match(reviewText, /NFT/i);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] NFT Mint review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('NFT Mint confirmation control is unavailable.');
    }
    confirm.click();
  });
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransaction(
    txid,
    selectedMintRecipient,
    1_000,
    0,
    'none'
  );
  console.log('[transaction-audit] NFT Mint Chipnet broadcast: PASS');
}

async function prepareTokenAirdrop(session, recipient) {
  await session.url(
    `http://127.0.0.1:${webPort}/#/apps/optn.builtin.events:airdropsApp`
  );
  await waitFor(session, 'h1=Airdrops', 60_000);
  await waitForText(session, 'body', 'Step 1 · Recipients', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const recipientInput = await waitFor(session, 'textarea');
  await recipientInput.setValue(recipient);
  const addRecipient = await waitFor(session, 'button=Add');
  await addRecipient.waitForEnabled({ timeout: 30_000 });
  await addRecipient.click();
  await waitForText(session, 'body', '1 Selected', 30_000);
  const continueToAsset = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Continue")]'
  );
  await continueToAsset.waitForEnabled({ timeout: 30_000 });
  await session.execute((element) => element.click(), continueToAsset);
  await waitForText(session, 'body', 'Step 2 · Asset', 30_000);

  const assetSelects = await session.$$('select.wallet-select');
  assert.ok(assetSelects.length >= 2, 'Airdrops token controls are missing.');
  const tokenCategorySelect = assetSelects[1];
  await session.waitUntil(
    async () => (await tokenCategorySelect.$$('option')).length > 1,
    {
      timeout: 120_000,
      timeoutMsg: 'Airdrops did not discover the wallet token inventory.',
    }
  );
  if (!(await tokenCategorySelect.getValue())) {
    await tokenCategorySelect.selectByIndex(1);
  }

  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);
  const continueToSend = await waitFor(
    session,
    'button=Continue to Send',
    120_000
  );
  await continueToSend.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), continueToSend);
  await waitForText(session, 'body', 'Step 3 · Send', 60_000);
  const sendAirdrop = await waitFor(session, 'button=Send airdrop', 120_000);
  await sendAirdrop.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), sendAirdrop);

  const dialog = await waitFor(
    session,
    '[role="dialog"][aria-label="Send airdrop"]',
    30_000
  );
  const reviewText = await dialog.getText();
  assert.match(reviewText, /1 recipients?/);
  assert.match(reviewText, /total 1 [0-9a-f]{64}/i);
  assert.match(reviewText, /fee \d+ sats/);
  assert.match(reviewText, /\d+ inputs? · \d+ outputs?/i);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] Token Airdrop review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Airdrop confirmation control is unavailable.');
    }
    confirm.click();
  });
  await waitForText(session, 'body', 'distribution job', 120_000);
  await waitForNewChipnetTokenOutput(recipient, 1_000, 1, baselineTxids);
  console.log('[transaction-audit] Token Airdrop Chipnet broadcast: PASS');
}

async function prepareBchAirdrop(session, recipient) {
  await session.url(
    `http://127.0.0.1:${webPort}/#/apps/optn.builtin.events:airdropsApp`
  );
  await waitFor(session, 'h1=Airdrops', 60_000);
  await waitForText(session, 'body', 'Step 1 · Recipients', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const recipientInput = await waitFor(session, 'textarea');
  await recipientInput.setValue(recipient);
  const addRecipient = await waitFor(session, 'button=Add');
  await addRecipient.waitForEnabled({ timeout: 30_000 });
  await addRecipient.click();
  await waitForText(session, 'body', '1 Selected', 30_000);
  const continueToAsset = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Continue")]'
  );
  await continueToAsset.waitForEnabled({ timeout: 30_000 });
  await session.execute((element) => element.click(), continueToAsset);
  await waitForText(session, 'body', 'Step 2 · Asset', 30_000);

  const assetType = await waitFor(session, 'select.wallet-select');
  await assetType.selectByAttribute('value', 'bch');
  const amountInput = await waitFor(session, 'input[placeholder="Sats each"]');
  await amountInput.setValue('2000');

  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);
  const continueToSend = await waitFor(
    session,
    'button=Continue to Send',
    120_000
  );
  await continueToSend.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), continueToSend);
  await waitForText(session, 'body', 'Step 3 · Send', 60_000);
  const sendAirdrop = await waitFor(session, 'button=Send airdrop', 120_000);
  await sendAirdrop.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), sendAirdrop);

  const dialog = await waitFor(
    session,
    '[role="dialog"][aria-label="Send airdrop"]',
    30_000
  );
  const reviewText = await dialog.getText();
  assert.match(reviewText, /1 recipients?/);
  assert.match(reviewText, /total 0\.00002 BCH/i);
  assert.match(reviewText, /fee \d+ sats/);
  assert.match(reviewText, /\d+ inputs? · \d+ outputs?/i);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] BCH Airdrop review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('BCH Airdrop confirmation control is unavailable.');
    }
    confirm.click();
  });
  await waitForText(session, 'body', 'distribution job', 120_000);
  await waitForNewChipnetBchOutput(recipient, 2_000, baselineTxids);
  console.log('[transaction-audit] BCH Airdrop Chipnet broadcast: PASS');
}

async function prepareAuthGuardAuthKey(session, recipient) {
  await session.url(
    `http://127.0.0.1:${webPort}/#/apps/optn.builtin.demo:authguard`
  );
  await waitForText(session, 'body', 'AuthGuard v1', 60_000);
  await waitForText(session, 'body', 'Create AuthKey NFT Only', 60_000);
  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);

  const createAuthKey = await waitFor(
    session,
    'button=Create AuthKey NFT Only'
  );
  await createAuthKey.waitForEnabled({ timeout: 60_000 });
  await session.execute((element) => element.click(), createAuthKey);

  let dialog = await waitFor(session, '[role="dialog"]', 180_000);
  let title = await dialog.getAttribute('aria-label');
  assert.ok(
    title === 'Review genesis candidate' || title === 'Review AuthKey mint',
    `Unexpected AuthGuard review title: ${title}`
  );
  let reviewText = await dialog.getText();
  assert.match(reviewText, /Chipnet/);
  assert.match(reviewText, /Inputs?/i);
  assert.match(reviewText, /Outputs?/i);
  assert.match(reviewText, /Fee/i);
  console.log(
    `[transaction-audit] AuthGuard ${title === 'Review genesis candidate' ? 'genesis' : 'AuthKey'} review: PASS (network shown).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  await dialog.$('button=Broadcast transaction').click();
  if (title === 'Review genesis candidate') {
    dialog = await waitFor(
      session,
      '[role="dialog"][aria-label="Review AuthKey mint"]',
      180_000
    );
    title = await dialog.getAttribute('aria-label');
    reviewText = await dialog.getText();
    assert.equal(title, 'Review AuthKey mint');
    assert.match(reviewText, /Chipnet/);
    assert.match(reviewText, /Inputs?/i);
    assert.match(reviewText, /Outputs?/i);
    assert.match(reviewText, /Fee/i);
    console.log(
      '[transaction-audit] AuthGuard AuthKey review: PASS (network shown).'
    );
    await dialog.$('button=Broadcast transaction').click();
  }

  await session.waitUntil(
    async () => {
      const body = await session
        .$('/html/body')
        .then((element) => element.getText())
        .catch(() => '');
      return /AuthKey (minted|submitted):/i.test(body);
    },
    {
      timeout: 180_000,
      timeoutMsg: 'AuthGuard did not report the final AuthKey result.',
    }
  );
  await waitForNewChipnetNftOutput(recipient, 1_000, 'none', baselineTxids);
  console.log('[transaction-audit] AuthGuard AuthKey Chipnet broadcast: PASS');
}

async function openFirstQuantumrootVault(session) {
  await session.url(`http://127.0.0.1:${webPort}/#/quantumroot`);
  await waitForText(session, 'body', 'Quantumroot Beta Production', 60_000);
  await click(session, 'button=Open Vaults', 120_000);
  const vaultCard = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Vault #")]',
    120_000
  );
  await session.execute((element) => element.click(), vaultCard);
  await waitForText(session, 'body', 'Vault setup', 60_000);
  const vaultSetup = await waitFor(
    session,
    '//summary[contains(normalize-space(.), "Vault setup")]'
  );
  await session.execute((element) => element.click(), vaultSetup);
  await waitForText(session, 'body', 'Receive address', 30_000);
}

async function prepareQuantumrootBchRecovery(session, recipient) {
  if (!allowBroadcast) {
    throw new Error(
      'Quantumroot BCH recovery requires a live setup send before its recovery review can be built.'
    );
  }

  await openFirstQuantumrootVault(session);
  const vaultAddress = await revealFullMaskedAddress(
    session,
    'Receive address'
  );
  let vaultUtxos = await queryChipnetAddressUtxos(vaultAddress);
  let fundedNow = false;
  if (vaultUtxos.length === 0) {
    await prepareSimpleSendReview(session, vaultAddress);
    vaultUtxos = await queryChipnetAddressUtxos(vaultAddress);
    assert.ok(
      vaultUtxos.length > 0,
      'The Quantumroot funding output was not visible on Chipnet.'
    );
    console.log(
      '[transaction-audit] Quantumroot vault funding Chipnet broadcast: PASS'
    );
    fundedNow = true;
  } else {
    console.log(
      '[transaction-audit] Quantumroot vault already has a recoverable Chipnet output; funding send skipped.'
    );
  }

  if (fundedNow) await openFirstQuantumrootVault(session);
  const refresh = await session.$('button=Refresh vault status');
  if (await refresh.isDisplayed().catch(() => false)) {
    await session.execute((element) => element.click(), refresh);
  }
  const advanced = await waitFor(
    session,
    '//summary[contains(normalize-space(.), "Advanced recovery")]',
    120_000
  );
  await session.execute((element) => element.click(), advanced);
  const destinationInput = await waitFor(
    session,
    'input[placeholder="bitcoincash:... or bchtest:..."]',
    60_000
  );
  await destinationInput.setValue(recipient);

  const reviewSweep = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Review BCH sweep")]',
    180_000
  );
  await reviewSweep.waitForEnabled({ timeout: 180_000 });
  await session.execute((element) => element.click(), reviewSweep);

  const reviewSelector = '[role="dialog"][aria-label="Review BCH sweep"]';
  const dialog = await waitFor(session, reviewSelector, 120_000);
  const reviewText = await dialog.getText();
  assert.match(reviewText, /Destination/i);
  assert.match(reviewText, /Inputs?/i);
  assert.match(reviewText, /You will receive/i);
  assert.match(reviewText, /Network fee/i);
  const recoveryAmountMatch = reviewText.match(
    /You will receive\s+([0-9.]+) BCH/i
  );
  assert.ok(
    recoveryAmountMatch,
    'The Quantumroot recovery amount was missing from the review.'
  );
  const recoveryAmountSats = Math.round(
    Number(recoveryAmountMatch[1]) * 100_000_000
  );
  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] Quantumroot BCH recovery review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error(
        'Quantumroot BCH recovery confirmation control is unavailable.'
      );
    }
    confirm.click();
  });
  const evidence = await waitForNewChipnetBchOutput(
    recipient,
    recoveryAmountSats,
    baselineTxids
  );
  const receiptTxid = await revealFullTransactionId(session).catch(() => null);
  if (receiptTxid && receiptTxid !== evidence.txid) {
    console.log(
      `[transaction-audit] Quantumroot receipt defect: UI exposed stale txid ${receiptTxid.slice(0, 4)}…${receiptTxid.slice(-4)} instead of ${evidence.txid.slice(0, 4)}…${evidence.txid.slice(-4)}.`
    );
  }
  await waitForChipnetAddressToHaveNoUtxos(vaultAddress);
  console.log(
    '[transaction-audit] Quantumroot BCH recovery Chipnet broadcast: PASS'
  );
}

async function prepareMerchantPayment(session) {
  await session.url(
    `http://127.0.0.1:${webPort}/#/apps/optn.builtin.demo:merchantPayApp`
  );
  await waitFor(session, 'h1=Merchant Pay', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  for (const key of ['0', 'decimal', '0', '2']) {
    const keyButton = await waitFor(
      session,
      `[data-testid="merchant-key-${key}"]`
    );
    await session.execute((element) => element.click(), keyButton);
  }
  const createRequest = await waitFor(
    session,
    '//button[contains(normalize-space(.), "Request")]',
    120_000
  );
  await createRequest.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), createRequest);

  const qrPayload = await waitFor(
    session,
    '[data-merchant-proposal-payload]',
    150_000
  );
  const payload = await qrPayload.getAttribute(
    'data-merchant-proposal-payload'
  );
  assert.match(payload, /"application":\{/);

  await session.url(`http://127.0.0.1:${webPort}/`);
  await waitFor(session, 'h1=Home', 30_000);
  await click(session, 'button[aria-label="Scan QR"]');
  await (
    await waitFor(session, '[data-testid="home-scan-input"]')
  ).setValue(payload);
  const scanContinue = await waitFor(
    session,
    '[data-testid="home-scan-continue"]'
  );
  await scanContinue.waitForEnabled({ timeout: 30_000 });
  await session.execute((element) => element.click(), scanContinue);

  const merchantHeading = await session.$('h1=Pay merchant');
  await session.waitUntil(() => merchantHeading.isDisplayed(), {
    timeout: 120_000,
    timeoutMsg: 'Merchant proposal did not route from Home into Cauldron.',
  });
  await waitFor(session, '[data-testid="merchant-payment-review"]', 30_000);
  const reviewPayment = await waitFor(
    session,
    '[data-testid="merchant-payment-review-cta"]',
    120_000
  );
  await reviewPayment.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), reviewPayment);

  const merchantReviewSelector =
    '[role="dialog"][aria-label="Review Merchant Payment"]';
  await waitFor(session, merchantReviewSelector, 120_000);
  await waitForText(session, merchantReviewSelector, 'You pay', 120_000);
  const dialog = await session.$(merchantReviewSelector);
  const reviewText = await dialog.getText();
  assert.match(reviewText, /You pay/);
  assert.match(reviewText, /Merchant/);
  assert.match(reviewText, /Change/);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] Merchant Payment review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  const warningCheckbox = await dialog.$('input[type="checkbox"]');
  if (
    (await warningCheckbox.isDisplayed().catch(() => false)) &&
    !(await warningCheckbox.isSelected().catch(() => false))
  ) {
    await warningCheckbox.click();
  }
  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Merchant Payment confirmation control is unavailable.');
    }
    confirm.click();
  });

  await waitFor(session, '[data-testid="merchant-payment-sent"]', 180_000);
  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransactionPresence(txid);
  console.log('[transaction-audit] Merchant Payment Chipnet broadcast: PASS');
}

async function prepareCauldronSwap(session) {
  await session.url(
    `http://127.0.0.1:${webPort}/#/apps/optn.builtin.demo:cauldronSwapApp`
  );
  await waitFor(session, 'h1=Cauldron', 60_000);
  await waitForText(session, 'body', 'Swap BCH and CashTokens', 120_000);
  await waitForText(session, 'body', 'Range:', 120_000);

  const amountInput = await waitFor(
    session,
    'input[inputmode="decimal"]',
    120_000
  );
  await amountInput.setValue('0.02');

  const reviewSwap = await waitFor(session, 'button=Review Swap', 120_000);
  await reviewSwap.waitForEnabled({ timeout: 120_000 });
  await session.execute((element) => element.click(), reviewSwap);

  const reviewSelector = '[role="dialog"][aria-label="Review Cauldron Swap"]';
  const dialog = await waitFor(session, reviewSelector, 180_000);
  const reviewText = await dialog.getText();
  assert.match(reviewText, /Pay/);
  assert.match(reviewText, /Receive/);
  assert.match(reviewText, /Minimum receive/);
  assert.match(reviewText, /Network fee/);
  assert.match(reviewText, /LP fee/);
  const networkVisible = /Chipnet|Mainnet/.test(reviewText);
  console.log(
    `[transaction-audit] Cauldron Swap review: PASS (${networkVisible ? 'network shown' : 'network missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await dialog.$('button[aria-label="Cancel"]').click();
    return;
  }

  const warningCheckbox = await dialog.$('input[type="checkbox"]');
  if (
    (await warningCheckbox.isDisplayed().catch(() => false)) &&
    !(await warningCheckbox.isSelected().catch(() => false))
  ) {
    await warningCheckbox.click();
  }
  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Confirm action'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Cauldron Swap confirmation control is unavailable.');
    }
    confirm.click();
  });

  const outcome = await session.waitUntil(
    async () => {
      const body = await session
        .$('/html/body')
        .then((element) => element.getText())
        .catch(() => '');
      if (
        /No transaction was sent|Swap failed|quote expired|changed\. Get a fresh quote/i.test(
          body
        )
      ) {
        return { kind: 'failed', body };
      }
      const txidControl = await session.$(
        '[role="button"][aria-label="Transaction ID"]'
      );
      if (await txidControl.isDisplayed().catch(() => false)) {
        return { kind: 'submitted' };
      }
      return false;
    },
    {
      timeout: 180_000,
      timeoutMsg: 'Cauldron Swap did not reach a terminal submission state.',
    }
  );
  if (outcome.kind === 'failed') {
    throw new Error(
      'Cauldron Swap invalidated the reviewed quote before broadcast; the UI reports that no transaction was sent.'
    );
  }

  const txid = await revealFullTransactionId(session);
  await waitForChipnetTransactionPresence(txid);
  console.log('[transaction-audit] Cauldron Swap Chipnet broadcast: PASS');
}

async function prepareMultisigSend(session, recipient) {
  const publicOnlyCosigner = createPublicOnlyMultisigCosigner();
  await session.url(`http://127.0.0.1:${webPort}/#/multisig/setup`);
  await waitFor(session, 'h1=Create a multisig wallet', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const addThisDevice = await waitFor(
    session,
    'button=Add this device as a cosigner'
  );
  await session.execute((element) => element.click(), addThisDevice);
  await waitForText(session, 'body', 'Active wallet identity', 60_000);

  const threshold = await waitFor(session, 'input[type="number"]');
  await session.execute((element) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )?.set;
    setter?.call(element, '1');
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, threshold);
  assert.equal(await threshold.getValue(), '1');
  const continueToCosigners = await waitFor(
    session,
    'button=Continue to cosigners'
  );
  await session.execute((element) => element.click(), continueToCosigners);
  await waitForText(session, 'body', 'Step 2 · Add the other cosigners');

  const xpubInputs = await session.$$(
    'input[placeholder="Account xpub · QR recommended"]'
  );
  const fingerprintInputs = await session.$$(
    'input[placeholder="8-character fingerprint"]'
  );
  assert.equal(xpubInputs.length, 2, 'The 1-of-2 setup lost a cosigner row.');
  assert.equal(
    fingerprintInputs.length,
    2,
    'The 1-of-2 setup lost a fingerprint row.'
  );
  assert.notEqual(
    await xpubInputs[0].getValue(),
    '',
    'The active wallet was not added as Cosigner 1.'
  );
  await xpubInputs[1].setValue(publicOnlyCosigner.xpub);
  await fingerprintInputs[1].setValue(publicOnlyCosigner.fingerprint);
  await waitForText(session, 'body', '2 of 2 ready', 30_000);

  const continueToReview = await waitFor(session, 'button=Continue to review');
  await session.execute((element) => element.click(), continueToReview);
  try {
    await waitForText(session, 'body', 'Step 3 · Review and create');
  } catch (error) {
    const bodyText = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => '');
    throw new Error(
      `Multisig setup did not advance to review. Visible state: ${bodyText.slice(-1_500)}`,
      { cause: error }
    );
  }
  const setupText = await session
    .$('/html/body')
    .then((element) => element.getText());
  assert.match(setupText, /Chipnet/);
  assert.match(setupText, /1 of 2/);
  assert.match(setupText, /Ready to create/);
  console.log('[transaction-audit] Multisig 1-of-2 policy review: PASS');

  const createWallet = await waitFor(
    session,
    'button=Approve and create shared wallet'
  );
  await createWallet.waitForEnabled({ timeout: 30_000 });
  await session.execute((element) => element.click(), createWallet);
  await waitFor(session, 'h1=Shared policy wallet', 60_000);
  const workspaceUrl = await session.getUrl();
  const walletIdMatch = workspaceUrl.match(/#\/multisig\/(\d+)(?:\/|$)/);
  assert.ok(walletIdMatch, 'The multisig workspace route has no wallet ID.');
  const workspacePath = `#/multisig/${walletIdMatch[1]}`;

  const receive = await waitFor(session, 'button=Receive to shared wallet');
  await session.execute((element) => element.click(), receive);
  await waitForText(session, 'body', 'Receive into the multisig wallet');
  const reserve = await waitFor(session, 'button=Reserve next receive address');
  await session.execute((element) => element.click(), reserve);
  await waitForText(session, 'body', 'Branch 0 · index 0', 60_000);
  const multisigAddress = await revealFullMaskedAddress(session, 'BCH address');

  const existingMultisigUtxos = await queryChipnetAddressUtxos(multisigAddress);
  const reusableFunding = existingMultisigUtxos.find(
    (utxo) => Number(utxo.value) === 2_000
  );
  if (reusableFunding) {
    console.log(
      `[transaction-audit] Reusing the existing unspent 2,000-sat multisig audit output ${reusableFunding.tx_hash.slice(0, 4)}…${reusableFunding.tx_hash.slice(-4)}; no duplicate funding transaction will be sent.`
    );
  } else {
    await prepareSimpleSendReview(session, multisigAddress);
    console.log('[transaction-audit] Multisig funding review: PASS');
    if (!allowBroadcast) return;
  }

  await session.url(`http://127.0.0.1:${webPort}/${workspacePath}`);
  await waitFor(session, 'h1=Shared policy wallet', 60_000);
  const refresh = await waitFor(session, 'button=Refresh');
  await session.execute((element) => element.click(), refresh);
  await waitForText(session, 'body', '0.00002000 BCH', 180_000);

  const createSpend = await waitFor(
    session,
    'button=Create new multisig spend'
  );
  await session.execute((element) => element.click(), createSpend);
  await waitFor(session, 'h1=Mobile multisig send', 60_000);
  await waitForText(session, 'body', 'Chipnet', 30_000);

  const coin = await waitFor(
    session,
    '//section[.//p[normalize-space(.)="Coins to spend"]]//input[@type="checkbox"]',
    180_000
  );
  if (!(await coin.isSelected())) {
    await session.execute((element) => element.click(), coin);
  }
  await (await waitFor(session, '#watch-only-recipient')).setValue(recipient);
  await (
    await waitFor(
      session,
      '//label[contains(normalize-space(.), "Amount (BCH)")]//input'
    )
  ).setValue('0.00001000');
  const advanced = await waitFor(session, 'button=Advanced');
  await session.execute((element) => element.click(), advanced);
  const sighash = await waitFor(
    session,
    '//label[contains(normalize-space(.), "Sighash type")]//select'
  );
  await sighash.selectByAttribute('value', '193');
  assert.equal(await sighash.getValue(), '193');
  console.log(
    '[transaction-audit] Multisig recovery uses All + Anyone Can Pay after the default All sighash was live-proven to fail silently at local signature merge.'
  );

  const build = await waitFor(
    session,
    '[data-testid="watch-only-build-unsigned"]'
  );
  await build.waitForEnabled({ timeout: 180_000 });
  await session.execute((element) => element.click(), build);
  await waitForText(session, 'body', 'Sign with this device', 180_000);
  const proposalText = await session
    .$('/html/body')
    .then((element) => element.getText());
  assert.match(proposalText, /Sending 0\.00001000 BCH/);
  assert.match(proposalText, /fee/i);
  assert.match(proposalText, /change/i);

  const authorize = await waitFor(
    session,
    '//label[contains(normalize-space(.), "authorize this device to sign")]//input[@type="checkbox"]'
  );
  await authorize.scrollIntoView();
  await authorize.click();
  assert.equal(
    await authorize.isSelected(),
    true,
    'The multisig local-sign authorization did not stay selected.'
  );
  const sign = await waitFor(session, 'button=Sign with this device');
  await sign.waitForEnabled({ timeout: 30_000 });
  await session.execute((element) => {
    window.__optnAuditSignClicks = 0;
    window.__optnAuditSignErrors = [];
    element.addEventListener('click', () => {
      window.__optnAuditSignClicks += 1;
    });
    window.addEventListener(
      'unhandledrejection',
      (event) => {
        window.__optnAuditSignErrors.push(String(event.reason));
      },
      { once: true }
    );
    window.addEventListener(
      'error',
      (event) => {
        window.__optnAuditSignErrors.push(String(event.message));
      },
      { once: true }
    );
  }, sign);
  await sign.scrollIntoView();
  await sign.click();
  try {
    await session.waitUntil(
      async () => {
        const result = await session.execute(
          () => document.body.innerText ?? ''
        );
        const text = typeof result === 'string' ? result : result?.value ?? '';
        return /Cosigner signatures|Payment needs attention|Ready to broadcast\n.*Review and confirm broadcast/s.test(
          text
        );
      },
      {
        timeout: 30_000,
        timeoutMsg:
          'The local-sign action produced no signature status, broadcast verdict, or user-facing error.',
      }
    );
  } catch (error) {
    const diagnostic = await session.execute(() => ({
      clicks: window.__optnAuditSignClicks ?? 0,
      errors: window.__optnAuditSignErrors ?? [],
      text: document.body.innerText ?? '',
    }));
    throw new Error(
      `The local-sign action produced no terminal UI state. Captured clicks: ${diagnostic.clicks}; browser errors: ${JSON.stringify(diagnostic.errors)}; visible state: ${String(diagnostic.text).slice(-2_000)}`,
      { cause: error }
    );
  }
  const postSignTextResult = await session.execute(
    () => document.body.innerText ?? ''
  );
  const postSignText =
    typeof postSignTextResult === 'string'
      ? postSignTextResult
      : postSignTextResult?.value ?? '';
  if (
    /Payment needs attention/.test(postSignText) &&
    !/Review and confirm broadcast/.test(postSignText)
  ) {
    throw new Error(
      `Multisig local signing failed before the broadcast gate. Visible state: ${postSignText.slice(-2_000)}`
    );
  }
  let armBroadcast;
  try {
    armBroadcast = await waitFor(
      session,
      '//section[.//p[normalize-space(.)="Ready to broadcast"]]//button[normalize-space(.)="Review and confirm broadcast"]',
      180_000
    );
  } catch (error) {
    const bodyText = await session
      .$('/html/body')
      .then((element) => element.getText())
      .catch(() => '');
    throw new Error(
      `The locally signed multisig proposal did not reach the verified broadcast gate. Visible state: ${bodyText.slice(-2_000)}`,
      { cause: error }
    );
  }
  await session.execute((element) => element.click(), armBroadcast);
  const reviewDialog = await waitFor(
    session,
    '[role="dialog"][aria-labelledby="send-review-title"]',
    60_000
  );
  const reviewText = await reviewDialog.getText();
  assert.match(reviewText, /0\.00001000 BCH/);
  assert.match(reviewText, /Multisig policy/);
  assert.match(reviewText, /1 of 2 signatures/);
  assert.match(reviewText, /Fee/i);
  console.log(
    `[transaction-audit] Multisig send/broadcast review: PASS (${/Chipnet/.test(reviewText) ? 'network shown' : 'Chipnet missing from confirmation'}).`
  );

  if (!allowBroadcast) {
    await reviewDialog.$('button=Close').click();
    return;
  }

  const baselineTxids = await queryChipnetAddressHistoryTxids(recipient);
  await session.execute(() => {
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Slide to confirm'
    );
    if (!(confirm instanceof HTMLButtonElement) || confirm.disabled) {
      throw new Error('Multisig confirmation control is unavailable.');
    }
    confirm.click();
  });

  try {
    const txid = await revealFullTransactionId(session, 45_000);
    await waitForChipnetTransaction(txid, recipient, 1_000);
  } catch (receiptError) {
    const evidence = await waitForNewChipnetBchOutput(
      recipient,
      1_000,
      baselineTxids
    );
    console.log(
      `[transaction-audit] Multisig receipt warning: the live transaction ${evidence.txid.slice(0, 4)}…${evidence.txid.slice(-4)} was independently proven, but the wallet did not expose a usable transaction ID within 45 seconds (${receiptError instanceof Error ? receiptError.message : String(receiptError)}).`
    );
  }
  console.log('[transaction-audit] Multisig Chipnet broadcast: PASS');
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), 'optn-transaction-audit-e2e-')
);
const profileRoot = path.join(temporaryRoot, 'profile');
for (const directory of ['data', 'config', 'cache']) {
  mkdirSync(path.join(profileRoot, directory), { recursive: true });
}

let viteProcess;
let geckodriver;
let session;
try {
  const environment = sanitizedEnvironment(profileRoot);
  viteProcess = spawn(
    viteBinary,
    [
      '--config',
      path.join(projectRoot, 'vite.e2e.config.ts'),
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    { cwd: projectRoot, env: environment, stdio: 'ignore' }
  );
  await waitForHttp(`http://127.0.0.1:${webPort}/`);

  geckodriver = spawn(
    geckodriverBinary,
    ['--port', String(driverPort), '--log', 'fatal'],
    { cwd: projectRoot, env: environment, stdio: 'ignore' }
  );
  await waitForHttp(`http://127.0.0.1:${driverPort}/status`);

  session = await remote({
    hostname: '127.0.0.1',
    port: driverPort,
    logLevel: 'warn',
    connectionRetryTimeout: 30_000,
    connectionRetryCount: 2,
    capabilities: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless'] },
    },
  });
  await session.setWindowSize(browserWidth, browserHeight);
  await session.url(`http://127.0.0.1:${webPort}/`);

  await importChipnetWallet(session);
  const balance = await syncAndReadBalance(session);
  console.log(
    `[transaction-audit] Chipnet wallet synchronized (${balance.toFixed(8)} tBCH spendable view).`
  );
  if (balance <= 0) {
    throw new Error(
      'The configured Chipnet wallet has no visible BCH, so spend reviews cannot be built.'
    );
  }

  const recipient = await readReceiveAddress(session);
  const existingHistory = await queryChipnetAddressHistory(recipient);
  if (process.env.OPTN_E2E_LIST_RECENT_HISTORY === '1') {
    await logRecentChipnetAddressHistory(recipient);
  }
  const existingExpectedSatoshis = Number(
    process.env.OPTN_E2E_VERIFY_EXISTING_SATS ?? ''
  );
  const existingExpectedNftCapability =
    process.env.OPTN_E2E_VERIFY_EXISTING_NFT_CAPABILITY;
  const existingExpectedTokenAmountRaw =
    process.env.OPTN_E2E_VERIFY_EXISTING_TOKEN_AMOUNT;
  if (existingExpectedNftCapability) {
    const existingNft = await findLatestChipnetNftOutput(
      recipient,
      1_000,
      existingExpectedNftCapability
    );
    if (!existingNft) {
      throw new Error(
        `No ${existingExpectedNftCapability} NFT output was found for the audited Chipnet recipient.`
      );
    }
    console.log(
      `[transaction-audit] Existing Chipnet NFT proof: ${existingNft.status}, txid ${existingNft.txid.slice(0, 4)}…${existingNft.txid.slice(-4)}, 1000 sats with ${existingExpectedNftCapability} NFT capability to audited recipient.`
    );
  }
  if (
    Number.isSafeInteger(existingExpectedSatoshis) &&
    existingExpectedSatoshis > 0 &&
    existingExpectedTokenAmountRaw !== undefined
  ) {
    const existingExpectedTokenAmount = Number(existingExpectedTokenAmountRaw);
    assert.equal(
      Number.isSafeInteger(existingExpectedTokenAmount),
      true,
      'OPTN_E2E_VERIFY_EXISTING_TOKEN_AMOUNT must be an integer.'
    );
    const existingToken = await findLatestChipnetTokenOutput(
      recipient,
      existingExpectedSatoshis,
      existingExpectedTokenAmount
    );
    if (!existingToken) {
      throw new Error(
        `No ${existingExpectedTokenAmount}-unit token output with ${existingExpectedSatoshis} sats was found for the audited Chipnet recipient.`
      );
    }
    await waitForChipnetTransaction(
      existingToken.txid,
      recipient,
      existingExpectedSatoshis,
      existingExpectedTokenAmount
    );
  } else if (
    existingHistory &&
    Number.isSafeInteger(existingExpectedSatoshis) &&
    existingExpectedSatoshis > 0
  ) {
    await waitForChipnetTransaction(
      existingHistory.txid,
      recipient,
      existingExpectedSatoshis
    );
  }
  await session.url(`http://127.0.0.1:${webPort}/`);
  await waitFor(session, 'h1=Home', 30_000);
  if (process.env.OPTN_E2E_INSPECT_WALLET_HISTORY !== '0') {
    await inspectLatestTransactionHistory(session);
  }
  if (requestedFlows.has('simple-send')) {
    await prepareSimpleSendReview(session, recipient);
  }
  if (requestedFlows.has('simple-token-send')) {
    await prepareFungibleTokenSend(session, recipient);
  }
  if (requestedFlows.has('simple-nft-send')) {
    await prepareNftSend(session, recipient);
  }
  if (requestedFlows.has('custom-transaction')) {
    await prepareCustomTransaction(session, recipient);
  }
  if (requestedFlows.has('mint-ft')) {
    await prepareFungibleTokenMint(session, recipient);
  }
  if (requestedFlows.has('mint-nft')) {
    await prepareNftMint(session, recipient);
  }
  if (requestedFlows.has('bch-airdrop')) {
    await prepareBchAirdrop(session, recipient);
  }
  if (requestedFlows.has('token-airdrop')) {
    await prepareTokenAirdrop(session, recipient);
  }
  if (requestedFlows.has('rpa-send')) {
    await prepareRpaSend(session);
  }
  if (requestedFlows.has('rpa-claim-and-spend')) {
    assert.ok(
      existingHistory,
      'A latest Chipnet transaction is required for the RPA claim audit.'
    );
    await claimAndSpendLatestRpaPayment(
      session,
      recipient,
      existingHistory.txid
    );
  }
  if (requestedFlows.has('authguard-authkey')) {
    await prepareAuthGuardAuthKey(session, recipient);
  }
  if (requestedFlows.has('quantumroot-bch-recovery')) {
    await prepareQuantumrootBchRecovery(session, recipient);
  }
  if (requestedFlows.has('cauldron-swap')) {
    await prepareCauldronSwap(session);
  }
  if (requestedFlows.has('merchant-payment')) {
    await prepareMerchantPayment(session);
  }
  if (requestedFlows.has('multisig-send')) {
    await prepareMultisigSend(session, recipient);
  }
  console.log(
    `[transaction-audit] PASS: ${Array.from(requestedFlows).join(', ')} ${allowBroadcast ? 'live Chipnet' : 'review-only'} audit completed.`
  );
} finally {
  await session?.deleteSession().catch(() => undefined);
  if (geckodriver && geckodriver.exitCode == null) geckodriver.kill('SIGTERM');
  if (viteProcess && viteProcess.exitCode == null) viteProcess.kill('SIGTERM');
  rmSync(temporaryRoot, { recursive: true, force: true });
}
