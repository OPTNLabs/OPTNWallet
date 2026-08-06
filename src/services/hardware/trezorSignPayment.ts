/**
 * Trezor/OneKey payment signing.
 *
 * Source of truth (do not invent):
 * - Electron Cash: electroncash_plugins/trezor/trezor.py
 *     sign_transaction → client.sign_tx(get_coin_name(), inputs, outputs, prev_txes=…)
 *     get_coin_name() → "Bcash" / "Bcash Testnet"
 *     electrum_tx_to_txtype → TransactionType with inputs + bin_outputs
 * - trezorlib btc.sign_tx (python): TxRequest loop with TXMETA/TXINPUT/TXOUTPUT/TXFINISHED
 * - Trezor firmware docs: https://docs.trezor.io/trezor-firmware/common/bitcoin-signing.html
 * - libauth: decodeTransaction for prev_tx parsing (not a hand-rolled decoder)
 *
 * Wire transport: TrezorNativeSession (Bridge :21325 for Safe 5, HID for One).
 */

import {
  binToHex,
  decodeTransaction,
  hexToBin,
} from '@bitauth/libauth';
import type { LedgerInput, LedgerOutput } from './LedgerService';
import {
  pathToAddressN,
  TrezorNativeSession,
} from './TrezorNativeSession';

/** EC TrezorPlugin.get_coin_name() */
function coinNameForNetwork(network?: 'mainnet' | 'chipnet'): string {
  return network === 'chipnet' ? 'Bcash Testnet' : 'Bcash';
}

function reverseHexTxid(txid: string): string {
  const h = txid.replace(/^0x/i, '').toLowerCase();
  if (h.length !== 64) return h;
  let out = '';
  for (let i = h.length; i > 0; i -= 2) out += h.slice(i - 2, i);
  return out;
}

/**
 * @trezor/protobuf decode.js converts bytes fields to hex strings.
 * Handle that plus Uint8Array in case of raw frames.
 */
function bytesToHex(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.startsWith('0x') ? v.slice(2) : v;
    return s.toLowerCase();
  }
  if (v instanceof Uint8Array) return binToHex(v);
  if (Array.isArray(v)) return binToHex(Uint8Array.from(v as number[]));
  return String(v);
}

function requestTypeName(rt: unknown): string {
  if (typeof rt === 'string') return rt.toUpperCase();
  const n = Number(rt);
  // messages.json RequestType enum
  const map: Record<number, string> = {
    0: 'TXINPUT',
    1: 'TXOUTPUT',
    2: 'TXMETA',
    3: 'TXFINISHED',
    4: 'TXEXTRADATA',
    5: 'TXORIGINPUT',
    6: 'TXORIGOUTPUT',
    7: 'TXPAYMENTREQ',
  };
  return map[n] ?? String(rt);
}

/**
 * EC electrum_tx_to_txtype + trezorlib from_json shape:
 * TransactionType with version, lock_time, inputs[], bin_outputs[].
 * Parsed via libauth decodeTransaction.
 */
type PrevTxType = {
  version: number;
  lock_time: number;
  inputs: Array<{
    prev_hash: string; // hex LE (wire / trezor)
    prev_index: number;
    script_sig: string; // hex
    sequence: number;
  }>;
  bin_outputs: Array<{
    amount: string; // string for protobuf uint64
    script_pubkey: string; // hex
  }>;
};

function electrumTxToTxtype(prevTxHex: string): PrevTxType {
  const decoded = decodeTransaction(hexToBin(prevTxHex));
  if (typeof decoded === 'string') {
    throw new Error(`libauth decodeTransaction failed on prev_tx: ${decoded}`);
  }
  return {
    version: decoded.version,
    lock_time: decoded.locktime,
    inputs: decoded.inputs.map((vin) => ({
      // Trezor prev_hash is internal byte order (same as wire LE); libauth
      // outpointTransactionHash is UI order — reverse to match trezorlib bytes.fromhex(txid)
      // trezorlib from_json: prev_hash=bytes.fromhex(vin["txid"]) where txid is UI order in JSON,
      // and protobuf sends raw bytes. Suite uses UI-order hex decoded to bytes as-is.
      // EC: prev_hash = unhexlify(txin['prevout_hash']) with Electrum UI-order hash.
      prev_hash: binToHex(vin.outpointTransactionHash),
      prev_index: vin.outpointIndex,
      script_sig: binToHex(vin.unlockingBytecode),
      sequence: vin.sequenceNumber,
    })),
    bin_outputs: decoded.outputs.map((vout) => ({
      amount: vout.valueSatoshis.toString(),
      script_pubkey: binToHex(vout.lockingBytecode),
    })),
  };
}

function copyTxMeta(tx: PrevTxType | { inputs: unknown[]; outputs: unknown[] }) {
  // trezorlib copy_tx_meta: clear arrays, set counts
  if ('bin_outputs' in tx) {
    const p = tx as PrevTxType;
    return {
      version: p.version,
      lock_time: p.lock_time,
      inputs_cnt: p.inputs.length,
      outputs_cnt: p.bin_outputs.length,
      extra_data_len: 0,
    };
  }
  const c = tx as { inputs: unknown[]; outputs: unknown[]; version?: number };
  return {
    version: c.version ?? 1,
    lock_time: 0,
    inputs_cnt: c.inputs.length,
    outputs_cnt: c.outputs.length,
  };
}

/**
 * Sign a simple BCH P2PKH payment on Trezor/OneKey.
 * Mirrors trezorlib btc.sign_tx + EC needs_prevtx / prev_tx map.
 */
export async function trezorSignPayment(args: {
  accountPath: string;
  inputs: Array<
    LedgerInput & { prevHash: string; amountSatoshis?: bigint }
  >;
  outputs: LedgerOutput[];
  changePath?: string;
  /**
   * Index of the change output in `outputs`. Required when `changePath` is set
   * — never infer "last output is change" (planner may interleave recipients).
   */
  changeOutputIndex?: number;
  deviceKind: 'trezor' | 'onekey';
  network?: 'mainnet' | 'chipnet';
}): Promise<string> {
  const coin_name = coinNameForNetwork(args.network);
  const session = new TrezorNativeSession(
    args.deviceKind === 'onekey' ? 'onekey' : 'trezor'
  );

  try {
    await session.open();
    await session.initialize();

    // EC TxInputType for SPENDADDRESS (for_sig=True path)
    const thisInputs = args.inputs.map((inp) => {
      if (!inp.prevHash) {
        throw new Error(
          'Trezor sign requires prevout hash on each input (EC prev_tx map).'
        );
      }
      const amount =
        inp.amountSatoshis != null
          ? inp.amountSatoshis.toString()
          : undefined;
      if (amount == null) {
        throw new Error(
          'Trezor SPENDADDRESS input requires amount (EC txin value).'
        );
      }
      return {
        address_n: pathToAddressN(inp.path),
        // EC: prev_hash = unhexlify(txin['prevout_hash']) — UI-order hex → bytes
        prev_hash: inp.prevHash.replace(/^0x/i, '').toLowerCase(),
        prev_index: inp.prevIndex,
        script_type: 'SPENDADDRESS',
        sequence: inp.sequence ?? 0xffffffff,
        amount,
      };
    });

    // EC tx_outputs: change uses address_n, external uses address string.
    // Only the explicit change index may use address_n.
    const changeIdx =
      args.changePath != null &&
      args.changeOutputIndex != null &&
      args.changeOutputIndex >= 0 &&
      args.changeOutputIndex < args.outputs.length
        ? args.changeOutputIndex
        : undefined;
    const thisOutputs = args.outputs.map((o, idx) => {
      if (changeIdx === idx && args.changePath) {
        return {
          address_n: pathToAddressN(args.changePath),
          amount: o.amountSatoshis.toString(),
          script_type: 'PAYTOADDRESS',
        };
      }
      return {
        address: o.address,
        amount: o.amountSatoshis.toString(),
        script_type: 'PAYTOADDRESS',
      };
    });

    // EC electrum_tx_to_txtype for each prev_tx
    const prevByHash = new Map<string, PrevTxType>();
    for (const inp of args.inputs) {
      const key = inp.prevHash.replace(/^0x/i, '').toLowerCase();
      if (!prevByHash.has(key)) {
        prevByHash.set(key, electrumTxToTxtype(inp.prevTxHex));
      }
    }

    // trezorlib: session.call(SignTx(...), expect=TxRequest)
    let res = await session.call('SignTx', {
      outputs_count: thisOutputs.length,
      inputs_count: thisInputs.length,
      coin_name,
      version: 1,
      lock_time: 0,
    });

    let serializedTx = '';

    for (let guard = 0; guard < 500; guard++) {
      if (res.type !== 'TxRequest') {
        if (res.type === 'Failure') {
          throw new Error(
            `Trezor sign failed: ${String(
              (res.message as { message?: string }).message ?? res.type
            )}`
          );
        }
        throw new Error(`Unexpected Trezor message during sign: ${res.type}`);
      }

      const msg = res.message as {
        request_type?: unknown;
        details?: {
          request_index?: number;
          tx_hash?: unknown;
          extra_data_len?: number;
          extra_data_offset?: number;
        };
        serialized?: {
          serialized_tx?: unknown;
          signature_index?: number;
          signature?: unknown;
        };
      };

      // Accumulate streamed serialized_tx (trezorlib)
      const chunk = bytesToHex(msg.serialized?.serialized_tx);
      if (chunk) serializedTx += chunk;

      const rtype = requestTypeName(msg.request_type);

      if (rtype === 'TXFINISHED') {
        if (!serializedTx) {
          throw new Error('Trezor TXFINISHED without serialized_tx');
        }
        return serializedTx;
      }

      const details = msg.details ?? {};
      const txHashHex = details.tx_hash
        ? bytesToHex(details.tx_hash).toLowerCase()
        : '';

      // Resolve which transaction the device is asking about
      let currentPrev: PrevTxType | null = null;
      if (txHashHex) {
        currentPrev = prevByHash.get(txHashHex) ?? null;
        if (!currentPrev) {
          // Some firmwares send internal-order hash; try reversed
          currentPrev =
            prevByHash.get(reverseHexTxid(txHashHex)) ?? null;
        }
        if (!currentPrev) {
          throw new Error(
            `Previous transaction ${txHashHex} not available (EC needs_prevtx / trezorlib prev_txes).`
          );
        }
      }

      const idx = Number(details.request_index ?? 0);

      // trezorlib branch on request_type — old-style TxAck
      if (rtype === 'TXMETA') {
        if (!currentPrev) {
          throw new Error('TXMETA without tx_hash for current tx is unexpected');
        }
        res = await session.call('TxAck', {
          tx: copyTxMeta(currentPrev),
        });
        continue;
      }

      if (rtype === 'TXINPUT' || rtype === 'TXORIGINPUT') {
        if (currentPrev) {
          const pin = currentPrev.inputs[idx];
          if (!pin) {
            throw new Error(`Prev tx input ${idx} missing`);
          }
          res = await session.call('TxAck', {
            tx: {
              inputs: [
                {
                  prev_hash: pin.prev_hash,
                  prev_index: pin.prev_index,
                  script_sig: pin.script_sig,
                  sequence: pin.sequence,
                },
              ],
            },
          });
        } else {
          const inp = thisInputs[idx];
          if (!inp) throw new Error(`Current input ${idx} missing`);
          res = await session.call('TxAck', {
            tx: { inputs: [inp] },
          });
        }
        continue;
      }

      if (rtype === 'TXOUTPUT' || rtype === 'TXORIGOUTPUT') {
        if (currentPrev) {
          // trezorlib: bin_outputs for previous transaction outputs
          const bout = currentPrev.bin_outputs[idx];
          if (!bout) {
            throw new Error(`Prev tx bin_output ${idx} missing`);
          }
          res = await session.call('TxAck', {
            tx: {
              bin_outputs: [
                {
                  amount: bout.amount,
                  script_pubkey: bout.script_pubkey,
                },
              ],
            },
          });
        } else {
          const out = thisOutputs[idx];
          if (!out) throw new Error(`Current output ${idx} missing`);
          res = await session.call('TxAck', {
            tx: { outputs: [out] },
          });
        }
        continue;
      }

      if (rtype === 'TXEXTRADATA') {
        // BCH has no extra_data; Zcash-style only. Refuse inventing a body.
        throw new Error(
          'Trezor requested TXEXTRADATA — not used for BCH (EC Bcash).'
        );
      }

      if (rtype === 'TXPAYMENTREQ') {
        throw new Error('Payment requests are not supported on this path.');
      }

      throw new Error(`Unknown Trezor request_type: ${rtype}`);
    }

    throw new Error('Trezor sign: too many TxRequest rounds');
  } finally {
    await session.close();
  }
}
