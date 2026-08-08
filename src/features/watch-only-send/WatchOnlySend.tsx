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

import { cashAddressToLockingBytecode, hexToBin } from '@bitauth/libauth';
import { QRCodeSVG } from 'qrcode.react';

import WalletScreen from '../../components/ui/WalletScreen';
import { selectWalletId } from '../../state/slices/walletSlice';
import type { RootState } from '../../state/store';
import type { UTXO } from '../../types/types';
import { coinDepth } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import { outpointKey } from '../../platform/desktop/CoinLabelService';
import { FusionBadge } from '../../components/FusionBadge';
import KeyService from '../../services/KeyService';
import UTXOService from '../../services/UTXOService';
import TransactionService from '../../services/TransactionService';
import WalletManager from '../../apis/WalletManager/WalletManager';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';
import {
  buildNftCardModels,
  summarizeNftInstances,
  type NftCardMetadata,
  type NftCardModel,
} from '../../pages/assetsTokenInventory';
import { resolveParyonNftParseInfo } from '../../services/paryon/nftRegistry';
import type { NftParseInfo } from '../../services/nftParsing/nftParsing';

import {
  buildWatchOnlyPsbt,
  type WatchOnlyInputSpec,
  type WatchOnlyProposal,
} from '../../services/psbt/watchOnlySend';
import { getBchAccountPath } from '../../services/HdWalletService';
import { inspectImportedPsbt } from '../../services/psbt/watchOnlyImport';
import { fetchParentTransactions } from '../../services/psbt/parentTransactions';
import {
  deriveMultisigAddress,
  type MultisigPolicy,
} from '../../services/psbt/multisigWallet';
import { watchOnlyMultisigPolicy } from '../../platform/desktop/onboarding/watchOnlyWallet';
import { decodePsbt } from '../../services/psbt/psbtBch';
import {
  cosignerStatuses,
  mergePsbts,
  parseMultisigRedeemScript,
  type CosignerStatus,
} from '../../services/psbt/psbtMultisig';
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

const SEND_STEPS = ['Prepare', 'Sign', 'Broadcast'] as const;

/**
 * Where the user is in the air-gapped round trip.
 *
 * Sending here is a sequence — build, carry to the device, carry back, send —
 * and showing all of it at once made a wall of controls out of what is really
 * three short stages. The current stage is derived from the transaction's own
 * state rather than tracked separately, so the indicator cannot disagree with
 * what the screen is actually doing.
 */
const StepBar: FC<{ current: 1 | 2 | 3 }> = ({ current }) => (
  <ol className="flex items-center gap-1.5" aria-label="Progress">
    {SEND_STEPS.map((label, index) => {
      const position = index + 1;
      const done = position < current;
      const active = position === current;
      return (
        <li key={label} className="flex flex-1 items-center gap-1.5">
          <span
            aria-current={active ? 'step' : undefined}
            className={`flex-1 rounded-md px-2 py-1 text-center text-[11px] font-semibold ${
              active
                ? 'bg-[var(--wallet-accent)] text-black'
                : done
                  ? 'border border-emerald-500/40 text-emerald-400'
                  : 'border border-[var(--wallet-border)] wallet-muted'
            }`}
          >
            {done ? '✓ ' : ''}
            {label}
          </span>
        </li>
      );
    })}
  </ol>
);

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
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const fusionDepthRev = useFusionDepthRevision(walletId || 0);

  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState<bigint | null>(null);
  const [amountText, setAmountText] = useState('');
  const [changeAddress, setChangeAddress] = useState('');
  const [changeAddressIndex, setChangeAddressIndex] = useState(0);
  const [inputs, setInputs] = useState<SpendableInput[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fingerprint, setFingerprint] = useState('');
  const [savedFingerprint, setSavedFingerprint] = useState('');
  const [accountPath, setAccountPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [multisigPolicy, setMultisigPolicy] = useState<MultisigPolicy | null>(
    null
  );
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const [proposalState, setProposalState] = useState<ProposalState | null>(null);

  const [frames, setFrames] = useState<ReturnType<typeof encodePsbtToUrFrames> | null>(null);
  const [qrUri, setQrUri] = useState('');

  const [importText, setImportText] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  /**
   * The accumulated PSBT: the base proposal merged with every verified return
   * from the signer. Multisig flows walk it around the room until each input
   * has its required signatures.
   */
  const [mergedPsbt, setMergedPsbt] = useState<Uint8Array | null>(null);
  /** Which PSBTs from the last import failed to merge, and why. */
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const verdict = useMemo<ReturnType<typeof inspectImportedPsbt> | null>(() => {
    if (!mergedPsbt || !proposalState) return null;
    return inspectImportedPsbt(mergedPsbt, proposalState.proposal);
  }, [mergedPsbt, proposalState]);
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

  const nftCategories = useMemo(() => {
    const categories = new Set<string>();
    for (const input of inputs) {
      const category = input.utxo.token?.category;
      if (input.utxo.token?.nft && category) categories.add(category);
    }
    return Array.from(categories);
  }, [inputs]);

  const tokenMetadata = useSharedTokenMetadata(nftCategories);

  const nftCardsByOutpoint = useMemo(() => {
    const instances = summarizeNftInstances(inputs.map((input) => input.utxo));
    if (instances.length === 0) return new Map<string, NftCardModel>();

    const metadataByCategory: Record<string, NftCardMetadata> = {};
    for (const instance of instances) {
      const metadata = tokenMetadata[instance.category];
      if (metadata && !metadataByCategory[instance.category]) {
        metadataByCategory[instance.category] = {
          symbol: metadata.symbol ?? '',
          nfts: metadata.snapshot?.token?.nfts,
        };
      }
    }

    const familyParseInfoByCategory: Record<string, NftParseInfo> = {};
    for (const instance of instances) {
      if (metadataByCategory[instance.category]?.nfts) continue;
      const info = resolveParyonNftParseInfo(currentNetwork, instance.category);
      if (info) familyParseInfoByCategory[instance.category] = info;
    }

    return new Map(
      buildNftCardModels(
        instances,
        metadataByCategory,
        familyParseInfoByCategory
      ).map((card) => [card.outpoint, card])
    );
  }, [inputs, tokenMetadata, currentNetwork]);

  /**
   * Per-input cosigner signature status, read entirely from the accumulated
   * PSBT's public material. Empty when the flow is single-signer.
   */
  const cosignerStatus = useMemo<CosignerStatus[][]>(() => {
    if (!mergedPsbt) return [];
    try {
      return cosignerStatuses(decodePsbt(mergedPsbt));
    } catch {
      return [];
    }
  }, [mergedPsbt]);

  /** Multisig inputs of the proposal (index, required-of-total, keys). */
  const multisigInputs = useMemo(() => {
    if (!proposalState) return [];
    const summaries: {
      index: number;
      required: number;
      total: number;
    }[] = [];
    for (const [index, input] of proposalState.proposal.inputs.entries()) {
      if (!input.redeemScriptHex) continue;
      const policy = parseMultisigRedeemScript(hexToBin(input.redeemScriptHex));
      if (!policy) continue;
      summaries.push({
        index,
        required: input.requiredSignatures ?? policy.requiredSignatures,
        total: policy.totalSignatures,
      });
    }
    return summaries;
  }, [proposalState]);

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
        setAccountPath(
          metadata?.derivation_path ?? getBchAccountPath(currentNetwork)
        );

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

        // A multisig wallet's coins are not owned by any single key, so its
        // inputs need the redeem script, the threshold and every cosigner's
        // derivation — without them the PSBT describes a P2PKH spend of a P2SH
        // coin and no device can sign it. The script is re-derived from the
        // stored policy rather than read back from the keys table, so it can
        // never disagree with the address it unlocks.
        const policy = await watchOnlyMultisigPolicy(currentWalletId);
        if (cancelled) return;
        setMultisigPolicy(policy);

        const spendable: SpendableInput[] = [];
        for (const utxo of utxoResult.allUtxos) {
          const key = keyByAddress.get(utxo.address);
          if (!key) continue;
          const script = cashAddressToLockingBytecode(utxo.address);
          if (typeof script === 'string') continue;
          const branchIndex = key.changeIndex === 1 ? 1 : 0;

          if (policy) {
            const derived = deriveMultisigAddress(
              policy,
              branchIndex,
              key.addressIndex
            );
            spendable.push({
              txid: utxo.tx_hash,
              vout: utxo.tx_pos,
              satoshis: BigInt(utxo.amount ?? 0),
              lockingBytecodeHex: toHex(Uint8Array.from(script.bytecode)),
              // No single key owns this coin; the first sorted cosigner key is
              // only a placeholder for display. Spending uses the derivations.
              publicKeyHex: toHex(derived.sortedPublicKeys[0]),
              branchIndex,
              addressIndex: key.addressIndex,
              redeemScriptHex: toHex(derived.redeemScript),
              requiredSignatures: policy.m,
              cosignerDerivations: policy.signers.map((signer, index) => ({
                publicKeyHex: toHex(derived.sortedPublicKeys[index]),
                // Zeros where a cosigner has not supplied one: the signature
                // comes from the path, and a wrong-looking fingerprint only
                // costs that device its "these coins are mine" review line.
                masterFingerprintHex: signer.masterFingerprintHex ?? '00000000',
                derivationPath: `${
                  signer.accountPath ?? getBchAccountPath(currentNetwork)
                }/${branchIndex}/${key.addressIndex}`,
              })),
              utxo,
            });
            continue;
          }

          if (!key.publicKey || key.publicKey.length === 0) continue;
          spendable.push({
            txid: utxo.tx_hash,
            vout: utxo.tx_pos,
            satoshis: BigInt(utxo.amount ?? 0),
            lockingBytecodeHex: toHex(Uint8Array.from(script.bytecode)),
            publicKeyHex: toHex(key.publicKey),
            branchIndex,
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
        if (keysForChange[0]) {
          setChangeAddress(keysForChange[0].address);
          // Kept because multisig change has to be rebuilt from the policy at
          // this exact index, and the address string alone cannot say which.
          setChangeAddressIndex(keysForChange[0].addressIndex);
        }
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
  }, [currentWalletId, currentNetwork]);

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
      setAmountSats(BigInt(Math.round(parsed * 1e8)));
    } else {
      setAmountSats(null);
    }
  };

  const handleBuild = async () => {
    setError('');
    setProposalState(null);
    setFrames(null);
    setMergedPsbt(null);
    setImportErrors([]);
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
      // The signer needs the whole parent transaction per input, so this is a
      // network round trip before anything can be shown.
      setBusy(true);
      const parents = await fetchParentTransactions(
        selectedInputs.map((input) => input.txid)
      );
      const inputsWithParents = selectedInputs.map((input) => ({
        ...input,
        previousTransactionHex: parents.get(input.txid),
      }));

      // Multisig change must go back to the same P2SH policy. Sending it to a
      // plain address derived from one cosigner's key would put the change
      // beyond the threshold — spendable by that cosigner alone, and invisible
      // to the others' wallets.
      const changeBranch = 1 as const;
      const changeMultisig = multisigPolicy
        ? deriveMultisigAddress(multisigPolicy, changeBranch, changeAddressIndex)
        : null;

      const result = buildWatchOnlyPsbt({
        inputs: inputsWithParents,
        recipient: recipient.trim(),
        amountSats,
        changeAddress,
        accountPath,
        masterFingerprint: fingerprint ? masterFingerprintBytes(fingerprint) : null,
        ...(changeMultisig && multisigPolicy
          ? {
              changeRedeemScriptHex: toHex(changeMultisig.redeemScript),
              changeDerivations: multisigPolicy.signers.map(
                (signer, index) => ({
                  publicKeyHex: toHex(changeMultisig.sortedPublicKeys[index]),
                  masterFingerprintHex:
                    signer.masterFingerprintHex ?? '00000000',
                  derivationPath: `${
                    signer.accountPath ?? getBchAccountPath(currentNetwork)
                  }/${changeBranch}/${changeAddressIndex}`,
                })
              ),
            }
          : {}),
      });
      const normalizedFingerprint = fingerprint.trim().toLowerCase();
      // Only ever write a real value. Now that the field is optional, a blank
      // one means "not supplied this time", not "forget the one I gave you" —
      // persisting the empty string would wipe a fingerprint the user already
      // read off the device and make the next send silently unrecognised.
      if (
        currentWalletId &&
        normalizedFingerprint &&
        normalizedFingerprint !== savedFingerprint
      ) {
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
        inputs: inputsWithParents,
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
    } finally {
      setBusy(false);
    }
  };

  /**
   * Merge one returned PSBT into the accumulated one. The merge binds the
   * return to the approved unsigned transaction, verifies every signature it
   * carries, and imports only what is valid — so repeated trips (2-of-3
   * signing across multiple devices, or the same device more than once) keep
   * building toward the threshold. A return that conflicts with the approved
   * transaction is refused and reported, never silently replacing it.
   */
  const importAndMerge = (psbt: Uint8Array) => {
    setBroadcastTxid('');
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    try {
      const base = mergedPsbt ?? proposalState.psbtBytes;
      const outcome = mergePsbts([base, psbt]);
      if (outcome.results.some((result) => result.combined)) {
        setMergedPsbt(outcome.merged);
        setImportErrors(
          outcome.results
            .filter((result) => !result.combined)
            .map((result) => `PSBT ${result.index}: ${result.error}`)
        );
      } else {
        setImportErrors(
          outcome.results.map(
            (result) => `PSBT ${result.index}: ${result.error}`
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not merge the signed transaction.');
    }
  };

  const handleImportText = () => {
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
      importAndMerge(psbt);
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
        importAndMerge(progress.psbt);
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

  const step: 1 | 2 | 3 = broadcastTxid ? 3 : proposalState ? 2 : 1;

  /**
   * Return to editing. Any signature already collected was made over the exact
   * transaction being discarded, so it cannot carry over — the button says so
   * rather than silently dropping it.
   */
  const handleEditProposal = () => {
    setProposalState(null);
    setFrames(null);
    setQrUri('');
    setMergedPsbt(null);
    setImportErrors([]);
    setImportText('');
    setBroadcastTxid('');
    setError('');
  };

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

        <StepBar current={step} />

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          {busy ? (
            <p className="text-sm wallet-muted">Loading coins…</p>
          ) : (
            <>
              {/* Once built, the form and coin list step aside for a summary of
                  what is being signed — the user's attention belongs on the QR
                  and the device, not on controls that no longer apply. */}
              {step > 1 && proposalState && (
                <section className="wallet-card space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-semibold wallet-text-strong">
                        Sending {amountText || '0'} BCH
                      </p>
                      <p className="break-all text-[11px] wallet-muted">
                        to {recipient}
                      </p>
                      <p className="text-[11px] wallet-muted">
                        {selectedInputs.length} coin
                        {selectedInputs.length === 1 ? '' : 's'} · fee{' '}
                        {satsToBch(proposalState.feeSats)} BCH · change{' '}
                        {satsToBch(proposalState.changeSats)} BCH
                      </p>
                    </div>
                    {!broadcastTxid && (
                      <button
                        type="button"
                        onClick={handleEditProposal}
                        className="wallet-btn-secondary shrink-0 px-3 py-1.5 text-xs"
                      >
                        {mergedPsbt ? 'Edit — discards signatures' : 'Edit'}
                      </button>
                    )}
                  </div>
                </section>
              )}

              {/* Step 1: coin control */}
              <section
                className={`wallet-card space-y-2 p-4 ${step === 1 ? '' : 'hidden'}`}
              >
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
                              {walletId > 0 && (
                                <FusionBadge
                                  depth={(() => {
                                    void fusionDepthRev;
                                    return coinDepth(
                                      walletId,
                                      outpointKey(input.txid, input.vout)
                                    );
                                  })()}
                                  className="ml-1.5"
                                />
                              )}
                            </span>
                            {(() => {
                              const card = nftCardsByOutpoint.get(key);
                              if (!card) return null;
                              return (
                                <span className="mt-1 block rounded border border-[var(--wallet-border)] bg-black/20 px-1.5 py-1">
                                  <span className="block truncate text-[11px] font-semibold wallet-text-strong">
                                    {card.primaryLabel}
                                  </span>
                                  {card.fields.length > 0 ? (
                                    <span className="block truncate text-[10px] wallet-muted">
                                      {card.fields
                                        .slice(0, 3)
                                        .map(
                                          (field) =>
                                            `${field.name ?? field.fieldId ?? 'field'}: ${
                                              field.parsedValue?.formatted ??
                                              field.value
                                            }`
                                        )
                                        .join(' · ')}
                                    </span>
                                  ) : null}
                                </span>
                              );
                            })()}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Step 2: destination + amount */}
              <section
                className={`wallet-card space-y-3 p-4 ${step === 1 ? '' : 'hidden'}`}
              >
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
                {/* Set once per wallet and remembered, so it stays out of the
                    way of every later send. */}
                <details className="text-xs">
                  <summary className="cursor-pointer wallet-muted">
                    Signer options
                    {!fingerprint && ' — no master fingerprint set'}
                  </summary>
                  <label className="mt-2 block space-y-1 text-sm wallet-text-strong">
                    Master fingerprint{' '}
                    <span className="text-[11px] font-normal wallet-muted">
                      (optional)
                    </span>
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
                    <p className="mt-1 text-[11px] text-red-400">
                      Must be exactly 8 hex characters.
                    </p>
                  )}
                  <p className="mt-2 text-[11px] leading-relaxed wallet-muted">
                    SeedCash shows this on the same screen as Export Xpub. It
                    cannot be derived from the xPub, and it is not used to
                    produce the signature — it is what lets the device show
                    these coins as its own while you review the transaction.
                  </p>
                </details>
                {!fingerprint && (
                  <p className="text-[11px] leading-relaxed text-amber-400">
                    No master fingerprint set — SeedCash will still sign, but it
                    will not show these coins as yours while you review.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void handleBuild()}
                  disabled={!!fingerprint && !masterFingerprintBytes(fingerprint)}
                  className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                >
                  Build unsigned transaction
                </button>
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

              {/* Step 4: cosigner signatures (multisig only) */}
              {multisigInputs.length > 0 && cosignerStatus.length > 0 && (
                <section className="wallet-card space-y-2 p-4">
                  <p className="text-sm font-semibold wallet-text-strong">
                    Cosigner signatures
                  </p>
                  {multisigInputs.map((summary) => {
                    const statuses = cosignerStatus[summary.index] ?? [];
                    const signed = statuses.filter((status) => status.signed).length;
                    return (
                      <div key={summary.index} className="space-y-1.5">
                        <p className="text-xs wallet-muted">
                          Input {summary.index}: {signed} of {summary.required}{' '}
                          collected · policy {summary.required} of {summary.total}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {statuses.map((status) => (
                            <span
                              key={status.publicKeyHex}
                              className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                                status.signed
                                  ? 'border border-emerald-500/40 text-emerald-400'
                                  : 'border border-[var(--wallet-border)] wallet-muted'
                              }`}
                            >
                              {status.signed ? '✓' : '○'}{' '}
                              {status.fingerprintHex.slice(0, 8).toUpperCase()}{' '}
                              {status.derivationPath}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {importErrors.length > 0 && (
                    <ul className="space-y-1 text-[11px] text-red-400">
                      {importErrors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* Step 5: verification verdict */}
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
