/**
 * Live chipnet watch-only E2E with SeedCash emulator (not hardware camera).
 * Dummy BIP39: abandon…about — already funded on chipnet.
 * Flow: listunspent → buildWatchOnlyPsbt → sign_psbt.py → import → VM → broadcast
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

import {
  binToHex,
  createVirtualMachineBCH,
  decodeHdPublicKey,
  decodeTransaction,
  deriveHdPathRelative,
  encodeCashAddress,
  hash160,
  hexToBin,
} from '@bitauth/libauth';

import { buildWatchOnlyPsbt } from '../../src/services/psbt/watchOnlySend.ts';
import {
  inspectImportedPsbt,
  mergeImportedSignatures,
} from '../../src/services/psbt/watchOnlyImport.ts';

const ROOT = process.cwd();
const SIGNER = join(ROOT, 'scripts', 'seedcash', 'sign_psbt.py');
const CWD = join(ROOT, 'scripts', 'seedcash');
const HOST = 'chipnet.bch.ninja';
const PORT = 50002;
const XPUB =
  'xpub6ByHsPNSQXTWZ7PLESMY2FufyYWtLXagSUpMQq7Un96SiThZH2iJB1X7pwviH1WtKVeDP6K8d6xxFzzoaFzF3s8BKCZx8oEDdDkNnp4owAZ';
const FINGERPRINT = '73c5da0a';
const ACCOUNT = "m/44'/145'/0'";
const SEND_SATS = 10_000n;

function electrum(method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host: HOST, port: PORT, servername: HOST },
      () => {
        socket.write(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n'
        );
      }
    );
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as {
          result?: unknown;
          error?: unknown;
        };
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } catch (e) {
        reject(e);
      }
    });
    socket.on('error', reject);
    socket.setTimeout(45_000, () => socket.destroy(new Error('timeout')));
  });
}

function p2pkhScript(publicKey: Uint8Array): Uint8Array {
  const script = new Uint8Array(25);
  script[0] = 0x76;
  script[1] = 0xa9;
  script[2] = 0x14;
  script.set(hash160(publicKey), 3);
  script[23] = 0x88;
  script[24] = 0xac;
  return script;
}

function electrumScripthash(lockingBytecode: Uint8Array): string {
  const digest = createHash('sha256').update(lockingBytecode).digest();
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

  console.log('1) address', address);

  const utxos = (await electrum('blockchain.scripthash.listunspent', [sh])) as {
    tx_hash: string;
    tx_pos: number;
    value: number;
    token_data?: unknown;
  }[];
  const plain = (utxos || []).filter((u) => !u.token_data && u.value > 50_000);
  if (!plain.length) throw new Error('no plain BCH UTXO large enough');
  plain.sort((a, b) => b.value - a.value);
  const utxo = plain[0];
  console.log('2) UTXO', utxo.tx_hash + ':' + utxo.tx_pos, utxo.value, 'sats');

  const parentHex = (await electrum('blockchain.transaction.get', [
    utxo.tx_hash,
    false,
  ])) as string;
  console.log('3) parent tx bytes', parentHex.length / 2);

  const inputs = [
    {
      txid: utxo.tx_hash,
      vout: utxo.tx_pos,
      satoshis: BigInt(utxo.value),
      lockingBytecodeHex: binToHex(lockingBytecode),
      publicKeyHex: binToHex(publicKey),
      branchIndex: 0 as const,
      addressIndex: 0,
      previousTransactionHex: parentHex,
    },
  ];

  const built = buildWatchOnlyPsbt({
    inputs,
    recipient: address,
    amountSats: SEND_SATS,
    changeAddress: address,
    accountPath: ACCOUNT,
    masterFingerprint: hexToBin(FINGERPRINT),
  });
  console.log(
    '4) PSBT built',
    built.psbtBytes.length,
    'bytes fee',
    built.feeSats.toString()
  );

  const proposal = {
    rawUnsignedHex: built.rawUnsignedHex,
    inputs,
    outputs: built.outputs,
  };

  const dir = mkdtempSync(join(tmpdir(), 'seedcash-e2e-'));
  const unsignedPath = join(dir, 'unsigned.hex');
  const signedPath = join(dir, 'signed.hex');
  writeFileSync(unsignedPath, binToHex(built.psbtBytes));
  console.log('5) SeedCash emulator signing…');
  execFileSync('python', [SIGNER, 'sign', unsignedPath, signedPath], {
    cwd: CWD,
    encoding: 'utf8',
  });
  const signed = hexToBin(readFileSync(signedPath, 'utf8').trim());
  const inspected = inspectImportedPsbt(signed, proposal);
  console.log('6) import state', inspected.state);
  if (inspected.state !== 'complete') {
    console.error(inspected);
    process.exit(1);
  }

  const rawTxHex = mergeImportedSignatures(signed, proposal);
  const parentTx = decodeTransaction(hexToBin(parentHex));
  if (typeof parentTx === 'string') throw new Error(parentTx);
  const sourceOutput = parentTx.outputs[utxo.tx_pos];
  const vm = createVirtualMachineBCH();
  const tx = decodeTransaction(hexToBin(rawTxHex));
  if (typeof tx === 'string') throw new Error(tx);
  const ok = vm.verify({
    sourceOutputs: [sourceOutput],
    transaction: tx,
  });
  console.log('7) BCH VM', ok);
  if (ok !== true) process.exit(2);

  console.log('8) broadcasting…');
  const txid = (await electrum('blockchain.transaction.broadcast', [
    rawTxHex,
  ])) as string;
  console.log('9) SUCCESS chipnet txid', txid);
  console.log(
    'NOTE: hardware camera not used — SeedCash Python emulator signed.'
  );
}

main().catch((e) => {
  console.error('E2E FAILED', e);
  process.exit(1);
});
