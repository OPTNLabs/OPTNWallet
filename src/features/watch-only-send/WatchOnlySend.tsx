// Watch-only send workspace: coin control -> unsigned PSBT -> QR ->
// import signed PSBT -> verify -> broadcast.
//
// Desktop remains the air-gapped watch-only half of the flow. The isolated
// mobile multisig branch can also sign with the active standard wallet, but
// every signature still returns through the same local verification and merge
// boundary before broadcast.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FC,
} from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSelector } from 'react-redux';

import {
  binToHex,
  cashAddressToLockingBytecode,
  decodeTransaction,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';
import { QRCodeSVG } from 'qrcode.react';

import WalletScreen from '../../components/ui/WalletScreen';
import { selectWalletId } from '../../state/slices/walletSlice';
import type { RootState } from '../../state/store';
import type { UTXO } from '../../types/types';
import { useI18n } from '../../i18n/useI18n';
import { coinDepth } from '../../platform/desktop/fusionCoinDepth';
import { useFusionDepthRevision } from '../../platform/desktop/useFusionDepthRevision';
import { outpointKey } from '../../platform/desktop/CoinLabelService';
import { FusionBadge } from '../../components/FusionBadge';
import KeyService from '../../services/KeyService';
import UTXOService from '../../services/UTXOService';
import TransactionService, {
  releaseMultisigOutboundLocks,
  type BroadcastState,
} from '../../services/TransactionService';
import { txBytesFromHex } from '../../apis/TransactionManager/feePolicy';
import { refreshMultisigWalletUtxos } from '../../services/WalletUtxoRefreshService';
import { copyToClipboard } from '../../utils/clipboard';
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
  estimateFinalTransactionBytes,
  feeForTransactionBytes,
  multisigCosignerDerivations,
  type WatchOnlyBuildOutput,
  type WatchOnlyInputSpec,
  type WatchOnlyProposal,
} from '../../services/psbt/watchOnlySend';
import { getBchAccountPath } from '../../services/HdWalletService';
import {
  inspectImportedPsbt,
  mergeImportedSignatures,
} from '../../services/psbt/watchOnlyImport';
import { fetchParentTransactions } from '../../services/psbt/parentTransactions';
import {
  deriveMultisigAddress,
  createMultisigDescriptorSet,
  type MultisigPolicy,
} from '../../services/psbt/multisigWallet';
import { watchOnlyMultisigPolicy } from '../../services/watchOnlyWallet';
import {
  decodePsbt,
  SIGHASH_ALL_FORKID,
  type ParsedPsbt,
} from '../../services/psbt/psbtBch';
import {
  cosignerStatuses,
  formatBip32Path,
  mergePsbts,
  parseMultisigRedeemScript,
  type CosignerStatus,
} from '../../services/psbt/psbtMultisig';
import {
  DEFAULT_UR_FRAGMENT_LENGTH,
  encodePsbtToUrFrames,
  UR_FRAGMENT_LENGTH_OPTIONS,
  encodePsbtToQrDisplay,
  UrPsbtScanner,
  type UrFrames,
  PSBT_UR_QR_DISPLAY_SIZE,
  PSBT_UR_QR_ERROR_LEVEL,
  PSBT_UR_QR_MARGIN_MODULES,
} from '../../services/psbt/urPsbt';
import { parsePsbtBytes } from '../../services/psbt/watchOnlyUrEncode';
import {
  masterFingerprintBytes,
  watchOnlyMasterFingerprint,
} from '../../platform/desktop/onboarding/watchOnlyWallet';
import { CameraQrScanner } from '../../components/qr/CameraQrScanner';
import { getReturnPath } from '../../utils/navigation';
import { isDesktopPlatform } from '../../utils/platform';
import { QrScanDialog } from '../multisig/QrScanDialog';
import { loadMultisigPolicy } from '../../services/multisig/MultisigStorageService';
import {
  advanceMultisigSpendSession,
  createMultisigSpendSession,
  listMultisigSpendSessions,
  type MultisigSpendSession,
} from '../../services/multisig/MultisigSpendSessionService';
import { signMultisigPsbtLocally } from '../../services/multisig/MultisigSignerService';
import MultisigBroadcastReview from '../multisig/MultisigBroadcastReview';

type WatchOnlySendLocationState = {
  returnTo?: string;
  recipient?: string;
  amountBch?: string;
  multisigSpendMode?: MultisigSpendMode;
};

type MultisigSpendMode = 'resume' | 'new';

type WatchOnlySendProps = {
  mobile?: boolean;
  returnTo?: string;
  /** Route-scoped multisig ID; leaves the standard Redux wallet untouched. */
  walletIdOverride?: number;
  /** Keep the shared multisig navigation visually consistent with app flows. */
  backButtonVariant?: 'secondary' | 'danger';
  /** Use the isolated multisig confirmation surface for this coordinator. */
  presentation?: 'watch-only' | 'multisig';
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
const MAX_SIGNED_PSBT_FILE_BYTES = 5 * 1024 * 1024;

const SIGHASH_OPTIONS = [
  { value: 0x41, label: 'All (Recommended)' },
  { value: 0x42, label: 'None' },
  { value: 0x43, label: 'Single' },
  { value: 0xc1, label: 'All + Anyone Can Pay' },
  { value: 0xc2, label: 'None + Anyone Can Pay' },
  { value: 0xc3, label: 'Single + Anyone Can Pay' },
] as const;

const QR_DENSITY_LABELS: Record<
  (typeof UR_FRAGMENT_LENGTH_OPTIONS)[number],
  string
> = {
  50: 'Easiest to scan (more frames)',
  100: 'Balanced',
  200: 'High density (fewer frames)',
  400: 'Highest density (fewest frames)',
  450: 'Maximum density (fewest frames)',
};
const MULTISIG_FEE_RATE_SAT_PER_BYTE = 1;

const satsToBch = (sats: bigint): string => {
  const bch = Number(sats) / 1e8;
  return bch.toLocaleString('en-US', { maximumFractionDigits: 8 });
};

const shortTxid = (txid: string): string =>
  txid.length > 18 ? `${txid.slice(0, 8)}…${txid.slice(-8)}` : txid;

function validateBroadcastRelayFee(
  rawTxHex: string,
  inputSumSats: bigint,
  feeRateSatPerByte?: number
): void {
  const decoded = decodeTransaction(hexToBin(rawTxHex));
  if (typeof decoded === 'string') {
    throw new Error('The signed transaction could not be decoded locally.');
  }
  const outputSumSats = decoded.outputs.reduce(
    (sum, output) => sum + output.valueSatoshis,
    0n
  );
  const feePaid = inputSumSats - outputSumSats;
  const requiredFee = feeForTransactionBytes(
    txBytesFromHex(rawTxHex),
    feeRateSatPerByte
  );
  if (feePaid < requiredFee) {
    throw new Error(
      `The signed transaction fee is too low for BCH relay policy ` +
        `(${feePaid.toString()} sats paid; at least ${requiredFee.toString()} ` +
        'sats are required). Rebuild the spend to recalculate the multisig fee.'
    );
  }
}

const SEND_STEPS = [
  'Prepare',
  'Collect signatures',
  'Ready to broadcast',
] as const;

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
  <ol className="flex items-center gap-1.5" aria-label="Spend progress">
    {SEND_STEPS.map((label, index) => {
      const position = index + 1;
      const done = position < current;
      const active = position === current;
      return (
        <li key={label} className="min-w-0 flex-1">
          <span
            aria-current={active ? 'step' : undefined}
            className={`flex min-h-8 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-center text-[10px] font-semibold leading-tight ${
              active
                ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)]/10 text-[var(--wallet-accent-strong)]'
                : done
                  ? 'border-emerald-500/40 text-emerald-400'
                  : 'border-[var(--wallet-border)] wallet-muted'
            }`}
          >
            <span aria-hidden="true">{done ? '✓' : position}</span>
            <span className="truncate">{label}</span>
          </span>
        </li>
      );
    })}
  </ol>
);

function restoreProposalFromPsbt(
  parsed: ParsedPsbt,
  availableInputs: SpendableInput[],
  network: string
): {
  proposal: WatchOnlyProposal;
  feeSats: bigint;
  changeSats: bigint;
  inputSumSats: bigint;
  recipient: string;
  amountSats: bigint;
  changeAddress: string;
  changeAddressIndex: number;
} {
  const inputs: SpendableInput[] = parsed.inputs.map((input, inputIndex) => {
    if (!input.previousTxid || input.outpointIndex === null) {
      throw new Error(`Saved proposal input ${inputIndex} is incomplete.`);
    }
    const txid = binToHex(input.previousTxid);
    const available = availableInputs.find(
      (candidate) =>
        candidate.txid.toLowerCase() === txid.toLowerCase() &&
        candidate.vout === input.outpointIndex
    );
    if (!available) {
      throw new Error(
        `Saved proposal input ${inputIndex} is no longer in the multisig UTXO inventory.`
      );
    }
    if (!input.spentLockingBytecode || input.spentSatoshis === null) {
      throw new Error(
        `Saved proposal input ${inputIndex} is missing spent-output state.`
      );
    }
    const redeemScript = input.redeemScript
      ? toHex(input.redeemScript)
      : undefined;
    const scriptPolicy = input.redeemScript
      ? parseMultisigRedeemScript(input.redeemScript)
      : null;
    return {
      ...available,
      txid,
      vout: input.outpointIndex,
      satoshis: input.spentSatoshis,
      lockingBytecodeHex: toHex(input.spentLockingBytecode),
      publicKeyHex: input.derivations[0]
        ? toHex(input.derivations[0].publicKey)
        : available.publicKeyHex,
      redeemScriptHex: redeemScript,
      requiredSignatures: scriptPolicy?.requiredSignatures,
      cosignerDerivations: input.derivations.map((derivation) => ({
        publicKeyHex: toHex(derivation.publicKey),
        masterFingerprintHex: binToHex(derivation.masterFingerprint),
        derivationPath: formatBip32Path(derivation.derivationPath),
      })),
      previousTransactionHex: input.nonWitnessUtxo
        ? toHex(input.nonWitnessUtxo)
        : undefined,
      token: input.token ?? undefined,
    };
  });

  const outputs: WatchOnlyBuildOutput[] = parsed.outputs.map((output) => ({
    lockingBytecodeHex: toHex(output.lockingBytecode ?? new Uint8Array()),
    satoshis: output.satoshis ?? 0n,
    isChange: output.redeemScript !== null,
    token: output.token ?? undefined,
  }));
  const inputSumSats = inputs.reduce((sum, input) => sum + input.satoshis, 0n);
  const outputSumSats = outputs.reduce(
    (sum, output) => sum + output.satoshis,
    0n
  );
  const changeOutputs = outputs.filter((output) => output.isChange);
  const recipientOutputs = outputs.filter((output) => !output.isChange);
  const prefix = network === 'mainnet' ? 'bitcoincash' : 'bchtest';
  const addressFor = (output: WatchOnlyBuildOutput): string => {
    const encoded = lockingBytecodeToCashAddress({
      bytecode: hexToBin(output.lockingBytecodeHex),
      prefix,
    });
    return typeof encoded === 'string' ? '' : encoded.address;
  };
  const changeOutput = changeOutputs[0];
  const changeDerivation = parsed.outputs.find(
    (output) => output.redeemScript !== null && output.derivations.length > 0
  )?.derivations[0];
  const lastPathIndex = changeDerivation
    ? changeDerivation.derivationPath[
        changeDerivation.derivationPath.length - 1
      ]
    : undefined;
  const sighashType = parsed.inputs[0]?.requestedSighashType;
  if (
    sighashType === null ||
    sighashType === undefined ||
    parsed.inputs.some((input) => input.requestedSighashType !== sighashType)
  ) {
    throw new Error(
      'Saved multisig proposal is missing one consistent sighash type.'
    );
  }

  return {
    proposal: {
      rawUnsignedHex: binToHex(parsed.unsignedTransaction),
      inputs,
      outputs,
      sighashType,
    },
    feeSats: inputSumSats - outputSumSats,
    changeSats: changeOutputs.reduce(
      (sum, output) => sum + output.satoshis,
      0n
    ),
    inputSumSats,
    recipient: recipientOutputs.map(addressFor).find(Boolean) ?? '',
    amountSats: recipientOutputs.reduce(
      (sum, output) => sum + output.satoshis,
      0n
    ),
    changeAddress: changeOutput ? addressFor(changeOutput) : '',
    changeAddressIndex:
      lastPathIndex !== undefined && lastPathIndex >= 0 ? lastPathIndex : 0,
  };
}

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

export const WatchOnlySend: FC<WatchOnlySendProps> = ({
  mobile = false,
  returnTo,
  walletIdOverride,
  backButtonVariant = 'secondary',
  presentation = 'watch-only',
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const standardWalletId = useSelector(selectWalletId);
  const currentNetwork = useSelector(
    (state: RootState) => state.network.currentNetwork
  );
  const fusionDepthRev = useFusionDepthRevision(
    walletIdOverride ?? standardWalletId ?? 0
  );

  const [recipient, setRecipient] = useState('');
  const [amountSats, setAmountSats] = useState<bigint | null>(null);
  const [amountText, setAmountText] = useState('');
  const [changeAddress, setChangeAddress] = useState('');
  const [changeAddressIndex, setChangeAddressIndex] = useState(0);
  const [inputs, setInputs] = useState<SpendableInput[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fingerprint, setFingerprint] = useState('');
  const [accountPath, setAccountPath] = useState(() =>
    getBchAccountPath(currentNetwork)
  );
  const [sighashType, setSighashType] = useState(SIGHASH_ALL_FORKID);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [multisigPolicy, setMultisigPolicy] = useState<MultisigPolicy | null>(
    null
  );
  const [busy, setBusy] = useState(true);
  const [networkRefreshing, setNetworkRefreshing] = useState(false);
  const [networkRefreshFailed, setNetworkRefreshFailed] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [error, setError] = useState('');
  const [conflictingTxids, setConflictingTxids] = useState<string[]>([]);

  const [proposalState, setProposalState] = useState<ProposalState | null>(
    null
  );

  const [frames, setFrames] = useState<UrFrames | null>(null);
  const [qrUri, setQrUri] = useState('');
  const [urFragmentLength, setUrFragmentLength] = useState<number>(
    DEFAULT_UR_FRAGMENT_LENGTH
  );
  const [qrMode, setQrMode] = useState<'static' | 'stream'>('static');

  const [importText, setImportText] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  // The QR is bounded by the card it sits in, and a signer reads it faster
  // the larger it is. Testers asked for the whole window, so this gives it.
  const [qrFullscreen, setQrFullscreen] = useState(false);
  // One decoder for the whole scan, not one per frame. An animated UR spans
  // dozens of frames, so a decoder rebuilt on each arrival discards every part
  // it has already seen and can never complete a multi-part signed PSBT --
  // which is why scanning a signed result never finished.
  const urScannerRef = useRef<UrPsbtScanner | null>(null);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanFrames, setScanFrames] = useState(0);
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
    const inspected = inspectImportedPsbt(mergedPsbt, proposalState.proposal);
    if (inspected.state !== 'complete') return inspected;
    try {
      return {
        ...inspected,
        // Signature inspection deliberately stops at cryptographic proof.
        // Construct the final BCH transaction only after that proof passes so
        // the broadcast gate has a transaction-bound raw payload to review.
        rawTxHex: mergeImportedSignatures(mergedPsbt, proposalState.proposal),
      };
    } catch (cause) {
      return {
        ...inspected,
        state: 'invalid',
        reason:
          cause instanceof Error
            ? `Signatures are present, but final transaction assembly failed: ${cause.message}`
            : 'Signatures are present, but final transaction assembly failed.',
      };
    }
  }, [mergedPsbt, proposalState]);
  const [broadcastTxid, setBroadcastTxid] = useState('');
  const [broadcastState, setBroadcastState] =
    useState<BroadcastState>('broadcasted');
  const [broadcastArmed, setBroadcastArmed] = useState(false);
  const [qrTextCopied, setQrTextCopied] = useState(false);
  const [localSignConfirmed, setLocalSignConfirmed] = useState(false);
  const [coordinatorSessionId, setCoordinatorSessionId] = useState('');
  const [restoredSession, setRestoredSession] = useState(false);
  const [multisigSpendMode, setMultisigSpendMode] =
    useState<MultisigSpendMode | null>(null);
  const [pendingSession, setPendingSession] =
    useState<MultisigSpendSession | null>(null);
  const [pendingSpendCheck, setPendingSpendCheck] = useState<
    'idle' | 'checking' | 'error'
  >('checking');
  const [pendingSpendCheckNonce, setPendingSpendCheckNonce] = useState(0);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameIndexRef = useRef(0);
  const frameCountRef = useRef(0);

  const locationState = useMemo<WatchOnlySendLocationState | null>(
    () => (location.state as WatchOnlySendLocationState | null) ?? null,
    [location.state]
  );

  const currentWalletId = useMemo(() => {
    if (walletIdOverride && walletIdOverride > 0) return walletIdOverride;
    if (standardWalletId) return standardWalletId;
    const fromReturnTo = locationState?.returnTo?.split('/').pop();
    return fromReturnTo ? Number(fromReturnTo) : null;
  }, [locationState, standardWalletId, walletIdOverride]);
  const policyNetwork = multisigPolicy?.network ?? currentNetwork;
  const multisigPresentation = presentation === 'multisig';

  useEffect(() => {
    setMultisigSpendMode(locationState?.multisigSpendMode ?? null);
  }, [locationState]);

  const persistCoordinatorSession = async (psbtBytes: Uint8Array) => {
    if (!mobile || !multisigPolicy || !currentWalletId) return null;
    const parsed = decodePsbt(psbtBytes);
    const policyId = createMultisigDescriptorSet(
      multisigPolicy,
      policyNetwork
    ).policyId;
    const session = await createMultisigSpendSession({
      walletId: currentWalletId,
      policyId,
      unsignedTxHash: binToHex(hash256(parsed.unsignedTransaction)),
      psbtBytes,
    });
    setCoordinatorSessionId(session.sessionId);
    return session;
  };

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
      setNetworkRefreshing(false);
      setNetworkRefreshFailed(false);
      setError('');
      try {
        if (!currentWalletId) {
          setError(
            'No wallet is open. Go back and open the watch-only wallet first.'
          );
          return;
        }
        const metadata =
          await WalletManager().getWalletMetadata(currentWalletId);
        setAccountPath(
          metadata?.derivation_path ?? getBchAccountPath(currentNetwork)
        );

        // Mobile multisig uses the shared policy tables. The legacy desktop
        // fingerprint lives in wallets.master_fingerprint, which is not part
        // of the mobile schema and must never be queried for this route.
        const policy = mobile
          ? await loadMultisigPolicy(currentWalletId)
          : (await watchOnlyMultisigPolicy(currentWalletId)) ??
            (await loadMultisigPolicy(currentWalletId));
        if (cancelled) return;
        setMultisigPolicy(policy);
        if (!mobile) {
          const stored = await watchOnlyMasterFingerprint(currentWalletId);
          if (stored) {
            setFingerprint(stored);
          }
        }

        const keys = await KeyService.retrieveKeys(currentWalletId);
        const utxoResult =
          await UTXOService.fetchAllWalletUtxos(currentWalletId);
        const keyByAddress = new Map<string, KeyRow>();
        for (const key of keys as KeyRow[]) {
          if (key?.address && !keyByAddress.has(key.address)) {
            keyByAddress.set(key.address, key);
          }
        }

        // A multisig wallet's coins are not owned by any single key, so its
        // inputs need the redeem script, threshold and every cosigner's
        // derivation. Re-derive that public material from the policy for both
        // cached and freshly refreshed UTXOs.
        const applyInventory = (allUtxos: UTXO[]) => {
          const spendable: SpendableInput[] = [];
          const derivedCache = new Map<
            string,
            ReturnType<typeof deriveMultisigAddress>
          >();
          for (const utxo of allUtxos) {
            const key = keyByAddress.get(utxo.address);
            if (!key) continue;
            const script = cashAddressToLockingBytecode(utxo.address);
            if (typeof script === 'string') continue;
            const branchIndex = key.changeIndex === 1 ? 1 : 0;

            if (policy) {
              const cacheKey = `${branchIndex}/${key.addressIndex}`;
              const derived =
                derivedCache.get(cacheKey) ??
                deriveMultisigAddress(policy, branchIndex, key.addressIndex);
              derivedCache.set(cacheKey, derived);
              spendable.push({
                txid: utxo.tx_hash,
                vout: utxo.tx_pos,
                satoshis: BigInt(utxo.amount ?? 0),
                lockingBytecodeHex: toHex(Uint8Array.from(script.bytecode)),
                // No single key owns this coin; the first sorted cosigner key
                // is only a display placeholder. Spending uses all derivations.
                publicKeyHex: toHex(derived.sortedPublicKeys[0]),
                branchIndex,
                addressIndex: key.addressIndex,
                redeemScriptHex: toHex(derived.redeemScript),
                requiredSignatures: policy.m,
                cosignerDerivations: multisigCosignerDerivations(
                  policy,
                  derived.derivedCosigners,
                  branchIndex,
                  key.addressIndex,
                  getBchAccountPath(currentNetwork)
                ),
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
            setChangeAddressIndex(keysForChange[0].addressIndex);
          }
        };

        if (cancelled) return;
        applyInventory(utxoResult.allUtxos);
        if (mobile && policy) {
          // Do not hold the entire send workspace hostage to Electrum. The
          // cached inventory is shown now; only the refresh remains active.
          setBusy(false);
          setNetworkRefreshing(true);
          try {
            const refreshed = await refreshMultisigWalletUtxos(currentWalletId);
            if (!cancelled) {
              applyInventory(Object.values(refreshed).flat());
              setNetworkRefreshFailed(false);
            }
          } catch (refreshError) {
            if (!cancelled) {
              setNetworkRefreshFailed(true);
              setError(
                refreshError instanceof Error
                  ? `Network refresh unavailable; showing saved multisig inventory. ${refreshError.message}`
                  : 'Network refresh unavailable; showing saved multisig inventory.'
              );
            }
          } finally {
            if (!cancelled) setNetworkRefreshing(false);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : 'Could not load the wallet coins.'
          );
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentWalletId, currentNetwork, mobile, refreshNonce]);

  useEffect(() => {
    if (
      !mobile ||
      !currentWalletId ||
      !multisigPolicy ||
      proposalState ||
      multisigSpendMode === 'new'
    ) {
      return;
    }
    setPendingSpendCheck('checking');
    let cancelled = false;
    const restore = async () => {
      try {
        const policyId = createMultisigDescriptorSet(
          multisigPolicy,
          policyNetwork
        ).policyId;
        const sessions = await listMultisigSpendSessions(currentWalletId);
        const pending = sessions.find(
          (session) => session.policyId === policyId
        );
        if (cancelled) return;
        if (!pending) {
          setPendingSession(null);
          setPendingSpendCheck('idle');
          setMultisigSpendMode('new');
          return;
        }
        setPendingSession(pending);
        setPendingSpendCheck('idle');
        if (multisigSpendMode !== 'resume') return;
        // A resumed proposal may be waiting for the background network scan
        // to repopulate the local UTXO inventory. Keep the session selected
        // and let this effect retry when inputs arrive.
        if (inputs.length === 0) return;
        const parsed = decodePsbt(pending.psbtBytes);
        const restored = restoreProposalFromPsbt(
          parsed,
          inputs,
          policyNetwork ?? 'chipnet'
        );
        if (cancelled) return;
        setCoordinatorSessionId(pending.sessionId);
        setRestoredSession(true);
        setProposalState({
          psbtBytes: pending.psbtBytes,
          proposal: restored.proposal,
          feeSats: restored.feeSats,
          changeSats: restored.changeSats,
          inputSumSats: restored.inputSumSats,
        });
        setMergedPsbt(pending.psbtBytes);
        setSelected(
          new Set(
            restored.proposal.inputs.map(
              (input) => `${input.txid}:${input.vout}`
            )
          )
        );
        setRecipient(restored.recipient);
        setAmountSats(restored.amountSats);
        setAmountText(satsToBch(restored.amountSats));
        setChangeAddress(restored.changeAddress);
        setChangeAddressIndex(restored.changeAddressIndex);
        setImportErrors([]);
        const display = encodePsbtToQrDisplay(pending.psbtBytes);
        frameIndexRef.current = 0;
        frameCountRef.current = display.count;
        setFrames(display.frames);
        setQrMode(display.mode);
        setQrUri(display.uri);
      } catch (cause) {
        if (!cancelled) {
          setPendingSpendCheck('error');
          setError(
            cause instanceof Error
              ? `Could not restore the pending multisig spend: ${cause.message}`
              : 'Could not restore the pending multisig spend.'
          );
        }
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [
    currentNetwork,
    currentWalletId,
    inputs,
    mobile,
    multisigPolicy,
    multisigSpendMode,
    pendingSpendCheckNonce,
    policyNetwork,
    proposalState,
  ]);

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

  const bchOnlyInputs = useMemo(
    () => inputs.filter((input) => !input.token && !input.utxo.token),
    [inputs]
  );
  const tokenInputCount = inputs.length - bchOnlyInputs.length;
  const maxSendable = useMemo(() => {
    if (!multisigPolicy || bchOnlyInputs.length === 0 || !recipient.trim()) {
      return null;
    }
    const destination = cashAddressToLockingBytecode(recipient.trim());
    if (typeof destination === 'string') return null;
    try {
      // Send-all has no change output. The fee is calculated from the same
      // conservative final P2SH size used by the builder, at exactly 1 sat/B.
      const estimatedBytes = estimateFinalTransactionBytes(bchOnlyInputs, [
        {
          bytecode: Uint8Array.from(destination.bytecode),
          satoshis: 0n,
        },
      ]);
      const feeSats = feeForTransactionBytes(
        estimatedBytes,
        MULTISIG_FEE_RATE_SAT_PER_BYTE
      );
      const availableSats = bchOnlyInputs.reduce(
        (sum, input) => sum + input.satoshis,
        0n
      );
      const amountSats = availableSats - feeSats;
      return amountSats > 0n ? { amountSats, feeSats } : null;
    } catch {
      return null;
    }
  }, [bchOnlyInputs, multisigPolicy, recipient]);

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

  const startQrFrames = (psbt: Uint8Array, fragmentLength: number) => {
    if (!desktopQr) {
      const display = encodePsbtToQrDisplay(psbt);
      frameIndexRef.current = 0;
      frameCountRef.current = display.count;
      setFrames(display.frames);
      setQrMode(display.mode);
      setQrUri(display.uri);
      return;
    }
    const frameSource = encodePsbtToUrFrames(psbt, fragmentLength);
    frameIndexRef.current = 0;
    frameCountRef.current = frameSource.count;
    setFrames(frameSource);
    setQrMode('stream');
    setQrUri(frameSource.next());
  };

  const formatBchInput = (satoshis: bigint): string => {
    const whole = satoshis / 100_000_000n;
    const fraction = (satoshis % 100_000_000n)
      .toString()
      .padStart(8, '0')
      .replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  };

  const handleSendAll = () => {
    if (!multisigPolicy) return;
    if (!recipient.trim()) {
      setError(
        'Enter the destination first so the send-all fee can be calculated.'
      );
      return;
    }
    if (!maxSendable) {
      setError(
        'The available BCH does not cover the 1 sat/byte transaction fee.'
      );
      return;
    }
    setSelected(
      new Set(bchOnlyInputs.map((input) => `${input.txid}:${input.vout}`))
    );
    setAmountSats(maxSendable.amountSats);
    setAmountText(formatBchInput(maxSendable.amountSats));
    setError('');
  };

  const handleBuild = async () => {
    setError('');
    setConflictingTxids([]);
    setRestoredSession(false);
    setProposalState(null);
    setFrames(null);
    setMergedPsbt(null);
    setImportErrors([]);
    setBroadcastTxid('');
    setBroadcastState('broadcasted');
    setBroadcastArmed(false);
    if (selectedInputs.length === 0) {
      setError('Select at least one coin (coin control).');
      return;
    }
    if (!recipient.trim()) {
      setError('Enter the destination address.');
      return;
    }
    {
      const { recipientNetworkError } = await import('../../utils/bip21');
      const netErr = recipientNetworkError(recipient.trim(), currentNetwork);
      if (netErr) {
        setError(netErr);
        return;
      }
    }
    if (amountSats === null || amountSats <= 0n) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (!changeAddress) {
      setError(
        'No change address available. Add more change addresses to the wallet.'
      );
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
        ? deriveMultisigAddress(
            multisigPolicy,
            changeBranch,
            changeAddressIndex
          )
        : null;

      const result = buildWatchOnlyPsbt({
        inputs: inputsWithParents,
        recipient: recipient.trim(),
        amountSats,
        changeAddress,
        accountPath,
        sighashType,
        masterFingerprint: fingerprint
          ? masterFingerprintBytes(fingerprint)
          : null,
        feeRateSatPerByte: multisigPolicy
          ? MULTISIG_FEE_RATE_SAT_PER_BYTE
          : undefined,
        ...(changeMultisig && multisigPolicy
          ? {
              changeRedeemScriptHex: toHex(changeMultisig.redeemScript),
              changeDerivations: multisigCosignerDerivations(
                multisigPolicy,
                changeMultisig.derivedCosigners,
                changeBranch,
                changeAddressIndex,
                getBchAccountPath(currentNetwork)
              ),
            }
          : {}),
      });
      await persistCoordinatorSession(result.psbtBytes);
      const proposal: WatchOnlyProposal = {
        rawUnsignedHex: result.rawUnsignedHex,
        inputs: inputsWithParents,
        outputs: result.outputs,
        sighashType: result.sighashType,
      };
      setProposalState({
        psbtBytes: result.psbtBytes,
        proposal,
        feeSats: result.feeSats,
        changeSats: result.changeSats,
        inputSumSats: result.inputSumSats,
      });
      startQrFrames(result.psbtBytes, urFragmentLength);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not build the unsigned transaction.'
      );
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
  const importAndMerge = async (psbt: Uint8Array) => {
    setBroadcastTxid('');
    setBroadcastState('broadcasted');
    setBroadcastArmed(false);
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    setBusy(true);
    try {
      const base = mergedPsbt ?? proposalState.psbtBytes;
      const outcome = mergePsbts([base, psbt]);
      if (outcome.results.some((result) => result.combined)) {
        const nextPsbt = outcome.merged;
        await persistCoordinatorSession(nextPsbt);
        setMergedPsbt(nextPsbt);
        // Carry the accumulated signatures to the next cosigner. Reusing the
        // original unsigned frames would restart the threshold flow.
        const nextFrames = encodePsbtToQrDisplay(nextPsbt);
        frameIndexRef.current = 0;
        frameCountRef.current = nextFrames.count;
        setFrames(nextFrames.frames);
        setQrMode(nextFrames.mode);
        setQrUri(nextFrames.uri);
        setImportText('');
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
      setError(
        err instanceof Error
          ? err.message
          : 'Could not merge the signed transaction.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleLocalSign = async () => {
    if (!mobile || !multisigPolicy || !proposalState || !currentWalletId) {
      return;
    }
    if (!standardWalletId || standardWalletId === currentWalletId) {
      setError(
        'Open this multisig policy alongside the standard mnemonic wallet for this device.'
      );
      return;
    }
    if (!localSignConfirmed) {
      setError('Review the transaction and confirm before signing.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const activePsbt = mergedPsbt ?? proposalState.psbtBytes;
      const parsed = decodePsbt(activePsbt);
      const policyId = createMultisigDescriptorSet(
        multisigPolicy,
        policyNetwork
      ).policyId;
      const session = await createMultisigSpendSession({
        walletId: currentWalletId,
        policyId,
        unsignedTxHash: binToHex(hash256(parsed.unsignedTransaction)),
        psbtBytes: activePsbt,
      });
      const result = await signMultisigPsbtLocally({
        policyWalletId: currentWalletId,
        signerWalletId: standardWalletId,
        sessionId: session.sessionId,
        policyId,
        unsignedTxHash: binToHex(hash256(parsed.unsignedTransaction)),
        psbtBytes: activePsbt,
        authorize: async () => undefined,
      });
      if (result.signedInputIndexes.length === 0) {
        throw new Error('This device is not a remaining signer for any input.');
      }
      setLocalSignConfirmed(false);
      await importAndMerge(result.psbtBytes);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not sign with this device.'
      );
    } finally {
      setBusy(false);
    }
  };

  const psbtFromUrText = (text: string): Uint8Array | null => {
    const scanner = new UrPsbtScanner();
    for (const part of text.split(/[\s,;]+/)) {
      if (!part.trim()) continue;
      const progress = scanner.receive(part.trim());
      if (progress.complete && progress.psbt) return progress.psbt;
    }
    return null;
  };

  const handleImportText = () => {
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    try {
      const psbt = psbtFromUrText(importText);
      if (!psbt) {
        setError(
          'Not enough frames scanned. Scan every frame of the signer screen (it loops).'
        );
        return;
      }
      importAndMerge(psbt);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not read the signed transaction.'
      );
    }
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    if (file.size > MAX_SIGNED_PSBT_FILE_BYTES) {
      setError('Signed PSBT files must be 5 MB or smaller.');
      return;
    }

    setError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const psbt = parsePsbtBytes(bytes);
        decodePsbt(psbt);
        importAndMerge(psbt);
        return;
      } catch {
        // Some signers export a text file containing the animated UR frames.
        // Try that transport only after confirming the file is not a PSBT.
      }

      const psbt = psbtFromUrText(new TextDecoder().decode(bytes));
      if (!psbt) {
        throw new Error(
          'The file is not a binary, hex, base64, or complete UR signed PSBT.'
        );
      }
      importAndMerge(psbt);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not read the PSBT file.'
      );
    }
  };

  const changeQrDensity = (next: number) => {
    if (!proposalState) return;
    setUrFragmentLength(next);
    startQrFrames(proposalState.psbtBytes, next);
  };

  const densityIndex = UR_FRAGMENT_LENGTH_OPTIONS.indexOf(
    urFragmentLength as (typeof UR_FRAGMENT_LENGTH_OPTIONS)[number]
  );
  const densityAt = densityIndex < 0 ? 0 : densityIndex;
  const canDecreaseDensity = densityAt > 0;
  const canIncreaseDensity = densityAt < UR_FRAGMENT_LENGTH_OPTIONS.length - 1;
  const stepQrDensity = (delta: -1 | 1) => {
    const next = UR_FRAGMENT_LENGTH_OPTIONS[densityAt + delta];
    if (next == null) return;
    changeQrDensity(next);
  };
  const desktopQr = isDesktopPlatform();

  const openScanner = () => {
    urScannerRef.current = new UrPsbtScanner();
    setScanProgress(0);
    setScanFrames(0);
    setScannerOpen(true);
  };

  const closeScanner = () => {
    setScannerOpen(false);
    urScannerRef.current = null;
  };

  const handleCopyQrText = async () => {
    if (!qrUri) return;
    setQrTextCopied(await copyToClipboard(qrUri));
  };

  const handleScanFrame = (text: string) => {
    if (!proposalState) {
      setError('Build the unsigned transaction first.');
      return;
    }
    try {
      const scanner = (urScannerRef.current ??= new UrPsbtScanner());
      const progress = scanner.receive(text);
      setScanProgress(progress.progress);
      setScanFrames((count) => count + 1);
      if (progress.complete && progress.psbt) {
        importAndMerge(progress.psbt);
        closeScanner();
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not read the signed transaction.'
      );
      // A frame that poisons the decoder leaves it unusable, so the next scan
      // starts from a clean one rather than inheriting the failure.
      closeScanner();
    }
  };

  const handleBroadcast = async () => {
    if (
      !proposalState ||
      !verdict ||
      verdict.state !== 'complete' ||
      !verdict.rawTxHex
    ) {
      return;
    }
    try {
      validateBroadcastRelayFee(
        verdict.rawTxHex,
        proposalState.inputSumSats,
        multisigPolicy ? MULTISIG_FEE_RATE_SAT_PER_BYTE : undefined
      );
    } catch (feeError) {
      setBroadcastArmed(false);
      setError(
        feeError instanceof Error
          ? feeError.message
          : 'The signed transaction fee is too low for BCH relay policy. Rebuild the spend before broadcasting.'
      );
      return;
    }
    setBusy(true);
    setError('');
    setConflictingTxids([]);
    try {
      const res = await TransactionService.sendTransaction(
        verdict.rawTxHex,
        proposalState.proposal.inputs.map(
          (input) => (input as SpendableInput).utxo
        ),
        {
          walletId: currentWalletId ?? undefined,
          multisig: Boolean(multisigPolicy),
          source: mobile ? 'multisig' : 'watch-only',
          sourceLabel: mobile
            ? 'Mobile multisig send'
            : 'Watch-only send (air-gapped)',
          recipientSummary: recipient.trim(),
          amountSummary: satsToBch(amountSats ?? 0n),
        }
      );
      if (res.errorMessage) {
        setBroadcastArmed(false);
        setConflictingTxids(res.conflictingTxids ?? []);
        setError(res.errorMessage);
        return;
      }
      if (!res.txid) {
        throw new Error('Broadcast failed with no txid returned.');
      }
      setBroadcastTxid(res.txid);
      setBroadcastState(res.broadcastState ?? 'broadcasted');
      setBroadcastArmed(false);
      if (coordinatorSessionId) {
        try {
          await advanceMultisigSpendSession({
            sessionId: coordinatorSessionId,
            stage: 'submitted',
            rawTxHex: verdict.rawTxHex,
          });
        } catch {
          setError(
            'The transaction was broadcast, but the local session status could not be saved.'
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Broadcast failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleReleaseConflictingMultisigLock = async () => {
    if (!mobile || !currentWalletId || conflictingTxids.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const released = await releaseMultisigOutboundLocks(
        currentWalletId,
        conflictingTxids
      );
      setConflictingTxids([]);
      setBroadcastArmed(false);
      setRefreshNonce((value) => value + 1);
      setError(
        released.length > 0
          ? 'The old local multisig spend lock was released. Review the current transaction again before broadcasting.'
          : 'The old multisig spend lock was already cleared. Refresh the shared-wallet coins and try again.'
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not release the old multisig spend lock.'
      );
    } finally {
      setBusy(false);
    }
  };

  const handleBack = () => {
    navigate(returnTo ?? getReturnPath(location, '/home'));
  };

  const frameNumber =
    frameCountRef.current > 0
      ? (frameIndexRef.current % frameCountRef.current) + 1
      : 0;

  const step: 1 | 2 | 3 =
    broadcastTxid || verdict?.state === 'complete' ? 3 : proposalState ? 2 : 1;

  /**
   * Return to editing. Any signature already collected was made over the exact
   * transaction being discarded, so it cannot carry over — the button says so
   * rather than silently dropping it.
   */
  const handleEditProposal = () => {
    setProposalState(null);
    setFrames(null);
    setQrMode('static');
    setQrUri('');
    setMergedPsbt(null);
    setImportErrors([]);
    setImportText('');
    setBroadcastTxid('');
    setBroadcastState('broadcasted');
    setBroadcastArmed(false);
    setConflictingTxids([]);
    setLocalSignConfirmed(false);
    setRestoredSession(false);
    setMultisigSpendMode('new');
    setError('');
  };

  const pendingChoiceOpen =
    mobile && !!multisigPolicy && !proposalState && multisigSpendMode === null;
  const spendFormEnabled =
    !mobile || !multisigPolicy || multisigSpendMode !== null;

  return (
    <WalletScreen
      maxWidthClassName={
        frames
          ? desktopQr
            ? 'max-w-[min(calc(100vw-1rem),64rem)]'
            : 'max-w-none px-1'
          : 'max-w-md'
      }
      scrollable={false}
      fitParent={mobile}
      reserveBottomNavSpace={mobile}
    >
      <div className="flex h-full min-h-0 flex-col gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleBack}
            className={
              backButtonVariant === 'danger'
                ? 'wallet-btn-danger px-4 py-2'
                : 'wallet-btn-secondary px-3 py-1.5 text-sm'
            }
          >
            Back
          </button>
          <h1
            className="text-lg font-bold wallet-text-strong"
            data-testid="watch-only-send-workspace"
          >
            {mobile ? 'Mobile multisig send' : 'Watch-only Send'}
          </h1>
        </div>

        <StepBar current={step} />

        {networkRefreshing && (
          <p className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs wallet-muted">
            Refreshing shared-wallet coins from the network. Saved coins remain
            visible while this completes.
          </p>
        )}

        {restoredSession && proposalState && (
          <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
            Pending multisig spend restored. Continue signing below or use the
            broadcast review after the threshold is complete.
          </p>
        )}

        {multisigSpendMode === 'resume' && pendingSession && !proposalState && (
          <p className="rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-3 py-2 text-xs wallet-muted">
            Pending spend selected. Waiting for the shared-wallet coin inventory
            before restoring it.
          </p>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain pr-1 space-y-4">
          {busy ? (
            <p className="text-sm wallet-muted">Loading coins…</p>
          ) : (
            <>
              {pendingChoiceOpen && (
                <section className="wallet-card space-y-3 p-4">
                  <p className="text-sm font-semibold wallet-text-strong">
                    Choose multisig spend
                  </p>
                  {pendingSession ? (
                    <>
                      <p className="text-xs leading-relaxed wallet-muted">
                        A pending unsigned or partially signed spend is saved
                        for this policy. Resume it to keep collecting
                        signatures, or start a separate spend without deleting
                        the pending one.
                      </p>
                      <button
                        type="button"
                        className="wallet-btn-primary w-full py-2 text-sm font-semibold"
                        onClick={() => setMultisigSpendMode('resume')}
                      >
                        Resume pending spend
                      </button>
                      <button
                        type="button"
                        className="wallet-btn-secondary w-full py-2 text-sm font-semibold"
                        onClick={() => setMultisigSpendMode('new')}
                      >
                        Create new spend
                      </button>
                    </>
                  ) : pendingSpendCheck === 'checking' ? (
                    <p className="text-xs wallet-muted">
                      Checking for pending spends…
                    </p>
                  ) : pendingSpendCheck === 'error' ? (
                    <>
                      <p className="text-xs text-red-400">
                        Could not check the saved multisig spend sessions.
                      </p>
                      <button
                        type="button"
                        className="wallet-btn-secondary w-full py-2 text-sm"
                        onClick={() => {
                          setPendingSpendCheckNonce((value) => value + 1);
                          setError('');
                        }}
                      >
                        Retry pending spend check
                      </button>
                    </>
                  ) : null}
                </section>
              )}

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
                        {multisigPolicy ? ' · 1 sat/byte' : ''}
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
                className={`wallet-card space-y-2 p-4 ${step === 1 && spendFormEnabled ? '' : 'hidden'}`}
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
                  <div className="space-y-2">
                    <p className="text-xs wallet-muted">
                      No spendable BCH coins found. Refresh the multisig address
                      inventory and make sure it holds BCH (not only tokens).
                    </p>
                    <button
                      type="button"
                      onClick={() => setRefreshNonce((value) => value + 1)}
                      className="wallet-btn-secondary w-full py-2 text-xs"
                      disabled={busy || networkRefreshing}
                    >
                      {networkRefreshing
                        ? 'Refreshing…'
                        : mobile
                          ? 'Refresh multisig coins'
                          : 'Reload coins'}
                    </button>
                  </div>
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
                              {currentWalletId !== null &&
                                currentWalletId > 0 && (
                                  <FusionBadge
                                    depth={(() => {
                                      void fusionDepthRev;
                                      return coinDepth(
                                        currentWalletId ?? 0,
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
                className={`wallet-card space-y-3 p-4 ${step === 1 && spendFormEnabled ? '' : 'hidden'}`}
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
                <button
                  type="button"
                  onClick={() => setShowAdvanced((open) => !open)}
                  className="text-left text-sm font-semibold wallet-text-strong underline-offset-2 hover:underline"
                  aria-expanded={showAdvanced}
                >
                  {showAdvanced ? 'Hide advanced' : 'Advanced'}
                </button>
                {showAdvanced && (
                  <div className="space-y-2">
                    <label className="block space-y-1 text-sm wallet-text-strong">
                      Sighash type
                      <select
                        value={sighashType}
                        onChange={(event) =>
                          setSighashType(Number(event.target.value))
                        }
                        className="wallet-input w-full rounded-md px-3 py-2"
                      >
                        {SIGHASH_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {sighashType !== SIGHASH_ALL_FORKID && (
                      <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                        Advanced sighash modes commit to fewer transaction
                        fields. Only use this when the BCH script or signing
                        policy explicitly requires it.
                      </p>
                    )}
                  </div>
                )}
                {multisigPolicy && (
                  <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold wallet-text-strong">
                        Multisig fee policy
                      </p>
                      <span className="rounded-full border border-emerald-500/40 px-2 py-1 text-[10px] font-semibold text-emerald-300">
                        1 sat/byte
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed wallet-muted">
                      Send all available BCH to the destination and leave out
                      the transaction fee. CashToken coins are kept separate.
                    </p>
                    <button
                      type="button"
                      onClick={handleSendAll}
                      className="wallet-btn-secondary w-full py-2 text-sm font-semibold"
                      disabled={
                        busy ||
                        networkRefreshing ||
                        networkRefreshFailed ||
                        bchOnlyInputs.length === 0 ||
                        !maxSendable
                      }
                    >
                      Send all available BCH
                    </button>
                    {!recipient.trim() ? (
                      <p className="text-[11px] wallet-muted">
                        Enter a destination first to calculate the send-all
                        amount and fee.
                      </p>
                    ) : maxSendable ? (
                      <p className="text-[11px] wallet-muted">
                        Estimated fee: {satsToBch(maxSendable.feeSats)} BCH ·{' '}
                        sends {satsToBch(maxSendable.amountSats)} BCH
                      </p>
                    ) : (
                      <p className="text-[11px] text-amber-300">
                        The available BCH cannot cover the 1 sat/byte fee, or
                        the destination is not valid for this network.
                      </p>
                    )}
                    {tokenInputCount > 0 && (
                      <p className="text-[11px] text-amber-300">
                        {tokenInputCount} CashToken coin
                        {tokenInputCount === 1 ? '' : 's'} will not be included
                        in send-all.
                      </p>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between text-xs wallet-muted">
                  <span>
                    Change → {changeAddress ? shortTxid(changeAddress) : '…'}
                  </span>
                  {proposalState && (
                    <span>
                      Fee {satsToBch(proposalState.feeSats)} BCH
                      {multisigPolicy ? ' · 1 sat/byte' : ''}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  data-testid="watch-only-build-unsigned"
                  onClick={() => void handleBuild()}
                  className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                  disabled={busy || networkRefreshing || networkRefreshFailed}
                >
                  {networkRefreshing
                    ? 'Waiting for network refresh…'
                    : networkRefreshFailed
                      ? 'Network refresh required'
                      : 'Build unsigned transaction'}
                </button>
              </section>

              {/* Step 3: static QR for ordinary PSBTs, stream for larger ones */}
              {proposalState && qrUri && verdict?.state !== 'complete' && (
                <section className="wallet-card space-y-3 p-4">
                  <p className="text-sm font-semibold wallet-text-strong">
                    {mobile
                      ? mergedPsbt
                        ? 'Scan this partially signed PSBT with the next cosigner'
                        : 'Scan this unsigned PSBT with the first cosigner'
                      : 'Scan this with SeedCash (air-gapped)'}
                  </p>
                  <div
                    className={`mx-auto rounded-md bg-white ${
                      desktopQr
                        ? 'w-full max-w-[min(100%,calc(100svh-14rem))] p-1'
                        : 'w-full max-w-none p-0'
                    }`}
                  >
                    <QRCodeSVG
                      value={qrUri}
                      size={PSBT_UR_QR_DISPLAY_SIZE}
                      marginSize={desktopQr ? PSBT_UR_QR_MARGIN_MODULES : 1}
                      level={PSBT_UR_QR_ERROR_LEVEL}
                      className={
                        desktopQr
                          ? 'h-auto w-full max-w-full'
                          : 'h-auto w-full max-w-none'
                      }
                    />
                  </div>
                  <p className="text-center text-xs wallet-muted">
                    {qrMode === 'stream'
                      ? `Frame ${frameNumber} / ${frameCountRef.current} · hold the camera steady, the code loops`
                      : 'Static QR · hold the camera steady'}
                  </p>
                  {desktopQr && (
                    <>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-label="Decrease QR density"
                          onClick={() => stepQrDensity(-1)}
                          disabled={!canDecreaseDensity}
                          className="wallet-btn-secondary min-h-11 min-w-11 px-3 text-lg font-semibold disabled:opacity-50"
                        >
                          −
                        </button>
                        <p className="flex-1 text-center text-sm wallet-text-strong">
                          {urFragmentLength} —{' '}
                          {QR_DENSITY_LABELS[
                            urFragmentLength as keyof typeof QR_DENSITY_LABELS
                          ] ?? 'Custom'}
                        </p>
                        <button
                          type="button"
                          aria-label="Increase QR density"
                          onClick={() => stepQrDensity(1)}
                          disabled={!canIncreaseDensity}
                          className="wallet-btn-secondary min-h-11 min-w-11 px-3 text-lg font-semibold disabled:opacity-50"
                        >
                          +
                        </button>
                      </div>
                      <p className="text-center text-[11px] wallet-muted">
                        Desktop only. Higher density packs more into each frame
                        and restarts scan progress on the signing device.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          changeQrDensity(DEFAULT_UR_FRAGMENT_LENGTH)
                        }
                        disabled={
                          urFragmentLength === DEFAULT_UR_FRAGMENT_LENGTH
                        }
                        className="wallet-btn-secondary w-full py-2 text-sm disabled:opacity-50"
                      >
                        Reset to easiest scan
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setQrFullscreen(true)}
                    className="wallet-btn-secondary w-full py-2 text-sm"
                  >
                    Show full screen
                  </button>
                  {qrFullscreen && (
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-label="Animated QR code, full screen"
                      onClick={() => setQrFullscreen(false)}
                      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-2 bg-white p-1"
                    >
                      <QRCodeSVG
                        value={qrUri}
                        size={PSBT_UR_QR_DISPLAY_SIZE}
                        marginSize={PSBT_UR_QR_MARGIN_MODULES}
                        level={PSBT_UR_QR_ERROR_LEVEL}
                        className="h-auto w-[min(98vw,94svh)] max-w-none"
                      />
                      <p className="text-center text-sm text-black">
                        Frame {frameNumber} / {frameCountRef.current} · tap
                        anywhere to close
                      </p>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleCopyQrText()}
                    className="wallet-btn-secondary w-full py-2 text-sm"
                  >
                    {qrTextCopied
                      ? 'Copied QR text'
                      : qrMode === 'stream'
                        ? 'Copy current frame text'
                        : 'Copy QR text'}
                  </button>
                  {qrMode === 'stream' && (
                    <p className="text-xs wallet-muted">
                      This copies the frame currently displayed. Animated UR
                      transfers still require all frames.
                    </p>
                  )}
                  {mobile && multisigPolicy && (
                    <div className="space-y-2 rounded-xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3">
                      <p className="text-sm font-semibold wallet-text-strong">
                        Sign with this device
                      </p>
                      <p className="text-xs wallet-muted">
                        Use this device&apos;s standard mnemonic wallet as its
                        matching cosigner. The signature is verified and added
                        to this exact PSBT before the next QR is shown.
                      </p>
                      <label className="flex items-start gap-2 text-xs wallet-muted">
                        <input
                          type="checkbox"
                          checked={localSignConfirmed}
                          onChange={(event) =>
                            setLocalSignConfirmed(event.target.checked)
                          }
                          className="mt-0.5 accent-[var(--wallet-accent)]"
                        />
                        <span>
                          I reviewed the destination, amount, fee, change, and
                          token state, and authorize this device to sign.
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => void handleLocalSign()}
                        className="wallet-btn-primary w-full py-2 text-sm font-semibold disabled:opacity-50"
                        disabled={!localSignConfirmed || busy}
                      >
                        {busy ? 'Signing…' : 'Sign with this device'}
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={openScanner}
                    className="wallet-btn-secondary w-full py-2 text-sm"
                  >
                    Scan the signed result
                  </button>
                  <label className="wallet-btn-secondary block w-full cursor-pointer py-2 text-center text-sm">
                    Import signed PSBT file
                    <input
                      type="file"
                      accept=".psbt,.txt,.hex,application/octet-stream,text/plain"
                      onChange={(event) => void handleImportFile(event)}
                      className="sr-only"
                    />
                  </label>
                  <p className="text-center text-[11px] wallet-muted">
                    Use the signer&apos;s exported PSBT file. A screenshot of
                    one animated frame is not a complete PSBT.
                  </p>
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
                  {scannerOpen &&
                    (mobile ? (
                      <QrScanDialog
                        onFrame={handleScanFrame}
                        onClose={closeScanner}
                      />
                    ) : (
                      <CameraQrScanner
                        onResult={handleScanFrame}
                        onClose={closeScanner}
                        continuous
                        progress={scanProgress}
                        statusText={
                          scanFrames === 0
                            ? 'Point the camera at the signed QR on the signer.'
                            : `${scanFrames} frames read - ${Math.round(scanProgress * 100)}% recovered`
                        }
                      />
                    ))}
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
                    const signed = statuses.filter(
                      (status) => status.signed
                    ).length;
                    return (
                      <div key={summary.index} className="space-y-1.5">
                        <p className="text-xs wallet-muted">
                          Input {summary.index}: {signed} of {summary.required}{' '}
                          collected · policy {summary.required} of{' '}
                          {summary.total}
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
              {verdict && !broadcastTxid && (
                <section
                  className={`wallet-card space-y-2 p-4 ${
                    verdict.state === 'complete'
                      ? 'border-emerald-500/50'
                      : verdict.state === 'rejected' ||
                          verdict.state === 'invalid'
                        ? 'border-red-500/50'
                        : ''
                  }`}
                >
                  <p className="text-sm font-semibold wallet-text-strong">
                    {verdict.state === 'complete'
                      ? 'Ready to broadcast'
                      : 'Signed transaction check'}
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
                        onClick={() => setBroadcastArmed(true)}
                        disabled={busy}
                        className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                      >
                        Review and confirm broadcast
                      </button>
                      {!multisigPresentation && broadcastArmed && (
                        <div className="space-y-2 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3">
                          <p className="text-xs leading-relaxed wallet-muted">
                            Confirm the destination, amount, fee, and change
                            above. Broadcasting is irreversible.
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleBroadcast()}
                            disabled={busy}
                            className="wallet-btn-primary w-full py-2 font-semibold disabled:opacity-50"
                          >
                            {busy ? 'Broadcasting…' : 'Broadcast transaction'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setBroadcastArmed(false)}
                            disabled={busy}
                            className="wallet-btn-secondary w-full py-2 text-xs"
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              )}

              {multisigPresentation &&
                verdict?.state === 'complete' &&
                verdict.rawTxHex &&
                proposalState &&
                multisigPolicy && (
                  <MultisigBroadcastReview
                    open={broadcastArmed}
                    recipient={recipient}
                    amountSats={amountSats ?? 0n}
                    inputSumSats={proposalState.inputSumSats}
                    feeSats={proposalState.feeSats}
                    outputs={proposalState.proposal.outputs}
                    selectedInputs={selectedInputs.map((input) => input.utxo)}
                    rawTxHex={verdict.rawTxHex}
                    network={policyNetwork}
                    policyId={
                      createMultisigDescriptorSet(multisigPolicy, policyNetwork)
                        .policyId
                    }
                    threshold={multisigPolicy.threshold ?? multisigPolicy.m}
                    signerCount={multisigPolicy.signers.length}
                    isSending={busy}
                    onClose={() => setBroadcastArmed(false)}
                    onConfirmSend={() => void handleBroadcast()}
                  />
                )}

              {broadcastTxid && (
                <section
                  role="status"
                  aria-live="polite"
                  className="mt-3 shrink-0 rounded-2xl border p-4 text-sm shadow-sm wallet-success-panel"
                >
                  <div className="mb-1 font-semibold wallet-text-strong">
                    {broadcastState === 'submitted'
                      ? t('send.submitted')
                      : t('send.sent')}
                  </div>
                  {broadcastState === 'submitted' && (
                    <div className="mb-2 wallet-muted">
                      {t('send.keepTxid')}
                    </div>
                  )}
                  <div className="break-all font-mono wallet-text-strong">
                    {broadcastTxid}
                  </div>
                </section>
              )}

              {error && (
                <>
                  <p role="alert" className="text-xs text-red-400">
                    {error}
                  </p>
                  {mobile && conflictingTxids.length > 0 && (
                    <section className="space-y-2 rounded-xl border border-amber-500/60 bg-amber-500/10 p-3">
                      <p className="text-sm font-semibold text-amber-200">
                        Previous multisig spend still reserved
                      </p>
                      <p className="text-xs leading-relaxed wallet-muted">
                        Release this local lock only after confirming that the
                        previous transaction was rejected or is absent from the
                        network. An unresolved transaction may still confirm.
                      </p>
                      <div className="space-y-1 font-mono text-[10px] text-amber-100">
                        {conflictingTxids.map((txid) => (
                          <p key={txid} className="break-all">
                            {txid}
                          </p>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          void handleReleaseConflictingMultisigLock()
                        }
                        disabled={busy}
                        className="wallet-btn-secondary w-full py-2 text-xs disabled:opacity-50"
                      >
                        Release rejected spend lock
                      </button>
                    </section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </WalletScreen>
  );
};

export default WatchOnlySend;
