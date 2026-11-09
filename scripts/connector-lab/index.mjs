#!/usr/bin/env node

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  cashAddressToLockingBytecode,
  deriveHdPath,
  deriveHdPrivateNodeFromSeed,
  encodeCashAddress,
  encodeTransaction,
  decodeTransaction,
  hexToBin,
  hash160,
  secp256k1,
} from '@bitauth/libauth';
import * as bip39 from 'bip39';
import { SignClient } from '@walletconnect/sign-client';
import { initiateDappRelay } from '@wizardconnect/core';
import { Dapp } from '@cashconnect-js/nostr/dapp';
import { MemoryStore } from '@cashconnect-js/nostr';
import { ElectrumClient } from '@electrum-cash/network';
import { ElectrumWebSocket } from '@electrum-cash/web-socket';
import {
  allocateDisjointBchBatches,
  assertTokenPreservation,
  assertBroadcastPolicy,
  buildTokenPreservationPlan,
} from './safety.mjs';

const NETWORK = 'chipnet';
const CHAIN_ID = 'bch:bchtest';
const RELAY_URL = 'wss://relay.cauldron.quest';
const DEFAULT_PORT = 8787;
const SOURCE_TXID = '11'.repeat(32);
const DAPP_NAME = 'OPTN Connector Lab';
const CHIPNET_ELECTRUM_SERVERS = [
  ['electrum-chipnet.optnlabs.com', 50004],
  ['chipnet.imaginary.cash', 50004],
  ['chipnet.c3-soft.com', 64004],
];

function envValue(name) {
  const candidates = ['.env', '.env.local'];
  for (const file of candidates) {
    try {
      const line = readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .find((entry) => entry.startsWith(`${name}=`));
      if (line) return line.slice(name.length + 1).trim().replace(/^['"]|['"]$/g, '');
    } catch {
      // The shell environment remains the source of truth if no local file exists.
    }
  }
  return process.env[name]?.trim() || '';
}

function requiredEnv(name) {
  const value = envValue(name);
  if (!value) throw new Error(`${name} is required for this connector lab`);
  return value;
}

function lockingBytecode(address) {
  const result = cashAddressToLockingBytecode(address);
  if (typeof result === 'string') throw new Error(result);
  return result.bytecode;
}

async function deriveChipnetReceiveAddress() {
  const mnemonic = requiredEnv('OPTN_E2E_MNEMONIC');
  const seed = Uint8Array.from(await bip39.mnemonicToSeed(mnemonic, ''));
  const root = deriveHdPrivateNodeFromSeed(seed, { assumeValidity: true });
  let child;
  try {
    child = deriveHdPath(root, "m/44'/1'/0'/0/0");
    if (typeof child === 'string') throw new Error(`Chipnet derivation failed: ${child}`);
    const publicKey = secp256k1.derivePublicKeyCompressed(child.privateKey);
    if (typeof publicKey === 'string') throw new Error(`Chipnet public key derivation failed: ${publicKey}`);
    const payload = hash160(publicKey);
    const address = cashAddressToLockingBytecode(
      `bchtest:${encodeCashAddress({ payload, prefix: 'bchtest', type: 'p2pkh' }).address.split(':')[1]}`
    );
    if (typeof address === 'string') throw new Error(address);
    return {
      address: `bchtest:${encodeCashAddress({ payload, prefix: 'bchtest', type: 'p2pkh' }).address.split(':')[1]}`,
      lockingBytecode: address.bytecode,
      lockingScript: `<OP_DUP OP_HASH160 <0x${Buffer.from(payload).toString('hex')}> OP_EQUALVERIFY OP_CHECKSIG>`,
    };
  } finally {
    if (child && typeof child !== 'string') child.privateKey.fill(0);
    root.privateKey.fill(0);
    seed.fill(0);
  }
}

function hex(value) {
  return Buffer.from(value).toString('hex');
}

function electrumScriptHash(lockingBytecode) {
  const digest = createHash('sha256').update(Buffer.from(lockingBytecode)).digest();
  return Buffer.from(digest).reverse().toString('hex');
}

async function queryChipnetUtxos(destination) {
  const scriptHash = electrumScriptHash(destination.lockingBytecode);
  const errors = [];
  for (const [host, port] of CHIPNET_ELECTRUM_SERVERS) {
    const socket = new ElectrumWebSocket(host, port, true, 8_000);
    const client = new ElectrumClient('OPTNWallet-Connector-Lab', '1.5.1', socket);
    try {
      await client.connect();
      const rows = await client.request('blockchain.scripthash.listunspent', scriptHash);
      if (!Array.isArray(rows)) throw new Error('Electrum returned a non-array UTXO response');
      const enriched = await Promise.all(rows.map(async (row) => {
        const raw = await client.request('blockchain.transaction.get', row.tx_hash);
        if (typeof raw !== 'string') throw new Error(`missing raw transaction for ${row.tx_hash.slice(0, 8)}`);
        const transaction = decodeTransaction(hexToBin(raw));
        if (typeof transaction === 'string') throw new Error(`transaction decode failed for ${row.tx_hash.slice(0, 8)}: ${transaction}`);
        const output = transaction.outputs[row.tx_pos];
        if (!output) throw new Error(`outpoint ${row.tx_hash.slice(0, 8)}:${row.tx_pos} is missing from its transaction`);
        return {
          txid: row.tx_hash,
          outpointIndex: row.tx_pos,
          valueSatoshis: String(row.value),
          height: row.height,
          token: output.token
            ? {
                category: Buffer.from(output.token.category).toString('hex'),
                amount: output.token.amount.toString(),
                nftCapability: output.token.nft?.capability ?? null,
                nftCommitment: output.token.nft?.commitment
                  ? Buffer.from(output.token.nft.commitment).toString('hex')
                  : null,
              }
            : null,
        };
      }));
      await client.disconnect(true).catch(() => undefined);
      return enriched
    } catch (error) {
      errors.push(`${host}:${error instanceof Error ? error.message : String(error)}`);
      await client.disconnect(true).catch(() => undefined);
    }
  }
  throw new Error(`Chipnet UTXO preflight failed on every Electrum server: ${errors.join(' | ')}`);
}

function buildSampleRequest(destination, sourceUtxo = null) {
  const sourceLock = destination.lockingBytecode;
  const sourceTxid = sourceUtxo?.txid ?? SOURCE_TXID;
  const sourceValue = BigInt(sourceUtxo?.valueSatoshis ?? '1000000');
  const outputValue = sourceValue - 250n;
  if (outputValue <= 0n) throw new Error('Selected review UTXO cannot cover the lab fee.');
  const transaction = {
    version: 2,
    locktime: 0,
    inputs: [
      {
        outpointTransactionHash: sourceTxid,
        outpointIndex: 0,
        sequenceNumber: 0xffffffff,
        unlockingBytecode: '',
      },
    ],
    outputs: [
      {
        lockingBytecode: hex(sourceLock),
        valueSatoshis: outputValue.toString(),
      },
    ],
  };

  return {
    transaction,
    sourceOutputs: [
      {
        lockingBytecode: hex(sourceLock),
        valueSatoshis: sourceValue.toString(),
      },
    ],
    broadcast: false,
    userPrompt: `OPTN Connector Lab: return ${Number(outputValue) / 100000000} BCH to ${destination.address}`,
  };
}

async function getLiveBchReviewUtxo(destination) {
  const utxos = await queryChipnetUtxos(destination);
  const candidate = utxos.find(
    (utxo) => !utxo.token && BigInt(utxo.valueSatoshis) >= 1000000n
  );
  if (!candidate) {
    throw new Error('No BCH-only Chipnet UTXO is available for a live connector review.');
  }
  return candidate;
}

function encodedTransaction(request) {
  const normalized = {
    ...request.transaction,
    inputs: request.transaction.inputs.map((input) => ({
      ...input,
      outpointTransactionHash: Buffer.from(input.outpointTransactionHash, 'hex'),
      unlockingBytecode: Buffer.from(input.unlockingBytecode, 'hex'),
    })),
    outputs: request.transaction.outputs.map((output) => ({
      ...output,
      lockingBytecode: Buffer.from(output.lockingBytecode, 'hex'),
      valueSatoshis: BigInt(output.valueSatoshis),
    })),
  };
  return Buffer.from(encodeTransaction(normalized)).toString('hex');
}

function summarizeBchRequest(request, connector) {
  const inputValue = request.sourceOutputs.reduce(
    (total, output) => total + BigInt(output.valueSatoshis),
    0n
  );
  const outputValue = request.transaction.outputs.reduce(
    (total, output) => total + BigInt(output.valueSatoshis),
    0n
  );
  return {
    connector,
    network: NETWORK,
    operation: request.broadcast ? 'Sign and broadcast' : 'Sign and return',
    inputCount: request.transaction.inputs.length,
    outputCount: request.transaction.outputs.length,
    inputSatoshis: inputValue.toString(),
    outputSatoshis: outputValue.toString(),
    feeSatoshis: (inputValue - outputValue).toString(),
    userPrompt: request.userPrompt,
  };
}

function startStatusServer(port) {
  const state = {
    network: NETWORK,
    phase: 'idle',
    activeConnector: null,
    sessions: {},
    lastRequest: null,
    lastReviewSummary: null,
    lastResponse: null,
    preflight: null,
    broadcastEnabled: process.env.OPTN_CONNECTOR_LAB_ALLOW_BROADCAST === '1',
    livePreflight: false,
  };
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, ...state }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OPTN Connector Lab</title>
<style>body{font:16px system-ui;max-width:760px;margin:2rem auto;padding:0 1rem;background:#0b1713;color:#e9fff5}pre{white-space:pre-wrap;background:#132820;padding:1rem;border-radius:12px}code{color:#8ff0bd}</style>
<h1>OPTN Connector Lab</h1>
<p>Network: <strong>${NETWORK}</strong></p>
<p>Use the terminal controls to pair and request a review. The normalized review summary is shown beside the protocol request.</p>
<pre id="state">Loading…</pre>
<script>setInterval(async()=>{document.querySelector('#state').textContent=JSON.stringify(await fetch('/health').then(r=>r.json()),null,2)},1000)</script>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        server.close();
        void startStatusServer(port + 1).then(resolve, reject);
        return;
      }
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, state, port }));
  });
}

function printRequest(label, uri, request) {
  console.log(`\n[${label}]`);
  if (uri) console.log(`Pairing URI:\n${uri}`);
  console.log('Review request:');
  console.log(JSON.stringify(request, null, 2));
  console.log('Expected operation: sign and return; broadcast=false');
}

function beginRequest(state, connector, request) {
  assertBroadcastPolicy({
    network: NETWORK,
    request,
    broadcastEnabled: state.broadcastEnabled,
    livePreflight: state.livePreflight,
  });
  state.activeConnector = connector;
  state.phase = 'review-requested';
  state.lastRequest = { connector, request };
  state.lastReviewSummary = summarizeBchRequest(request, connector);
}

async function runWalletConnect(state, destination) {
  state.activeConnector = 'walletconnect';
  state.phase = 'connecting';
  const sourceUtxo = await getLiveBchReviewUtxo(destination);
  const projectId = requiredEnv('VITE_WC_PROJECT_ID');
  const client = await SignClient.init({
    projectId,
    relayUrl: 'wss://relay.walletconnect.com',
    metadata: {
      name: DAPP_NAME,
      description: 'Disposable OPTN Wallet connector review harness',
      url: 'http://127.0.0.1:8787',
      icons: [],
    },
  });
  const { uri, approval } = await client.connect({
    optionalNamespaces: {
      bch: {
        chains: [CHAIN_ID],
        methods: ['bch_getAddresses', 'bch_signTransaction'],
        events: ['addressesChanged'],
      },
    },
  });
  printRequest('WalletConnect', uri, buildSampleRequest(destination, sourceUtxo));
  const session = await approval();
  state.sessions.walletconnect = {
    topic: session.topic,
    peer: session.peer.metadata.name,
  };
  const request = buildSampleRequest(destination, sourceUtxo);
  beginRequest(state, 'walletconnect', request);
  const response = await client.request({
    topic: session.topic,
    chainId: CHAIN_ID,
    request: {
      method: 'bch_signTransaction',
      params: request,
    },
  });
  state.lastResponse = { connector: 'walletconnect', response };
  state.phase = 'response-received';
  console.log('[WalletConnect] response received; no broadcast was requested.');
  await client.disconnect({ topic: session.topic, reason: { code: 6000, message: 'Connector Lab complete' } });
}

async function runWizardConnect(state, destination) {
  state.activeConnector = 'wizardconnect';
  state.phase = 'connecting';
  const sourceUtxo = await getLiveBchReviewUtxo(destination);
  let relayClient;
  let relayConnected;
  const relayReady = new Promise((resolve) => {
    relayConnected = resolve;
  });
  const relay = initiateDappRelay(
    ({ client, status }) => {
      console.log(`[WizardConnect] relay ${status.status}`);
      relayClient = client;
      if (status.status === 'connected') {
        relayConnected();
      }
    },
    { explicitRelayUrls: [RELAY_URL] }
  );
  await relayReady;
  const request = buildSampleRequest(destination, sourceUtxo);
  const ready = {
    action: 'dapp_ready',
    time: Date.now(),
    supported_protocols: ['hdwalletv1'],
    wallet_discovered: false,
    dapp_name: DAPP_NAME,
  };
  let responsePromise;
  relayClient.on('message', (message) => {
    if (message.action === 'sign_transaction_response') {
      responsePromise?.(message);
    }
  });
  const keyExchange = new Promise((resolve) => {
    relay.events.once('keyexchangecomplete', resolve);
  });
  console.log(`[WizardConnect] Pairing URI:\n${relay.uri}`);
  console.log('[WizardConnect] Waiting for the wallet to complete key exchange.');
  await keyExchange;
  await relayClient.relay(ready);
  const sequence = relayClient.nextSequence();
  const wireRequest = {
    action: 'sign_transaction_request',
    time: Date.now(),
    sequence,
    transaction: {
      transaction: encodedTransaction(request),
      sourceOutputs: request.sourceOutputs,
      broadcast: false,
      userPrompt: request.userPrompt,
    },
    inputPaths: [[0, 'receive', 0]],
  };
  state.activeConnector = 'wizardconnect';
  state.phase = 'review-requested';
  state.lastRequest = { connector: 'wizardconnect', request: wireRequest };
  state.lastReviewSummary = summarizeBchRequest(request, 'wizardconnect');
  printRequest('WizardConnect', null, wireRequest);
  const response = new Promise((resolve) => {
    responsePromise = resolve;
  });
  await relayClient.relay(wireRequest);
  const result = await response;
  state.lastResponse = { connector: 'wizardconnect', response: result };
  state.phase = 'response-received';
  console.log('[WizardConnect] response received; no broadcast was requested.');
  relay.cleanup();
}

async function runCashConnect(state, destination) {
  state.activeConnector = 'cashconnect';
  state.phase = 'connecting';
  const template = {
    name: 'OPTN Connector Lab BCH transfer',
    description: 'A disposable BCH-only action for comparing wallet review UI.',
    actions: {
      sweep: {
        meta: {
          title: 'Connector Lab BCH transfer',
          description: 'Return BCH to the OPTN Connector Lab destination.',
        },
        params: {},
        instructions: [
          {
            type: 'transaction',
            payload: {
              name: 'sweep',
              version: 2,
              locktime: 0,
              inputs: ['*'],
              outputs: [
                {
                  valueSatoshis: 500000n,
                  lockingBytecode: { script: destination.lockingScript },
                },
                '*',
              ],
              validate: false,
            },
          },
        ],
        returns: {},
      },
    },
  };
  const dapp = new Dapp({
    relayUrl: process.env.OPTN_CASHCONNECT_RELAY_URL,
    info: {
      name: DAPP_NAME,
      url: 'http://127.0.0.1:8787',
      description: 'Disposable OPTN Wallet connector review harness',
    },
    chain: 'bchtest',
    template,
    allowedTokens: [],
    store: new MemoryStore(),
  });
  await dapp.start();
  const invite = dapp.createInviteUrl();
  console.log('\n[CashConnect]');
  console.log(`Pairing invite:\n${invite}`);
  console.log('Approve the connection in OPTN Wallet, then the action review will appear.');
  const session = await dapp.pair({ timeoutMs: 5 * 60 * 1000 });
  state.phase = 'paired';
  state.sessions.cashconnect = {
    walletPubkey: session.walletPubkey.slice(0, 8),
    status: 'paired',
  };
  state.lastRequest = {
    connector: 'cashconnect',
    action: 'sweep',
    expectedBchOutput: '0.00500000 BCH plus wallet-generated change',
  };
  state.lastReviewSummary = {
    connector: 'cashconnect',
    network: NETWORK,
    operation: 'Approve prepared action',
    action: 'sweep',
    fixedOutputSatoshis: '500000',
    change: 'wallet-generated change',
    sourceOutputs: 'reported by wallet during execution',
  };
  state.phase = 'review-requested';
  const response = await dapp.executeAction(
    'sweep',
    {},
    { timeoutMs: 5 * 60 * 1000 }
  );
  state.lastResponse = {
    connector: 'cashconnect',
    transactionCount: response.transactions.length,
    balanceChanges: Object.fromEntries(
      Object.entries(response.balanceChanges).map(([key, value]) => [key, String(value)])
    ),
  };
  state.phase = 'response-received';
  console.log('[CashConnect] action response received.');
  console.log(`Prepared transactions: ${response.transactions.length}`);
  console.log(`Request-reported balance changes: ${JSON.stringify(state.lastResponse.balanceChanges)}`);
  await dapp.forgetSession('Connector Lab complete');
  await dapp.stop();
}

async function runPreflight(state, destination) {
  state.activeConnector = 'preflight';
  state.phase = 'utxo-preflight';
  const utxos = await queryChipnetUtxos(destination);
  const total = utxos.reduce((sum, utxo) => sum + BigInt(utxo.valueSatoshis), 0n);
  const tokenUtxos = utxos.filter((utxo) => utxo.token);
  let fundingBatches;
  try {
    fundingBatches = allocateDisjointBchBatches(
      utxos,
      ['walletconnect', 'wizardconnect', 'cashconnect']
    );
  } catch (error) {
    fundingBatches = { refused: error instanceof Error ? error.message : String(error) };
  }
  const tokenPlan = buildTokenPreservationPlan(tokenUtxos);
  assertTokenPreservation(tokenPlan);
  state.preflight = {
    address: destination.address,
    utxoCount: utxos.length,
    totalSatoshis: total.toString(),
    tokenUtxoCount: tokenUtxos.length,
    utxos: utxos.map((utxo) => ({
      ...utxo,
      txid: `${utxo.txid.slice(0, 4)}…${utxo.txid.slice(-4)}`,
    })),
    fundingBatches: Array.isArray(fundingBatches)
      ? fundingBatches.map((batch) => ({
          connector: batch.connector,
          inputs: batch.inputs.map((utxo) => ({
            txid: `${utxo.txid.slice(0, 4)}…${utxo.txid.slice(-4)}`,
            outpointIndex: utxo.outpointIndex,
            valueSatoshis: utxo.valueSatoshis,
          })),
        }))
      : fundingBatches,
    tokenPreservationPlan: tokenPlan.map((item) => ({
      input: {
        txid: `${item.input.txid.slice(0, 4)}…${item.input.txid.slice(-4)}`,
        outpointIndex: item.input.outpointIndex,
        valueSatoshis: item.input.valueSatoshis,
        token: item.input.token,
      },
      output: item.output,
    })),
  };
  state.phase = 'preflight-complete';
  console.log(`\n[Chipnet preflight] ${utxos.length} UTXO(s), ${total} satoshis, ${tokenUtxos.length} token-bearing UTXO(s).`);
  console.log('[Chipnet preflight] Disjoint BCH-only batches are identified for comparison; no transaction will be broadcast.');
}

async function main() {
  const connector = process.argv[2] || 'all';
  const port = Number(process.env.OPTN_CONNECTOR_LAB_PORT || DEFAULT_PORT);
  const { server, state, port: actualPort } = await startStatusServer(port);
  const destination = await deriveChipnetReceiveAddress();
  console.log(`Connector Lab status server: http://127.0.0.1:${actualPort}`);
  console.log(`Network locked to ${NETWORK}.`);
  console.log(`Broadcast gate: ${state.broadcastEnabled ? 'enabled' : 'disabled'}.`);
  console.log('Commands: preflight, wc, wizard, cash, all, quit');

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const run = async (name) => {
    if (name === 'preflight') await runPreflight(state, destination);
    else if (name === 'wc') await runWalletConnect(state, destination);
    else if (name === 'wizard') await runWizardConnect(state, destination);
    else if (name === 'cash') await runCashConnect(state, destination);
    else if (name === 'all') {
      console.log('Run each connector separately so review evidence is not conflated.');
      await runCashConnect(state, destination);
    }
  };
  if (connector !== 'all') {
    void run(connector).catch((error) => {
      console.error(`[${connector}] ${error.message}`);
      readline.close();
      server.close();
    });
  }
  readline.on('line', (line) => {
    const command = line.trim().toLowerCase();
    if (command === 'quit' || command === 'exit') {
      readline.close();
      server.close();
      return;
    }
    void run(command).catch((error) => console.error(`[${command}] ${error.message}`));
  });
}

export { buildSampleRequest, summarizeBchRequest };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Connector Lab failed: ${error.message}`);
    process.exitCode = 1;
  });
}
