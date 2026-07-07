// Stealth BCH balance card — shown on Assets when RPA is enabled.
// Scans a Fulcrum-RPA capable server for incoming RPA payments using the
// recipient's paycode as a prefix filter. No notification transactions —
// BCH RPA hides detectability inside the sender's signature nonce.

import React, { useCallback, useState } from 'react';
import { useSelector } from 'react-redux';
import { selectRpaEnabled } from '../../state/slices/experimentalSlice';
import { selectCurrentNetwork } from '../../state/selectors/networkSelectors';
import {
  deriveRpaKeys,
  deriveAndEncodePaycode,
  computeSharedSecret,
  derivePaymentAddress,
  RPA_PREFIX_BITS,
} from '../../services/RpaService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import getElectrumAdapter from '../../services/ElectrumAdapter';
import { SATSINBITCOIN } from '../../utils/constants';

type StealthBalanceCardProps = {
  walletId: number;
};

type RpaTxEntry = {
  tx_hash: string;
  height: number;
};

type UtxoEntry = {
  tx_hash: string;
  tx_pos: number;
  value: number;
  height: number;
};

export const StealthBalanceCard: React.FC<StealthBalanceCardProps> = ({ walletId }) => {
  const rpaEnabled = useSelector(selectRpaEnabled);
  const network = useSelector(selectCurrentNetwork);

  const [stealthSats, setStealthSats] = useState<number>(0);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);

  const handleSync = useCallback(async () => {
    if (syncing) return;

    setSyncing(true);
    setSyncError(null);
    setServerNote(null);

    try {
      const walletManager = WalletManager();
      const info = await walletManager.getWalletInfo(walletId);
      if (!info?.mnemonic) throw new Error('Wallet not unlocked');

      const mnemonic = info.mnemonic;
      const passphrase = info.passphrase ?? '';

      // Derive scan + spend keys (we need scan privkey for ECDH and spend pubkey for address derivation)
      const rpaKeys = await deriveRpaKeys(mnemonic, passphrase);
      const paycode = await deriveAndEncodePaycode(mnemonic, passphrase, network, RPA_PREFIX_BITS);

      const adapter = getElectrumAdapter();

      // Fulcrum-RPA exposes `rpa.getaddresshistory` — returns txs whose input hash prefix
      // matches the scan pubkey embedded in the paycode.
      let history: RpaTxEntry[];
      try {
        history = await adapter.request('rpa.getaddresshistory', paycode) as RpaTxEntry[];
      } catch {
        // Server doesn't support RPA scanning
        setServerNote('This server does not support RPA scanning. Connect to a Fulcrum-RPA capable server (e.g. chipnet.bch.ninja on testnet).');
        return;
      }

      if (!Array.isArray(history) || history.length === 0) {
        setMatchCount(0);
        setStealthSats(0);
        setLastSynced(new Date().toLocaleTimeString());
        return;
      }

      // For each candidate tx, fetch the raw tx, extract the sender's input pubkey,
      // compute the ECDH shared secret, derive the expected payment address,
      // and check if any output sends to that address.
      let totalSats = 0;
      let confirmedMatches = 0;

      await Promise.allSettled(
        history.map(async ({ tx_hash }) => {
          try {
            type RawTx = { inputs: { prevout_hash: string; prevout_n: number; pubkeys?: string[] }[]; outputs: { address?: string; value: number }[] };
            const tx = await adapter.request('blockchain.transaction.get', tx_hash, true) as RawTx;

            for (const input of tx.inputs ?? []) {
              const pubkeys = input.pubkeys ?? [];
              for (const pubHex of pubkeys) {
                if (!pubHex || pubHex.length !== 66) continue;
                const senderPubkey = Uint8Array.from(Buffer.from(pubHex, 'hex'));

                // Derive what payment address a sender with this pubkey would have sent to
                const secret = computeSharedSecret(
                  rpaKeys.scanPrivkey,
                  senderPubkey,
                  input.prevout_hash,
                  input.prevout_n,
                );
                const expectedAddr = derivePaymentAddress(rpaKeys.spendPubkey, secret, network, 0);

                // Check if any output matches
                const matchingOutputs = (tx.outputs ?? []).filter(o => o.address === expectedAddr);
                if (matchingOutputs.length > 0) {
                  const sats = matchingOutputs.reduce((sum, o) => sum + (o.value ?? 0), 0);

                  // Verify this UTXO is unspent
                  const utxos = await adapter.request('blockchain.address.listunspent', expectedAddr) as UtxoEntry[];
                  const matchingUtxos = utxos.filter(u => u.tx_hash === tx_hash);
                  if (matchingUtxos.length > 0) {
                    totalSats += matchingUtxos.reduce((s, u) => s + u.value, 0);
                  } else {
                    totalSats += sats; // already-spent output still counted in history
                  }
                  confirmedMatches++;
                }
              }
            }
          } catch {
            // Skip unresolvable txs — don't block the whole scan
          }
        }),
      );

      setStealthSats(totalSats);
      setMatchCount(confirmedMatches);
      setLastSynced(new Date().toLocaleTimeString());
    } catch (err) {
      setSyncError(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  }, [walletId, network, syncing]);

  if (!rpaEnabled) return null;

  const stealthBch = stealthSats / SATSINBITCOIN;

  return (
    <div className="rounded-xl border border-[var(--wallet-accent)]/20 bg-[var(--wallet-surface)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold wallet-text-strong">Stealth BCH</span>
            <span className="rounded-full border border-[var(--wallet-accent)]/30 bg-[var(--wallet-accent)]/10 px-1.5 py-0.5 text-[9px] font-bold text-[var(--wallet-accent)] uppercase tracking-wide">
              RPA
            </span>
          </div>
          <div className="text-xl font-bold wallet-text-strong mt-0.5">
            {stealthBch.toFixed(8)} BCH
          </div>
          {matchCount !== null && (
            <div className="text-xs wallet-muted mt-0.5">
              {matchCount} confirmed stealth payment{matchCount !== 1 ? 's' : ''} found
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => void handleSync()}
          disabled={syncing}
          className="rounded-xl border border-[var(--wallet-accent)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--wallet-accent)] disabled:opacity-50 hover:bg-[var(--wallet-accent)]/5 transition-colors"
        >
          {syncing ? 'Scanning…' : 'Sync'}
        </button>
      </div>

      {syncError && <p className="text-xs text-red-400">{syncError}</p>}

      {serverNote && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
          <p className="text-[10px] text-yellow-300 leading-relaxed">{serverNote}</p>
        </div>
      )}

      {lastSynced && !syncError && (
        <p className="text-[10px] wallet-muted">Last scanned: {lastSynced}</p>
      )}

      <p className="text-[10px] wallet-muted leading-relaxed">
        Scans a Fulcrum-RPA server for transactions whose input signature prefix
        matches your scan key. Uses ECDH to verify each candidate and detect your stealth outputs.
      </p>
    </div>
  );
};
