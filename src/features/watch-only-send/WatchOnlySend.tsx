// Watch-only send workspace: coin control -> unsigned PSBT -> animated QR ->
// import signed PSBT -> verify -> broadcast.
//
// This is the air-gapped half of the flow. Nothing here signs: the wallet
// carries public keys only, the signer is a different device (SeedCash) that
// never sees this machine's network. Every signature that comes back is
// verified locally before the transaction is broadcast, and a transaction that
// does not byte-for-byte match the approved one is never broadcast.

import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { cashAddressToLockingBytecode } from '@bitauth/libauth';
import { QRCodeSVG } from 'qrcode.react';

import WalletScreen from '../../components/ui/WalletScreen';
import { selectWalletId } from '../../state/slices/walletSlice';
import type { UTXO } from '../../types/types';
import KeyService from '../../services/KeyService';
import UTXOService from '../../services/UTXOService';
import TransactionService from '../../services/TransactionService';
import WalletManager from '../../apis/WalletManager/WalletManager';

import {
  buildWatchOnlyPsbt,
  type WatchOnlyInputSpec,
  type WatchOnlyProposal,
} from '../../services/psbt/watchOnlySend';
import { inspectImportedPsbt } from '../../services/psbt/watchOnlyImport';
import {
  encodePsbtToUrFrames,
  UrPsbtScanner,
} from '../../services/psbt/urPsbt';
import {
  masterFingerprintBytes,
  saveWatchOnlyMasterFingerprint,
  watchOnlyMasterFingerprint,
} from '../../platform/desktop/onboarding/watchOnlyWallet';
import { CameraQrScanner } from '../../platform/desktop/CameraQrScanner';

type WatchOnlySendLocationState = {
  returnTo?: string;
  recipient?: string;
  amountBch?: string;
};

type KeyRow = {
  address: string;
  publicKey: Uint8Array;
  changeIndex: number;
  addressIndex: number;
};

/** UTXO enriched with everything the PSBT builder needs. */
type SpendableInput = WatchOnlyInputSpec & {
  utxo: UTXO;
};

const FRAME_INTERVAL_MS = 800;

const satsToBch = (sats: bigint): string => {
  const bch = Number(sats) / 1e8;
  return bch.toLocaleString('en-US', { maximumFractionDigits: 8 });
};

const shortTxid = (txid: string): string =>
  txid.length > 18 ? `${txid.slice(0, 8)}…${txid.slice(-8)}` : txid;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

type ProposalState = {
  psbtBytes: Uint8Array;
  proposal: WatchOnlyProposal;
  feeSats: bigint;
  changeSats: bigint;
  inputSumSats: bigint;
};

export const WatchOnlySend: FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const walletId = useSelector(selectWalletId);

  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState<bigint | null>(null);
  const [amountText, setAmountText] = useState('');
  const [changeAddress, setChangeAddress] = useState('');
  const [inputs, setInputs] = useState<SpendableInput[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fingerprint, setFingerprint] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [accountPath, setAccountPath] = useState("m/44'/145'/0'");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const [proposalState, setProposalState] = useState<ProposalState | null>(null);

  const [frames, setFrames] = useState<ReturnType<typeof encodePsbtToUrFrames> | null>(null);
  const [qrUri, setQrUri] = useState('');

  const [importText, setImportText] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [verdict, setVerdict] = useState<ReturnType<typeof inspectImportedPsbt> | null>(null);
  const [broadcastTxid, setBroadcastTxid] = useState('');

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameIndexRef = useRef(0);
  const frameCountRef = useRef(0);

  const locationState = useMemo<WatchOnlySendLocationState | null>(
    () => (location.state as WatchOnlySendLocationState | null) ?? null,
    [location.state]
  );

  const currentWalletId = useMemo(() => {
    if (walletId) return walletId;
    const fromReturnTo = locationState?.returnTo?.split('/').pop();
    return fromReturnTo ? Number(fromReturnTo) : null;
  }, [walletId, locationState]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError('');
      try {
        if (!currentWalletId) {
          setError('No wallet is open. Go back and open the watch-only wallet first.');
          return;
        }
        const metadata = await WalletManager().getWalletMetadata(currentWalletId);
        if (metadata?.derivation_path) setAccountPath(metadata.derivation_path);

        const stored = await watchOnlyMasterFingerprint(currentWalletId);
        if (stored) {
          setFingerprint(stored);
          setSavedFingerprint(stored);
        }

        const [utxoResult, keys] = await Promise.all([
          UTXOService.fetchAllWalletUtxos(currentWalletId),
          KeyService.retrieveKeys(currentWalletId),
        ]);
        const keyByAddress = new Map<string, KeyRow>();
        for (const key of keys as KeyRow[]) {
          if (key?.address && !keyByAddress.has(key.address)) {
            keyByAddress.set(key.address, key);
          }
        }

        const spendable: SpendableInput[] = [];
        for (const utxo of utxoResult.allUtxos) {
          const key = keyByAddress.get(utxo.address);
          if (!key || !key.publicKey || key.publicKey.length === 0) continue;
          const script = cashAddressToLockingBytecode(utxo.address);
          if (typeof script === 'string') continue;
          spendable.push({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: BigInt(utxo.amount ?? 0),
            lockingBytecodeHex: toHex(Uint8Array.from(script.bytecode)),
            publicKeyHex: toHex(key.publicKey),
            branchIndex: key.changeIndex === 1 ? 1 : 0,
            addressIndex: key.addressIndex,
            utxo,
          });
        }
        spendable.sort((a, b) => Number(a.satoshis - b.satoshis));
        if (cancelled) return;
        setInputs(spendable);

        const keysForChange = Array.from(keyByAddress.values()).filter(
          (key) => key.changeIndex === 1
        );
        if (keysForChange[0]) setChangeAddress(keysForChange[0].address);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load the wallet coins.');
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentWalletId]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Drive the animated QR: advance one frame on every tick, always.
  useEffect(() => {
    if (!frames) return;
    if (!timerRef.current) {
      timerRef.current = setInterval(() => {
        frameIndexRef.current += 1;
        setQrUri(frames.next());
      }, FRAME_INTERVAL_MS);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [frames]);

  const selectedInputs = useMemo(
    () => inputs.filter((input) => selected.has(`${input.txid}:${input.vout}`)),
    [inputs, selected]
  );

  const totalSelectedSats = useMemo(
    () => selectedInputs.reduce((sum, input) => sum + input.satoshis, 0n),
    [selectedInputs]
  );

  const toggleInput = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAmountChange = (text: string) => {
    setAmountText(text);
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed > 0) {
      setAmountSats(BigInt(Math.floor(parsed * 1e8)));
    } else {
      setAmountSats(null);
    }
  };

  const handleBuild = () => {
    setError('');
    setProposalState(null);
    setFrames(null);
    setVerdict(null);
    setBroadcastTxid('');
    if (selectedInputs.length === 0) {
      setError('Select at least one coin (coin control).');
      return;
    }
    if (!recipient.trim()) {
      setError('Enter the destination address.');
      return;
    }
    if (amountSats === null || amountSats <= 0n) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (!changeAddress) {
      setError('No change address available. Add more change addresses to the wallet.');
      return;
    }
    try {
      const result = buildWatchOnlyPsbt({
        inputs: selectedInputs,
        recipient: recipient.trim(),
        amountSats,
        changeAddress,
        accountPath,
        masterFingerprint: fingerprint ? masterFingerprintBytes(fingerprint) : null,
      });
      const normalizedFingerprint = fingerprint.trim().toLowerCase();
      if (currentWalletId && normalizedFingerprint !== savedFingerprint) {
        // The fingerprint lives on the signer, so it is commonly typed in for
        // the first time here. Persist it so the next send does not ask again.
        void saveWatchOnlyMasterFingerprint(currentWalletId, normalizedFingerprint)
          .then(() => setSavedFingerprint(normalizedFingerprint))
          .catch((err) => {
            // Non-fatal: the unsigned transaction is still valid without it.
            console.error('Could not persist master fingerprint', err);
          });
      }
      const proposal: WatchOnlyProposal = {
        rawUnsignedHex: result.rawUnsignedHex,
        inputs: selectedInputs,
        outputs: result.outputs,
      };
      setProposalState({
        psbtBytes: result.psbtBytes,
        proposal,
        feeSats: result.feeSats,
        changeSats: result.changeSats,
        inputSumSats: result.inputSumSats,
      });
      const frameSource = encodePsbtToUrFrames(result.psbtBytes);
      frameIndexRef.current = 0;
      frameCountRef.current = frameSource.count;
      setFrames(frameSource);
      setQrUri(frameSource.next());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not build the unsigned transaction.');
    }
  };

  const handleImportText = () => {
    setVerdict(null);
    setBroadcastTxid('');
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    try {
      const scanner = new UrPsbtScanner();
      let psbt: Uint8Array | null = null;
      for (const line of importText.split(/[\s,;]+/)) {
        if (!line.trim()) continue;
        const progress = scanner.receive(line.trim());
        if (progress.complete && progress.psbt) {
          psbt = progress.psbt;
          break;
        }
      }
      if (!psbt) {
        setError(
          'Not enough frames scanned. Scan every frame of the signer screen (it loops).'
        );
        return;
      }
      setVerdict(inspectImportedPsbt(psbt, proposalState.proposal));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the signed transaction.');
    }
  };

  const handleScanFrame = (text: string) => {
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    try {
      const scanner = new UrPsbtScanner();
      const progress = scanner.receive(text);
      if (progress.complete && progress.psbt) {
        setVerdict(inspectImportedPsbt(progress.psbt, proposalState.proposal));
        setScannerOpen(false);
      } else {
        setImportText((prev) => (prev ? `${prev}\n` : '') + text.trim());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the signed transaction.');
    }
  };

  const handleBroadcast = async () => {
    if (!proposalState || !verdict || verdict.state !== 'complete' || !verdict.rawTxHex) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await TransactionService.sendTransaction(
        verdict.rawTxHex,
        proposalState.proposal.inputs.map((input) => (input as SpendableInput).utxo),
        {
          source: 'watch-only',
          sourceLabel: 'Watch-only send (air-gapped)',
          recipientSummary: recipient.trim(),
          amountSummary: satsToBch(amountSats ?? 0n),
        }
      );
      if (res.errorMessage) {
        setError(res.errorMessage);
        return;
      }
      setBroadcastTxid(res.txid ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Broadcast failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleBack = () => {
    navigate(locationState?.returnTo ?? '/home');
  };

  const frameNumber = (frameIndexRef.current % frameCountRef.current) + 1;

  return (
    <WalletScreen maxWidthClassName="max-w-md" scrollable={false}>
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleBack}
            className="wallet-btn-secondary px-3 py-1.5 text-sm"
          >
            Back
          </button>
          <h1 className="text-lg font-bold wallet-text-strong">Watch-only Send</h1>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          {busy ? (
            <p className="text-sm wallet-muted">Loading coins…</p>
          ) : (
            <>
              {/* Step 1: coin control */}
              <section className="wallet-card space-y-2 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold wallet-text-strong">
                    Coins to spend
                  </p>
                  <span className="text-xs wallet-muted">
                    {satsToBch(totalSelectedSats)} BCH selected
                  </span>
                </div>
                {inputs.length === 0 ? (
                  <p className="text-xs wallet-muted">
                    No spendable BCH coins found. Sync the wallet and make sure
                    it holds BCH (not only tokens).
                  </p>
                ) : (
                  <div className="max-h-64 space-y-1.5 overflow-y-auto">
                    {inputs.map((input) => {
                      const key = `${input.txid}:${input.vout}`;
                      const checked = selected.has(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--wallet-border)] px-2.5 py-2 text-xs"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleInput(key)}
                            className="accent-[var(--wallet-accent)]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono wallet-text-strong">
                              {shortTxid(input.txid)}:{input.vout}
                            </span>
                            <span className="block wallet-muted">
                              {satsToBch(input.satoshis)} BCH ·{' '}
                              {input.branchIndex === 1 ? 'change' : 'receive'}#
                              {input.addressIndex}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Step 2: destination + amount */}
              <section className="wallet-card space-y-3 p-4">
                <label className="block space-y-1 text-sm wallet-text-strong">
                  Destination (cashaddr)
                  <input
                    value={recipient}
                    onChange={(event) => setRecipient(event.target.value)}
                    placeholder="bitcoincash:q… or bchtest:q…"
                    autoComplete="off"
                    spellCheck={false}
                    className="wallet-input w-full rounded-md px-3 py-2 font-mono text-xs"
                  />
                </label>
                <label className="block space-y-1 text-sm wallet-text-strong">
                  Amount (BCH)
                  <input
                    value={amountText}
                    onChange={(event) => handleAmountChange(event.target.value)}
                    placeholder="0.001"
                    inputMode="decimal"
                    autoComplete="off"
                    className="wallet-input w-full rounded-md px-3 py-2"
                  />
                </label>
                <div className="flex items-center justify-between text-xs wallet-muted">
                  <span>
                    Change → {changeAddress ? shortTxid(changeAddress) : '…'}
                  </span>
                  {proposalState && (
                    <span>Fee {satsToBch(proposalState.feeSats)} BCH</span>
                  )}
                </div>
                <label className="block space-y-1 text-sm wallet-text-strong">
                  Master fingerprint (from the signer)
                  <input
                    value={fingerprint}
                    onChange={(event) => {
                      setFingerprint(event.target.value);
                      setError('');
                    }}
                    placeholder="8 hex chars, e.g. 4c9a1f7b"
                    maxLength={8}
                    autoComplete="off"
                    spellCheck={false}
                    className="wallet-input w-full rounded-md px-3 py-2 font-mono text-sm uppercase"
                  />
                </label>
                {fingerprint && !masterFingerprintBytes(fingerprint) && (
                  <p className="text-[11px] text-red-400">
                    Must be exactly 8 hex characters.
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleBuild}
                  disabled={!fingerprint || !masterFingerprintBytes(fingerprint)}
                  className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                >
                  Build unsigned transaction
                </button>
                <p className="text-[11px] leading-relaxed wallet-muted">
                  The fingerprint is printed on the signer under the account
                  xPub. It tells the signer which account may sign; without it
                  the device refuses the inputs.
                </p>
              </section>

              {/* Step 3: animated QR export */}
              {proposalState && frames && (
                <section className="wallet-card space-y-3 p-4">
                  <p className="text-sm font-semibold wallet-text-strong">
                    Scan this with SeedCash (air-gapped)
                  </p>
                  <div className="flex items-center justify-center rounded-md bg-white p-3">
                    <QRCodeSVG value={qrUri} size={220} includeMargin />
                  </div>
                  <p className="text-center text-xs wallet-muted">
                    Frame {frameNumber} / {frameCountRef.current} · hold the
                    camera steady, the code loops
                  </p>
                  <button
                    type="button"
                    onClick={() => setScannerOpen(true)}
                    className="wallet-btn-secondary w-full py-2 text-sm"
                  >
                    Scan the signed result
                  </button>
                  <details className="text-xs">
                    <summary className="cursor-pointer wallet-muted">
                      Or paste the UR text
                    </summary>
                    <textarea
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                      rows={4}
                      spellCheck={false}
                      placeholder="ur:crypto-psbt/… frames from the signer (one per line)"
                      className="wallet-input mt-2 w-full resize-none rounded-md px-3 py-2 font-mono text-[10px]"
                    />
                    <button
                      type="button"
                      onClick={handleImportText}
                      className="wallet-btn-secondary mt-2 w-full py-1.5 text-xs"
                    >
                      Verify pasted result
                    </button>
                  </details>
                  {scannerOpen && (
                    <CameraQrScanner
                      onResult={handleScanFrame}
                      onClose={() => setScannerOpen(false)}
                    />
                  )}
                </section>
              )}

              {/* Step 4: verification verdict */}
              {verdict && (
                <section
                  className={`wallet-card space-y-2 p-4 ${
                    verdict.state === 'complete'
                      ? 'border-emerald-500/50'
                      : verdict.state === 'rejected' || verdict.state === 'invalid'
                        ? 'border-red-500/50'
                        : ''
                  }`}
                >
                  <p className="text-sm font-semibold wallet-text-strong">
                    Signed transaction check
                  </p>
                  <p className="text-xs leading-relaxed wallet-muted">
                    {verdict.reason}
                  </p>
                  {verdict.state === 'complete' && verdict.rawTxHex && (
                    <>
                      <p className="break-all font-mono text-[10px] wallet-muted">
                        {verdict.rawTxHex.slice(0, 64)}…
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleBroadcast()}
                        disabled={busy}
                        className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                      >
                        {busy ? 'Broadcasting…' : 'Broadcast'}
                      </button>
                    </>
                  )}
                  {broadcastTxid && (
                    <p className="text-xs text-emerald-400">
                      Broadcast ✓ {broadcastTxid.slice(0, 24)}…
                    </p>
                  )}
                </section>
              )}

              {error && (
                <p role="alert" className="text-xs text-red-400">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </WalletScreen>
  );
};

export default WatchOnlySend;
