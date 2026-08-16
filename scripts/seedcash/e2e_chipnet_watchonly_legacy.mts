/**
 * Live chipnet watch-only E2E (emulator SeedCash, not hardware camera):
 *   listunspent → build PSBT → sign via sign_psbt.py → broadcast
 *
 * Uses BIP39 abandon…about test vector (public, already funded on chipnet).
 * Sends a tiny amount back to the same wallet (self-send) so funds stay on the
 * test address. Chipnet only.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import tls from 'node:tls';

import {
  binToHex,
  createVirtualMachineBCH,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPathRelative,
  encodeCashAddress,
  hash160,
  hash256,
  hexToBin,
} from '@bitauth/libauth';

const require = createRequire(import.meta.url);
// Resolve built sources via path into src for direct use in tests already work via vitest;
// here we duplicate minimal electrum client and import watchOnly via dynamic path.
const ROOT = join(process.cwd());
const SIGNER = join(ROOT, 'scripts', 'seedcash', 'sign_psbt.py');
const CWD = join(ROOT, 'scripts', 'seedcash');

const ELECTRUM = { host: 'chipnet.bch.ninja', port: 50002 };
const XPUB =
  'xpub6ByHsPNSQXTWZ7PLESMY2FufyYWtLXagSUpMQq7Un96SiThZH2iJB1X7pwviH1WtKVeDP6K8d6xxFzzoaFzF3s8BKCZx8oEDdDkNnp4owAZ';
const FINGERPRINT = '73c5da0a';
const ACCOUNT = "m/44'/145'/0'";
const SEND_SATS = 10_000n; // tiny self-send

function electrumRequest(method, params) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: ELECTRUM.host, port: ELECTRUM.port, servername: ELECTRUM.host },
      () => {
        const id = 1;
        socket.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        );
      }
    );
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          socket.end();
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        } catch (e) {
          reject(e);
        }
      }
    });
    socket.on('error', reject);
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error('electrum timeout'));
    });
  });
}

function p2pkhScript(publicKey) {
  const script = new Uint8Array(25);
  script[0] = 0x76;
  script[1] = 0xa9;
  script[2] = 0x14;
  script.set(hash160(publicKey), 3);
  script[23] = 0x88;
  script[24] = 0xac;
  return script;
}

function electrumScripthash(lockingBytecode) {
  // reverse(sha256(script))
  const h = hash256(lockingBytecode); // wait - electrum uses sha256 not double
  // electrum: scripthash = reverse(sha256(scriptPubKey))
  const { createHash } = require('node:crypto');
  const digest = createHash('sha256')
    .update(Buffer.from(lockingBytecode))
    .digest();
  return Buffer.from(digest).reverse().toString('hex');
}

async function main() {
  const acc = decodeHdPublicKey(XPUB);
  if (typeof acc === 'string') throw new Error(acc);
  const child = deriveHdPathRelative(acc.node, '0/0');
  if (typeof child === 'string') throw new Error(child);
  const publicKey = child.publicKey;
  const lockingBytecode = p2pkhScript(publicKey);
  const address = encodeCashAddress({
    payload: hash160(publicKey),
    prefix: 'bchtest',
    type: 'p2pkh',
  }).address;
  const sh = electrumScripthash(lockingBytecode);

  console.log('address', address);
  console.log('scripthash', sh);

  const utxos = await electrumRequest('blockchain.scripthash.listunspent', [
    sh,
  ]);
  const plain = (utxos || []).filter((u) => !u.token_data && u.value > 20_000);
  if (!plain.length) throw new Error('no plain BCH UTXOs');
  // Prefer a large plain UTXO for fee headroom
  plain.sort((a, b) => b.value - a.value);
  const utxo = plain[0];
  console.log('using utxo', utxo);

  const parentHex = await electrumRequest('blockchain.transaction.get', [
    utxo.tx_hash,
    false,
  ]);
  if (typeof parentHex !== 'string' || parentHex.length < 20) {
    throw new Error('failed to fetch parent tx');
  }

  // Import buildWatchOnlyPsbt from TS via vitest path - use dynamic import of compiled?
  // Use child_process to run a small vitest/node tsx instead.
  // Write a temp fixture and call node with tsx if available.
  const { buildWatchOnlyPsbt } = await import(
    '../../src/services/psbt/watchOnlySend.ts'
  ).catch(async () => {
    // fallback: run via npx tsx
    return { buildWatchOnlyPsbt: null };
  });

  if (!buildWatchOnlyPsbt) {
    // spawn tsx inline script
    const script = `
import { buildWatchOnlyPsbt } from './src/services/psbt/watchOnlySend.ts';
import { inspectImportedPsbt, mergeImportedSignatures } from './src/services/psbt/watchOnlyImport.ts';
import { binToHex, hexToBin, createVirtualMachineBCH, decodeTransaction } from '@bitauth/libauth';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

const utxo = ${JSON.stringify(utxo)};
const parentHex = ${JSON.stringify(parentHex)};
const publicKeyHex = ${JSON.stringify(binToHex(publicKey))};
const lockingBytecodeHex = ${JSON.stringify(binToHex(lockingBytecode))};
const address = ${JSON.stringify(address)};
const SEND_SATS = ${SEND_SATS.toString()}n;
const FINGERPRINT = ${JSON.stringify(FINGERPRINT)};
const ACCOUNT = ${JSON.stringify(ACCOUNT)};
const SIGNER = ${JSON.stringify(SIGNER)};
const CWD = ${JSON.stringify(CWD)};

const inputs = [{
  txid: utxo.tx_hash,
  vout: utxo.tx_pos,
  satoshis: BigInt(utxo.value),
  lockingBytecodeHex,
  publicKeyHex,
  branchIndex: 0,
  addressIndex: 0,
  previousTransactionHex: parentHex,
}];

const built = buildWatchOnlyPsbt({
  inputs,
  recipient: address,
  amountSats: SEND_SATS,
  changeAddress: address,
  accountPath: ACCOUNT,
  masterFingerprint: hexToBin(FINGERPRINT),
});

const proposal = {
  rawUnsignedHex: built.rawUnsignedHex,
  inputs,
  outputs: built.outputs,
};

const dir = mkdtempSync(join(tmpdir(), 'seedcash-e2e-'));
const unsignedPath = join(dir, 'unsigned.hex');
const signedPath = join(dir, 'signed.hex');
writeFileSync(unsignedPath, binToHex(built.psbtBytes));
execFileSync('python', [SIGNER, 'sign', unsignedPath, signedPath], { cwd: CWD, encoding: 'utf8' });
const signed = hexToBin(readFileSync(signedPath, 'utf8').trim());
const inspected = inspectImportedPsbt(signed, proposal);
console.log('import state', inspected.state);
if (inspected.state !== 'complete') {
  console.error(inspected);
  process.exit(1);
}
const rawTxHex = mergeImportedSignatures(signed, proposal);
console.log('rawTx len', rawTxHex.length);

// VM check with real parent output
const parentTx = decodeTransaction(hexToBin(parentHex));
if (typeof parentTx === 'string') throw new Error(parentTx);
const sourceOutput = parentTx.outputs[utxo.tx_pos];
const vm = createVirtualMachineBCH();
const tx = decodeTransaction(hexToBin(rawTxHex));
if (typeof tx === 'string') throw new Error(tx);
const ok = vm.verify({ sourceOutputs: [sourceOutput], transaction: tx });
console.log('vm', ok);
if (!ok) process.exit(2);

// broadcast
const txid = await new Promise((resolve, reject) => {
  const socket = tls.connect({ host: 'chipnet.bch.ninja', port: 50002, servername: 'chipnet.bch.ninja' }, () => {
    socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'blockchain.transaction.broadcast', params: [rawTxHex] }) + '\\n');
  });
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (c) => {
    buf += c;
    if (buf.includes('\\n')) {
      socket.end();
      try {
        const msg = JSON.parse(buf.split('\\n')[0]);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } catch (e) { reject(e); }
    }
  });
  socket.on('error', reject);
});
console.log('broadcast txid', txid);
`;
    writeFileSync(join(ROOT, 'scripts', 'seedcash', '_e2e_inner.mts'), script);
    const out = execFileSync(
      'npx',
      ['tsx', 'scripts/seedcash/_e2e_inner.mts'],
      { cwd: ROOT, encoding: 'utf8', env: process.env }
    );
    console.log(out);
    return;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
