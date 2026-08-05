import { describe, expect, it } from 'vitest';
import {
  cashAddressToLockingBytecode,
  decodeTransaction,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { binToHex, hexToBin } from '../../../utils/hex';
import {
  computeHistoryStatusHash,
  EMPTY_HISTORY_STATUS,
  historyStatusesMatch,
} from '../WalletLedgerService';

describe('computeHistoryStatusHash', () => {
  it('returns empty-history sentinel for empty history (not null)', () => {
    expect(computeHistoryStatusHash([])).toBe(EMPTY_HISTORY_STATUS);
    expect(historyStatusesMatch(EMPTY_HISTORY_STATUS, null)).toBe(true);
  });

  it('is stable for the same history list', () => {
    const hist = [
      { tx_hash: 'aa'.repeat(32), height: 100 },
      { tx_hash: 'bb'.repeat(32), height: 101 },
    ];
    expect(computeHistoryStatusHash(hist)).toBe(computeHistoryStatusHash(hist));
  });

  it('changes when height changes', () => {
    const a = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 100 },
    ]);
    const b = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 101 },
    ]);
    expect(a).not.toBe(b);
  });

  it('matches EC/Selene style shape (64 hex chars)', () => {
    const h = computeHistoryStatusHash([
      { tx_hash: 'cc'.repeat(32), height: 1 },
    ]);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is order-sensitive (EC concatenates in server order)', () => {
    const a = computeHistoryStatusHash([
      { tx_hash: 'aa'.repeat(32), height: 1 },
      { tx_hash: 'bb'.repeat(32), height: 2 },
    ]);
    const b = computeHistoryStatusHash([
      { tx_hash: 'bb'.repeat(32), height: 2 },
      { tx_hash: 'aa'.repeat(32), height: 1 },
    ]);
    expect(a).not.toBe(b);
  });
});

describe('ledger raw-tx primitives', () => {
  it('decodes a known minimal P2PKH-style raw tx hex', () => {
    // version(2 LE) + input count 1 + prevhash(32 zero) + previndex 0 +
    // empty script + sequence ffffffff + output count 1 + value 1000 LE +
    // p2pkh-ish locking (OP_DUP OP_HASH160 <20 zero> OP_EQUALVERIFY OP_CHECKSIG)
    // + locktime 0
    const prevHash = '00'.repeat(32);
    const pkh = '11'.repeat(20);
    const locking = `76a914${pkh}88ac`;
    const lockingLen = (locking.length / 2).toString(16).padStart(2, '0');
    const value = 'e803000000000000'; // 1000 sat little-endian
    const raw =
      '02000000' + // version 2
      '01' + // 1 input
      prevHash +
      '00000000' + // vout 0
      '00' + // empty unlocking
      'ffffffff' + // sequence
      '01' + // 1 output
      value +
      lockingLen +
      locking +
      '00000000'; // locktime

    const decoded = decodeTransaction(hexToBin(raw));
    if (typeof decoded === 'string') {
      throw new Error(decoded);
    }
    expect(decoded.inputs).toHaveLength(1);
    expect(decoded.outputs).toHaveLength(1);
    expect(Number(decoded.outputs[0].valueSatoshis)).toBe(1000);

    // Ledger converts internal outpoint hash → RPC-order txid via reverse
    const internal = decoded.inputs[0].outpointTransactionHash;
    const rpcTxid = binToHex(Uint8Array.from(internal).reverse());
    expect(rpcTxid).toBe('00'.repeat(32));

    const addr = lockingBytecodeToCashAddress({
      bytecode: decoded.outputs[0].lockingBytecode,
      prefix: 'bitcoincash',
    });
    const address = typeof addr === 'string' ? addr : addr.address;
    expect(address.startsWith('bitcoincash:')).toBe(true);

    const back = cashAddressToLockingBytecode(address);
    if (typeof back === 'string') throw new Error(back);
    expect(binToHex(back.bytecode)).toBe(
      binToHex(decoded.outputs[0].lockingBytecode)
    );
  });
});

describe('WalletLedgerService public API surface', () => {
  it('exports the E2E Option A entry points', async () => {
    const mod = await import('../WalletLedgerService');
    expect(typeof mod.applyRawTransaction).toBe('function');
    expect(typeof mod.fetchAndApplyMissingTransactions).toBe('function');
    expect(typeof mod.verifyOutpointsStillUnspent).toBe('function');
    expect(typeof mod.getWalletGenesisHeight).toBe('function');
    expect(typeof mod.noteWalletHeights).toBe('function');
    expect(typeof mod.getScanFromHeight).toBe('function');
    expect(typeof mod.loadWalletAddressSet).toBe('function');
    expect(typeof mod.listTxidsMissingRawHex).toBe('function');
    expect(typeof mod.storeLedgerTransaction).toBe('function');
    expect(typeof mod.rebuildUtxosFromLedger).toBe('function');
    expect(typeof mod.clearWalletChainData).toBe('function');
    expect(typeof mod.addressHistoryIsFresh).toBe('function');
    expect(typeof mod.partitionAddressesByStatus).toBe('function');
    expect(typeof mod.getAddressHistoryStatusMap).toBe('function');
  });
});
