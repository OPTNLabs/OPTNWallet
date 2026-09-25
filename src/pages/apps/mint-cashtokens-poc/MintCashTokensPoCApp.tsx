// @ts-nocheck WIP app surface; see docs/wip-typecheck-exclusions.md

// src/pages/apps/mintCashTokensPoCApp/MintCashTokensPoCApp.tsx

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';

import {
  BcmrRegistryError,
  bcmrSymbolProblem,
  buildBootstrapPreview,
  buildMintPreview,
  defaultParseBytecode,
  generateBcmrRegistry,
  parsableNftCommitment,
  selectFeeCandidates,
  sequentialNftCommitment,
  suggestBcmrIdentity,
  validateMintRequest,
  type AuthoredBcmrRegistry,
  type BcmrNftsSchemaInput,
} from './services';
import {
  IpfsUploadResult,
  uploadToIpfsRelay,
  waitForIpfsAvailability,
} from '../../../services/IpfsService';
import TransactionService from '../../../services/TransactionService';
import UTXOService from '../../../services/UTXOService';
import { copyToClipboard } from '../../../utils/clipboard';
import { sha256 } from '../../../utils/hash';
import BcmrService, {
  isBcmrRegistryNotFoundError,
} from '../../../services/BcmrService';
import { getReturnPath } from '../../../utils/navigation';

import TxSummary from '../../../components/confirm/TxSummary';
import {
  AmountsStepCard,
  Badge,
  ContainedSwipeConfirmModal,
  RecipientsStepCard,
  SourcesStepCard,
  Stepper,
} from './components';
import Popup from '../../../components/transaction/Popup';
import type {
  MintAppUtxo,
  MintBcmrPublication,
  MintConfig,
  MintDisplayUtxo,
  MintOutputDraft,
  WalletAddressRecord,
} from './types';
import {
  asTxSummaryInputs,
  asTxSummaryOutputs,
  filterActiveOutputDrafts,
  mergeWalletUtxos,
  shortHash,
  utxoKey,
} from './utils';
import {
  canMintFungibleFromSource,
  getMintSourceCategory,
  getMintSourceKind,
  isGenesisMintSource,
  selectMintSourceUtxos,
} from './utils/sourceHelpers';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';
import { selectWalletId } from '../../../state/slices/walletSlice';
import { selectCurrentNetwork } from '../../../state/selectors/networkSelectors';
import FieldHint from './components/FieldHint';
import { useAddonI18n } from '../../../i18n/useAddonI18n';

type BcmrFieldKey =
  | 'tokenCategory'
  | 'tokenName'
  | 'tokenSymbol'
  | 'tokenDecimals'
  | 'iconUri'
  | 'webUri'
  | 'registry'
  | 'image'
  | 'nftBytecode'
  | 'nftTypes'
  | 'nftFields'
  | 'general';

type FlowState = {
  loading: boolean;
  txid: string;
  status: string;
  errorMessage: string;
};

type ConfirmState = {
  open: boolean;
  loading: boolean;
  title: string;
  subtitle: string;
  warning: React.ReactNode;
  body: React.ReactNode;
};

type BcmrUploadPhase = 'idle' | 'uploading' | 'verifying' | 'ready' | 'error';

type BcmrUploadStatus = {
  phase: BcmrUploadPhase;
  message: string;
};

type BcmrFormFingerprint = {
  authbase: string;
  tokenCategory: string;
  tokenName: string;
  tokenDescription: string;
  tokenSymbol: string;
  tokenDecimals: number;
  iconUri: string;
  webUri: string;
  network: string;
  hasNfts: boolean;
  nftKind: 'parsable' | 'sequential';
  nftAdvanced: boolean;
  nftCommitments: string[];
  nftsDescription: string;
  nftBytecode: string;
  nftTypesJson: string;
  nftFieldsJson: string;
};

type FlowAction =
  | { type: 'set_loading'; value: boolean }
  | { type: 'set_txid'; value: string }
  | { type: 'set_status'; value: string }
  | { type: 'set_error'; value: string }
  | { type: 'reset_messages' };

const initialFlowState: FlowState = {
  loading: false,
  txid: '',
  status: '',
  errorMessage: '',
};

const initialConfirmState: ConfirmState = {
  open: false,
  loading: false,
  title: '',
  subtitle: '',
  warning: null,
  body: null,
};

const IDLE_BCMR_UPLOAD_STATUS: BcmrUploadStatus = {
  phase: 'idle',
  message: '',
};

const EMPTY_BCMR_ERRORS: Partial<Record<BcmrFieldKey, string>> = {};

function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'set_loading':
      return { ...state, loading: action.value };
    case 'set_txid':
      return { ...state, txid: action.value };
    case 'set_status':
      return { ...state, status: action.value };
    case 'set_error':
      return { ...state, errorMessage: action.value };
    case 'reset_messages':
      return { ...state, errorMessage: '', status: '', txid: '' };
    default:
      return state;
  }
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

function describeMintSourceKind(
  utxo: MintDisplayUtxo
): 'genesis source' | 'minting authority' | 'unsupported source' {
  switch (getMintSourceKind(utxo)) {
    case 'minting-nft':
      return 'minting authority';
    case 'genesis':
      return 'genesis source';
    default:
      return 'unsupported source';
  }
}

const MintCashTokensPoCApp: React.FC = () => {
  const { t: addonT } = useAddonI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const backTarget = getReturnPath(location, '/apps');
  const walletId = useSelector(selectWalletId);

  const [addresses, setAddresses] = useState<WalletAddressRecord[]>([]);
  const [flatUtxos, setFlatUtxos] = useState<MintAppUtxo[]>([]);
  const [changeAddress, setChangeAddress] = useState<string>('');
  const [flowState, dispatchFlow] = useReducer(flowReducer, initialFlowState);
  const { errorMessage, loading, status, txid } = flowState;
  const bcmrService = useMemo(() => new BcmrService(), []);

  const [selectedRecipientCashAddrs, setSelectedRecipientCashAddrs] = useState<
    Set<string>
  >(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [outputDrafts, setOutputDrafts] = useState<MintOutputDraft[]>([]);
  const [showOutputPopup, setShowOutputPopup] = useState(false);
  const [editingOutputDraftId, setEditingOutputDraftId] = useState<
    string | null
  >(null);
  const [outputFormMintType, setOutputFormMintType] = useState<'FT' | 'NFT'>(
    'FT'
  );
  const [outputFormRecipient, setOutputFormRecipient] = useState('');
  const [outputFormSourceKey, setOutputFormSourceKey] = useState('');
  const [outputFormFtAmount, setOutputFormFtAmount] = useState('1');
  const [outputFormNftCapability, setOutputFormNftCapability] =
    useState<MintConfig['nftCapability']>('none');
  const [outputFormNftCommitment, setOutputFormNftCommitment] = useState('');
  const [outputFormNftSerial, setOutputFormNftSerial] = useState('1');
  const [outputFormCommitmentMode, setOutputFormCommitmentMode] = useState<
    'serial' | 'custom'
  >('serial');
  const draftSeq = useRef(0);

  // Bootstrap
  const [bootstrapTxids, setBootstrapTxids] = useState<string[]>([]);

  // Step UI (mobile-friendly)
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [mountedSteps, setMountedSteps] = useState<Set<1 | 2 | 3>>(
    () => new Set([1])
  );

  // UX feedback (copy)
  const [toast, setToast] = useState<string>('');
  const toastTimer = useRef<number | null>(null);

  // Confirmation modal state
  const [confirmState, setConfirmState] =
    useState<ConfirmState>(initialConfirmState);
  const pendingConfirmActionRef = useRef<null | (() => Promise<void>)>(null);
  const [showBcmrPopup, setShowBcmrPopup] = useState(false);
  // The registry exactly as the core wrote it, and the links it is published
  // under. Kept together so the bytes hashed are the bytes uploaded.
  const [bcmrAuthored, setBcmrAuthored] = useState<AuthoredBcmrRegistry | null>(
    null
  );
  const [bcmrUris, setBcmrUris] = useState<string[]>([]);
  const [bcmrNftKind, setBcmrNftKind] = useState<'parsable' | 'sequential'>(
    'parsable'
  );
  const [bcmrNftAdvanced, setBcmrNftAdvanced] = useState(false);
  const bcmrSuggestionRef = useRef<{ name: string; symbol: string } | null>(
    null
  );
  const network = useSelector(selectCurrentNetwork);
  const [bcmrTokenName, setBcmrTokenName] = useState('');
  const [bcmrTokenDescription, setBcmrTokenDescription] = useState('');
  const [bcmrTokenSymbol, setBcmrTokenSymbol] = useState('');
  const [bcmrTokenDecimals, setBcmrTokenDecimals] = useState('0');
  const [bcmrIconUri, setBcmrIconUri] = useState('');
  const [bcmrWebUri, setBcmrWebUri] = useState('');
  const [bcmrNftsDescription, setBcmrNftsDescription] = useState('');
  const [bcmrNftBytecode, setBcmrNftBytecode] = useState('');
  const [bcmrNftTypesJson, setBcmrNftTypesJson] = useState('');
  const [bcmrNftFieldsJson, setBcmrNftFieldsJson] = useState('');
  const [bcmrImageFile, setBcmrImageFile] = useState<File | null>(null);
  const [bcmrImageUpload, setBcmrImageUpload] =
    useState<IpfsUploadResult | null>(null);
  const [bcmrImageUploadStatus, setBcmrImageUploadStatus] =
    useState<BcmrUploadStatus>(IDLE_BCMR_UPLOAD_STATUS);
  const [bcmrRegistryUploadStatus, setBcmrRegistryUploadStatus] =
    useState<BcmrUploadStatus>(IDLE_BCMR_UPLOAD_STATUS);
  const [bcmrConfirmedFingerprint, setBcmrConfirmedFingerprint] =
    useState<string>('');
  const [bcmrFieldErrors, setBcmrFieldErrors] = useState<
    Partial<Record<BcmrFieldKey, string>>
  >({});
  const { contentClassName, runSmoothReset } = useSmoothResetTransition();

  const setErrorMessage = useCallback((value: string) => {
    dispatchFlow({ type: 'set_error', value });
  }, []);
  const setStatus = useCallback((value: string) => {
    dispatchFlow({ type: 'set_status', value });
  }, []);
  const setTxid = useCallback((value: string) => {
    dispatchFlow({ type: 'set_txid', value });
  }, []);
  const setLoading = useCallback((value: boolean) => {
    dispatchFlow({ type: 'set_loading', value });
  }, []);

  const setBcmrFieldError = useCallback(
    (field: BcmrFieldKey, value: string) => {
      setBcmrFieldErrors((prev) => ({ ...prev, [field]: value }));
    },
    []
  );

  const clearBcmrFieldErrors = useCallback(() => {
    setBcmrFieldErrors(EMPTY_BCMR_ERRORS);
  }, []);

  const refreshWalletSnapshot = useCallback(
    async (forceRefresh = false) => {
      if (!walletId) {
        setAddresses([]);
        setFlatUtxos([]);
        setChangeAddress('');
        return;
      }

      if (forceRefresh) {
        const walletSnapshot =
          await TransactionService.fetchAddressesAndUTXOs(walletId);
        const walletAddresses = walletSnapshot.addresses;
        await Promise.all(
          walletAddresses.map((walletAddress) =>
            UTXOService.fetchAndStoreUTXOs(
              walletId,
              walletAddress.address
            ).catch(() => null)
          )
        );
      }

      const refreshedSnapshot =
        await TransactionService.fetchAddressesAndUTXOs(walletId);
      const walletAddresses = refreshedSnapshot.addresses;

      setAddresses(walletAddresses);
      setChangeAddress((prev) => prev || walletAddresses[0]?.address || '');
      setFlatUtxos(mergeWalletUtxos(refreshedSnapshot));
    },
    [walletId]
  );

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await refreshWalletSnapshot();
      } catch (e: unknown) {
        if (!mounted) return;
        setErrorMessage(getErrorMessage(e, 'Failed to refresh wallet data.'));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [refreshWalletSnapshot, setErrorMessage]);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    []
  );

  useEffect(() => {
    if (addresses.length === 0) return;
    if (selectedRecipientCashAddrs.size > 0) return;
    const first = addresses[0].address;
    setSelectedRecipientCashAddrs(new Set([first]));
  }, [addresses, selectedRecipientCashAddrs]);

  const walletSourceCandidates: MintAppUtxo[] = useMemo(
    () => selectMintSourceUtxos(flatUtxos),
    [flatUtxos]
  );

  const primaryRecipientAddress = useMemo(
    () =>
      selectedRecipientCashAddrs.values().next().value ||
      addresses[0]?.address ||
      '',
    [selectedRecipientCashAddrs, addresses]
  );

  const bootstrapGenesisUtxos: MintDisplayUtxo[] = useMemo(() => {
    const addr = primaryRecipientAddress;
    return bootstrapTxids.filter(Boolean).map(
      (tx_hash): MintDisplayUtxo => ({
        tx_hash,
        tx_pos: 0,
        value: 1000,
        address: addr,
        height: 0,
        token: undefined,
        __synthetic: 'bootstrap',
      })
    );
  }, [bootstrapTxids, primaryRecipientAddress]);

  const displaySourceUtxos: MintDisplayUtxo[] = useMemo(() => {
    const all = [...bootstrapGenesisUtxos, ...walletSourceCandidates];
    const seen = new Set<string>();
    const out: MintAppUtxo[] = [];
    for (const u of all) {
      const k = utxoKey(u);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    return out;
  }, [bootstrapGenesisUtxos, walletSourceCandidates]);

  const displaySourceUtxoByKey = useMemo(() => {
    const out = new Map<string, MintDisplayUtxo>();
    for (const u of displaySourceUtxos) {
      out.set(utxoKey(u), u);
    }
    return out;
  }, [displaySourceUtxos]);

  const selectedUtxos: MintAppUtxo[] = useMemo(() => {
    if (selectedKeys.size === 0) return [];
    const out: MintAppUtxo[] = [];
    for (const key of selectedKeys) {
      const utxo = displaySourceUtxoByKey.get(key);
      if (utxo) out.push(utxo);
    }
    return out;
  }, [displaySourceUtxoByKey, selectedKeys]);

  useEffect(() => {
    setSelectedKeys((prev) => {
      const next = new Set(
        Array.from(prev).filter((key) => displaySourceUtxoByKey.has(key))
      );
      if (next.size === prev.size) return prev;
      return next;
    });
  }, [displaySourceUtxoByKey]);

  const selectedCount = selectedUtxos.length;
  const pendingCount = bootstrapGenesisUtxos.length;

  const orderedSelectedRecipients = useMemo(() => {
    const set = selectedRecipientCashAddrs;
    return addresses.map((a) => a.address).filter((addr) => set.has(addr));
  }, [addresses, selectedRecipientCashAddrs]);

  const selectedRecipientCount = orderedSelectedRecipients.length;

  // Metadata is published with every new token, and only then: spending the
  // genesis UTXO is what makes this transaction continue the new token's
  // identity chain. Validation allows one genesis source per mint.
  const genesisSources = useMemo(
    () => selectedUtxos.filter(isGenesisMintSource),
    [selectedUtxos]
  );
  const bcmrEnabled = genesisSources.length > 0;
  const bcmrAuthbase =
    genesisSources.length === 1 ? genesisSources[0].tx_hash : '';
  const bcmrTokenCategory = bcmrAuthbase;
  const bcmrRegistryJson = bcmrAuthored?.registryJson ?? '';
  const genesisSourceKey =
    genesisSources.length === 1 ? utxoKey(genesisSources[0]) : '';

  // NFTs this mint creates in the new category. A sequential registry names
  // each of them, so they are part of what the registry depends on.
  const genesisNftDrafts = useMemo(() => {
    const recipients = new Set(orderedSelectedRecipients);
    return outputDrafts.filter(
      (draft) =>
        draft.sourceKey === genesisSourceKey &&
        draft.config.mintType === 'NFT' &&
        recipients.has(draft.recipientCashAddr)
    );
  }, [outputDrafts, genesisSourceKey, orderedSelectedRecipients]);
  const bcmrHasNfts = genesisNftDrafts.length > 0;

  const bcmrFormFingerprint = useMemo(() => {
    const parsedDecimals = Number.parseInt(bcmrTokenDecimals, 10);
    const fingerprint: BcmrFormFingerprint = {
      authbase: bcmrAuthbase.trim().toLowerCase(),
      tokenCategory: bcmrTokenCategory.trim().toLowerCase(),
      tokenName: bcmrTokenName.trim(),
      tokenDescription: bcmrTokenDescription.trim(),
      tokenSymbol: bcmrTokenSymbol.trim(),
      tokenDecimals:
        Number.isFinite(parsedDecimals) && parsedDecimals >= 0
          ? parsedDecimals
          : -1,
      iconUri: bcmrIconUri.trim(),
      webUri: bcmrWebUri.trim(),
      network,
      hasNfts: bcmrHasNfts,
      nftKind: bcmrNftKind,
      nftAdvanced: bcmrNftAdvanced,
      nftCommitments: genesisNftDrafts
        .map((draft) => draft.config.nftCommitment.trim().toLowerCase())
        .sort(),
      nftsDescription: bcmrNftsDescription.trim(),
      nftBytecode: bcmrNftBytecode.trim(),
      nftTypesJson: bcmrNftTypesJson.trim(),
      nftFieldsJson: bcmrNftFieldsJson.trim(),
    };
    return JSON.stringify(fingerprint);
  }, [
    bcmrAuthbase,
    bcmrTokenCategory,
    bcmrTokenName,
    bcmrTokenDescription,
    bcmrTokenSymbol,
    bcmrTokenDecimals,
    bcmrIconUri,
    bcmrWebUri,
    network,
    bcmrHasNfts,
    bcmrNftKind,
    bcmrNftAdvanced,
    genesisNftDrafts,
    bcmrNftsDescription,
    bcmrNftBytecode,
    bcmrNftTypesJson,
    bcmrNftFieldsJson,
  ]);

  // Ready to mint when the registry was built from exactly the current form
  // and is verified on IPFS.
  const bcmrRegistryIsCurrent =
    bcmrAuthored !== null &&
    bcmrUris.length > 0 &&
    bcmrConfirmedFingerprint.length > 0 &&
    bcmrConfirmedFingerprint === bcmrFormFingerprint &&
    bcmrRegistryUploadStatus.phase === 'ready';

  const bcmrUploadsComplete = !bcmrEnabled || bcmrRegistryIsCurrent;

  const bcmrPublication = useMemo<MintBcmrPublication | undefined>(() => {
    if (!bcmrEnabled || !bcmrUploadsComplete) return undefined;
    return {
      enabled: true,
      registryJson: bcmrRegistryJson,
      uris: bcmrUris,
    };
  }, [bcmrEnabled, bcmrUploadsComplete, bcmrRegistryJson, bcmrUris]);

  // Checked as the user types: the schema only describes this rule in prose,
  // so no validator downstream would catch a bad symbol.
  const bcmrSymbolIssue = useMemo(
    () => bcmrSymbolProblem(bcmrTokenSymbol),
    [bcmrTokenSymbol]
  );

  const selectedSourceBcmrMetadata = useMemo(() => {
    for (const utxo of selectedUtxos) {
      if (utxo.token?.BcmrTokenMetadata) return utxo.token.BcmrTokenMetadata;
    }
    return null;
  }, [selectedUtxos]);
  const selectedSourceHasExistingBcmr = !!selectedSourceBcmrMetadata;

  // Prefill a name and symbol derived from the new token's category, so a
  // mint never waits on typing. A field is only replaced while it is empty or
  // still holds the previous suggestion; anything the user typed stays.
  useEffect(() => {
    if (!/^[0-9a-f]{64}$/i.test(bcmrAuthbase)) return;
    let next: { name: string; symbol: string };
    try {
      next = suggestBcmrIdentity(bcmrAuthbase, bcmrHasNfts);
    } catch {
      return;
    }
    const previous = bcmrSuggestionRef.current;
    setBcmrTokenName((current) =>
      !current.trim() || current === previous?.name ? next.name : current
    );
    setBcmrTokenSymbol((current) =>
      !current.trim() || current === previous?.symbol ? next.symbol : current
    );
    bcmrSuggestionRef.current = next;
  }, [bcmrAuthbase, bcmrHasNfts]);

  const recipientTokenAddressByCash = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of addresses) out[a.address] = a.tokenAddress;
    return out;
  }, [addresses]);

  // Keep the active step valid as the user edits earlier fields.
  useEffect(() => {
    if (selectedCount === 0 && step !== 1) setStep(1);
    else if (selectedCount > 0 && selectedRecipientCount === 0 && step === 3)
      setStep(2);
  }, [selectedCount, selectedRecipientCount, step]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [step]);

  useEffect(() => {
    setMountedSteps((prev) => {
      if (prev.has(step)) return prev;
      const next = new Set(prev);
      next.add(step);
      return next;
    });
  }, [step]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 1400);
  }, []);

  const copyText = useCallback(
    async (txt: string, label = 'Copied') => {
      const ok = await copyToClipboard(txt);
      showToast(ok ? label : 'Copy failed');
    },
    [showToast]
  );

  const sdkAddressBook = useMemo(
    () =>
      addresses.map((a) => ({
        address: a.address,
        tokenAddress: a.tokenAddress,
      })),
    [addresses]
  );

  /**
   * How NFT commitments of `source`'s category are laid out: the choice made
   * in this mint for a new token, or what the token's published metadata
   * says for an existing one. 'custom' means only raw hex makes sense.
   */
  const nftLayoutForSource = useCallback(
    (source: MintAppUtxo | null): 'parsable' | 'sequential' | 'custom' => {
      if (!source) return 'custom';
      if (isGenesisMintSource(source)) return bcmrNftKind;
      const nfts = source.token?.BcmrTokenMetadata?.token?.nfts;
      if (!nfts) return 'custom';
      const bytecode = nfts.parse?.bytecode;
      if (!bytecode) return 'sequential';
      return bytecode.toLowerCase() === defaultParseBytecode()
        ? 'parsable'
        : 'custom';
    },
    [bcmrNftKind]
  );

  const commitmentForSerial = useCallback(
    (layout: 'parsable' | 'sequential', serialText: string): string => {
      const trimmed = serialText.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new Error('NFT number must be a whole number.');
      }
      const serial = Number(trimmed);
      return layout === 'parsable'
        ? parsableNftCommitment(serial)
        : sequentialNftCommitment(serial);
    },
    []
  );

  // New collections count up from 1. For an existing token the numbers
  // already minted are not known here, so the user picks the next one.
  const nextNftSerial = useCallback(
    (source: MintAppUtxo | null): string => {
      if (!source || !isGenesisMintSource(source)) return '';
      const key = utxoKey(source);
      const used = outputDrafts
        .filter((draft) => draft.sourceKey === key && draft.config.nftSerial)
        .map((draft) => Number(draft.config.nftSerial))
        .filter(Number.isFinite);
      return String(used.length > 0 ? Math.max(...used) + 1 : 1);
    },
    [outputDrafts]
  );

  const openAddOutputDraftForm = useCallback(() => {
    const initialSource = selectedUtxos[0] ?? null;
    setEditingOutputDraftId(null);
    setOutputFormRecipient(
      selectedRecipientCashAddrs.values().next().value ||
        addresses[0]?.address ||
        ''
    );
    setOutputFormSourceKey(initialSource ? utxoKey(initialSource) : '');
    setOutputFormMintType(
      initialSource && canMintFungibleFromSource(initialSource) ? 'FT' : 'NFT'
    );
    setOutputFormFtAmount('1');
    setOutputFormNftCapability('none');
    setOutputFormNftCommitment('');
    setOutputFormNftSerial(nextNftSerial(initialSource));
    setOutputFormCommitmentMode(
      nftLayoutForSource(initialSource) === 'custom' ? 'custom' : 'serial'
    );
    setShowOutputPopup(true);
  }, [
    addresses,
    nextNftSerial,
    nftLayoutForSource,
    selectedRecipientCashAddrs,
    selectedUtxos,
  ]);

  const openEditOutputDraftForm = useCallback((draft: MintOutputDraft) => {
    setEditingOutputDraftId(draft.id);
    setOutputFormRecipient(draft.recipientCashAddr);
    setOutputFormSourceKey(draft.sourceKey);
    setOutputFormMintType(draft.config.mintType);
    setOutputFormFtAmount(draft.config.ftAmount);
    setOutputFormNftCapability(draft.config.nftCapability);
    setOutputFormNftCommitment(draft.config.nftCommitment);
    setOutputFormNftSerial(draft.config.nftSerial ?? '');
    setOutputFormCommitmentMode(draft.config.nftSerial ? 'serial' : 'custom');
    setShowOutputPopup(true);
  }, []);

  const saveOutputDraftForm = useCallback(() => {
    if (!outputFormRecipient || !outputFormSourceKey) return;
    const source = selectedUtxos.find(
      (utxo) => utxoKey(utxo) === outputFormSourceKey
    );
    if (!source) {
      setErrorMessage('Select a valid source UTXO first.');
      return;
    }
    if (!canMintFungibleFromSource(source) && outputFormMintType === 'FT') {
      setErrorMessage('Minting authority sources can only mint NFT outputs.');
      return;
    }

    let nftCommitment = '';
    let nftSerial: string | undefined;
    if (outputFormMintType === 'NFT') {
      const layout = nftLayoutForSource(source);
      if (outputFormCommitmentMode === 'serial' && layout !== 'custom') {
        try {
          nftCommitment = commitmentForSerial(layout, outputFormNftSerial);
          nftSerial = outputFormNftSerial.trim();
        } catch (e: unknown) {
          setErrorMessage(getErrorMessage(e, 'Invalid NFT number.'));
          return;
        }
      } else {
        nftCommitment = outputFormNftCommitment.trim().toLowerCase();
        if (
          !/^[0-9a-f]*$/.test(nftCommitment) ||
          nftCommitment.length % 2 !== 0 ||
          nftCommitment.length / 2 > 128
        ) {
          setErrorMessage(
            'Commitment must be even-length hex, at most 128 bytes.'
          );
          return;
        }
      }
    }

    const nextDraft = {
      recipientCashAddr: outputFormRecipient,
      sourceKey: outputFormSourceKey,
      config: {
        mintType: outputFormMintType,
        ftAmount: outputFormMintType === 'FT' ? outputFormFtAmount : '1',
        nftCapability:
          outputFormMintType === 'NFT' ? outputFormNftCapability : 'none',
        nftCommitment,
        nftSerial,
      },
    };
    if (editingOutputDraftId) {
      setOutputDrafts((prev) =>
        prev.map((draft) =>
          draft.id === editingOutputDraftId ? { ...draft, ...nextDraft } : draft
        )
      );
    } else {
      const id = `draft-${Date.now()}-${draftSeq.current++}`;
      setOutputDrafts((prev) => [...prev, { id, ...nextDraft }]);
    }
    setShowOutputPopup(false);
  }, [
    commitmentForSerial,
    editingOutputDraftId,
    nftLayoutForSource,
    outputFormCommitmentMode,
    outputFormFtAmount,
    outputFormMintType,
    outputFormNftCapability,
    outputFormNftCommitment,
    outputFormNftSerial,
    outputFormRecipient,
    outputFormSourceKey,
    selectedUtxos,
    setErrorMessage,
  ]);

  // Switching a new collection between parsable and sequential changes how
  // every numbered NFT's commitment is written, so rebuild those drafts.
  // Custom-hex drafts are the user's own bytes and stay as typed.
  useEffect(() => {
    if (!genesisSourceKey) return;
    setOutputDrafts((prev) => {
      let changed = false;
      const next = prev.map((draft) => {
        if (
          draft.sourceKey !== genesisSourceKey ||
          draft.config.mintType !== 'NFT' ||
          !draft.config.nftSerial
        ) {
          return draft;
        }
        const nftCommitment = commitmentForSerial(
          bcmrNftKind,
          draft.config.nftSerial
        );
        if (nftCommitment === draft.config.nftCommitment) return draft;
        changed = true;
        return { ...draft, config: { ...draft.config, nftCommitment } };
      });
      return changed ? next : prev;
    });
  }, [bcmrNftKind, commitmentForSerial, genesisSourceKey]);

  const removeOutputDraft = useCallback((id: string) => {
    setOutputDrafts((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const deleteOutputDraftForm = useCallback(() => {
    if (!editingOutputDraftId) return;
    removeOutputDraft(editingOutputDraftId);
    setEditingOutputDraftId(null);
    setShowOutputPopup(false);
  }, [editingOutputDraftId, removeOutputDraft]);

  const toggleRecipient = useCallback((cashAddr: string) => {
    setSelectedRecipientCashAddrs((prev) => {
      const next = new Set(prev);
      if (next.has(cashAddr)) {
        next.delete(cashAddr);
      } else {
        next.add(cashAddr);
      }
      return next;
    });
  }, []);

  const toggleSelect = useCallback((u: MintAppUtxo) => {
    const key = utxoKey(u);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedSourceKeySet = useMemo(
    () => new Set(selectedKeys),
    [selectedKeys]
  );

  const outputFormSource = useMemo(
    () =>
      selectedUtxos.find((utxo) => utxoKey(utxo) === outputFormSourceKey) ??
      null,
    [outputFormSourceKey, selectedUtxos]
  );
  const outputFormSourceKind = outputFormSource
    ? getMintSourceKind(outputFormSource)
    : null;
  const outputFormAllowsFungible = outputFormSource
    ? canMintFungibleFromSource(outputFormSource)
    : false;
  const outputFormLayout = nftLayoutForSource(outputFormSource);
  const outputFormCommitmentPreview = useMemo(() => {
    if (outputFormLayout === 'custom') return '';
    try {
      return commitmentForSerial(outputFormLayout, outputFormNftSerial);
    } catch {
      return '';
    }
  }, [commitmentForSerial, outputFormLayout, outputFormNftSerial]);

  useEffect(() => {
    if (!outputFormAllowsFungible && outputFormMintType === 'FT') {
      setOutputFormMintType('NFT');
    }
  }, [outputFormAllowsFungible, outputFormMintType]);

  const canGoToStep = useCallback(
    (n: 1 | 2 | 3) => {
      if (n === 1) return true;
      if (n === 2) return selectedCount > 0;
      return selectedCount > 0 && selectedRecipientCount > 0;
    },
    [selectedCount, selectedRecipientCount]
  );

  const handleContinueStep = useCallback(() => {
    setStep((curr) => (curr === 1 ? 2 : 3));
  }, []);

  const selectedRecipientSet = useMemo(
    () => new Set(orderedSelectedRecipients),
    [orderedSelectedRecipients]
  );

  const activeOutputDrafts = useMemo(
    () =>
      filterActiveOutputDrafts(
        outputDrafts,
        selectedRecipientSet,
        selectedSourceKeySet
      ),
    [outputDrafts, selectedRecipientSet, selectedSourceKeySet]
  );

  const openConfirm = useCallback(
    (opts: {
      title: string;
      subtitle: string;
      warning?: React.ReactNode;
      body: React.ReactNode;
      onConfirm: () => Promise<void>;
    }) => {
      pendingConfirmActionRef.current = opts.onConfirm;
      setConfirmState({
        open: true,
        loading: false,
        title: opts.title,
        subtitle: opts.subtitle,
        warning: opts.warning ?? null,
        body: opts.body,
      });
    },
    []
  );

  const setConfirmLoading = useCallback((value: boolean) => {
    setConfirmState((prev) =>
      prev.loading === value ? prev : { ...prev, loading: value }
    );
  }, []);

  const closeConfirm = useCallback(() => {
    setConfirmState((prev) => ({ ...prev, open: false }));
  }, []);

  const resetFlowMessages = useCallback(() => {
    dispatchFlow({ type: 'reset_messages' });
  }, []);

  const resetMintComposer = useCallback(() => {
    setSelectedKeys(new Set());
    setOutputDrafts([]);
    setBootstrapTxids([]);
    setMountedSteps(new Set([1]));
    setStep(1);
    setSelectedRecipientCashAddrs(
      addresses[0]?.address ? new Set([addresses[0].address]) : new Set()
    );
    draftSeq.current = 0;
    setBcmrAuthored(null);
    setBcmrUris([]);
    setBcmrNftKind('parsable');
    setBcmrNftAdvanced(false);
    bcmrSuggestionRef.current = null;
    setBcmrRegistryUploadStatus(IDLE_BCMR_UPLOAD_STATUS);
    setBcmrConfirmedFingerprint('');
    setBcmrTokenName('');
    setBcmrTokenDescription('');
    setBcmrTokenSymbol('');
    setBcmrTokenDecimals('0');
    setBcmrIconUri('');
    setBcmrWebUri('');
    setBcmrNftsDescription('');
    setBcmrNftBytecode('');
    setBcmrNftTypesJson('');
    setBcmrNftFieldsJson('');
    setBcmrImageFile(null);
    setBcmrImageUpload(null);
    clearBcmrFieldErrors();
  }, [addresses, clearBcmrFieldErrors]);

  const startBootstrapFlow = useCallback(async () => {
    resetFlowMessages();

    if (!walletId || walletId <= 0) {
      setErrorMessage('No wallet selected.');
      return;
    }
    if (!changeAddress) {
      setErrorMessage('Change address not ready.');
      return;
    }

    const myAddress = orderedSelectedRecipients[0] || addresses[0]?.address;
    if (!myAddress) {
      setErrorMessage('No wallet address available.');
      return;
    }

    // Create exactly one category-defining UTXO per transaction.
    // Fee inputs are strictly non-genesis (vout != 0) and non-token UTXOs.
    const feeCandidates = selectFeeCandidates(flatUtxos);
    if (feeCandidates.length === 0) {
      setErrorMessage(
        'No fee UTXOs available. Need a non-token fee UTXO with vout != 0; category sources still begin as genesis vout = 0 UTXOs.'
      );
      return;
    }

    setLoading(true);
    try {
      const fundingUtxos = [feeCandidates[0]];
      const { built, feePaid } = await buildBootstrapPreview({
        fundingUtxos,
        toAddress: myAddress,
        changeAddress,
      });

      openConfirm({
        title: 'Create Category Source',
        // subtitle: 'Creates one new vout=0 source with 1000 sats.',
        subtitle: '',
        warning: 'This will broadcast immediately after confirmation.',
        body: (
          <TxSummary
            inputs={asTxSummaryInputs(fundingUtxos)}
            outputs={asTxSummaryOutputs(built.finalOutputs)}
            bytes={built.bytes}
            fee={feePaid}
          />
        ),
        onConfirm: async () => {
          setConfirmLoading(true);
          try {
            setStatus('Broadcasting category source creation...');
            const sent = await TransactionService.sendTransaction(
              built.finalTransaction
            );
            const sentTxid = sent?.txid ?? '';
            if (!sentTxid)
              throw new Error(
                sent?.errorMessage || 'Broadcast returned no txid.'
              );

            const submitted = sent.broadcastState === 'submitted';
            closeConfirm();
            setTxid(sentTxid);
            setStatus(
              submitted
                ? 'Category source submitted. Refreshing wallet data...'
                : 'Category source created. Refreshing wallet data...'
            );
            showToast(
              submitted
                ? 'Category source submitted'
                : 'Category source created'
            );

            let refreshFailed = false;
            try {
              await refreshWalletSnapshot(true);
            } catch (refreshError) {
              refreshFailed = true;
              console.error(refreshError);
            }

            await runSmoothReset(async () => {
              resetMintComposer();
            });
            setStatus(
              refreshFailed
                ? submitted
                  ? 'Category source submitted. Wallet refresh failed; keep the txid and refresh manually.'
                  : 'Category source created. Wallet refresh failed; refresh manually.'
                : submitted
                  ? 'Category source submitted. Keep the txid and avoid sending it again.'
                  : 'Category source created. Returned to the start screen.'
            );
          } finally {
            setConfirmLoading(false);
          }
        },
      });
    } catch (e: unknown) {
      console.error(e);
      setErrorMessage(getErrorMessage(e, 'Bootstrap failed.'));
      setStatus('');
    } finally {
      setLoading(false);
    }
  }, [
    resetFlowMessages,
    walletId,
    changeAddress,
    orderedSelectedRecipients,
    addresses,
    flatUtxos,
    setErrorMessage,
    setLoading,
    openConfirm,
    setStatus,
    setTxid,
    showToast,
    refreshWalletSnapshot,
    closeConfirm,
    setConfirmLoading,
    resetMintComposer,
    runSmoothReset,
  ]);

  /**
   * Build mint tx:
   * - inputs: selected source UTXOs (genesis or minting authority NFT) + fee utxos (vout!=0 && !token)
   * - outputs: N token outputs + auto change
   * Enforce 1 sat/byte by builder.
   */
  const prepareMint = useCallback(
    async (freshPublication?: MintBcmrPublication) => {
      resetFlowMessages();
      const publication = freshPublication ?? bcmrPublication;
      const validationError = validateMintRequest({
        walletId,
        selectedRecipientCount,
        changeAddress,
        selectedUtxos,
        activeOutputDrafts,
        selectedRecipientSet,
        selectedSourceKeySet,
      });
      if (validationError) {
        setErrorMessage(validationError);
        return;
      }
      if (bcmrEnabled) {
        if (
          bcmrImageUploadStatus.phase === 'uploading' ||
          bcmrImageUploadStatus.phase === 'verifying' ||
          bcmrRegistryUploadStatus.phase === 'uploading' ||
          bcmrRegistryUploadStatus.phase === 'verifying'
        ) {
          setErrorMessage(
            'Wait for the BCMR IPFS upload to finish before minting.'
          );
          return;
        }
        if (!publication) {
          setErrorMessage(
            'Token metadata is not published yet. Publish it before minting.'
          );
          return;
        }
      }

      setLoading(true);
      setStatus('Preparing transaction for review...');

      try {
        const { built, inputsForBuild, feePaid } = await buildMintPreview({
          selectedUtxos,
          flatUtxos,
          activeOutputDrafts,
          changeAddress,
          sdkAddressBook,
          tokenOutputSats: TOKEN_OUTPUT_SATS,
          bcmrPublication: bcmrEnabled ? publication : undefined,
        });

        openConfirm({
          title: `Confirm mint (${activeOutputDrafts.length} output${
            activeOutputDrafts.length === 1 ? '' : 's'
          })`,
          subtitle: 'Fee policy: 1 sat/byte. Review before broadcast.',
          warning: (
            <>
              {addonT(
                'module.broadcastWarning',
                'This will broadcast immediately after confirmation.'
              )}
            </>
          ),
          body: (
            <TxSummary
              inputs={asTxSummaryInputs(inputsForBuild)}
              outputs={asTxSummaryOutputs(built.finalOutputs)}
              bytes={built.bytes}
              fee={feePaid}
            />
          ),
          onConfirm: async () => {
            setConfirmLoading(true);
            try {
              setStatus('Broadcasting mint transaction...');
              const sent = await TransactionService.sendTransaction(
                built.finalTransaction
              );
              const sentTxid = sent?.txid ?? '';
              if (!sentTxid)
                throw new Error(sent?.errorMessage || 'Broadcast failed.');
              const submitted = sent.broadcastState === 'submitted';
              closeConfirm();
              setTxid(sentTxid);
              setStatus(
                submitted
                  ? 'Mint transaction submitted. Refreshing wallet data...'
                  : 'Mint successful. Refreshing wallet data...'
              );
              showToast(submitted ? 'Transaction submitted' : 'Broadcasted');

              let refreshFailed = false;
              try {
                await refreshWalletSnapshot(true);
              } catch (refreshError) {
                refreshFailed = true;
                console.error(refreshError);
              }

              await runSmoothReset(async () => {
                resetMintComposer();
              });
              setStatus(
                refreshFailed
                  ? submitted
                    ? 'Mint transaction submitted. Wallet refresh failed; keep the txid and refresh manually.'
                    : 'Mint successful. Wallet refresh failed; refresh manually.'
                  : submitted
                    ? 'Mint transaction submitted. Keep the txid and avoid sending it again.'
                    : 'Mint successful. Returned to the start screen.'
              );
            } finally {
              setConfirmLoading(false);
            }
          },
        });

        setStatus('');
      } catch (e: unknown) {
        console.error(e);
        setErrorMessage(getErrorMessage(e, 'Mint failed.'));
        setStatus('');
      } finally {
        setLoading(false);
      }
    },
    [
      resetFlowMessages,
      walletId,
      selectedRecipientCount,
      changeAddress,
      selectedUtxos,
      activeOutputDrafts,
      selectedRecipientSet,
      selectedSourceKeySet,
      bcmrEnabled,
      bcmrImageUploadStatus.phase,
      bcmrRegistryUploadStatus.phase,
      setErrorMessage,
      setLoading,
      setStatus,
      flatUtxos,
      sdkAddressBook,
      bcmrPublication,
      openConfirm,
      setTxid,
      closeConfirm,
      showToast,
      addonT,
      refreshWalletSnapshot,
      setConfirmLoading,
      resetMintComposer,
      runSmoothReset,
    ]
  );

  const handleCopyRecipientAddress = useCallback(
    (addr: string) => {
      void copyText(addr, 'Recipient copied');
    },
    [copyText]
  );

  const handleCopyCategory = useCallback(
    (category: string) => {
      void copyText(category, 'Category copied');
    },
    [copyText]
  );

  // The form is always prefilled, so opening the editor only reveals it.
  const openBcmrEditor = useCallback(() => {
    clearBcmrFieldErrors();
    setShowBcmrPopup(true);
  }, [clearBcmrFieldErrors]);

  const handleJumpToAmounts = useCallback(() => {
    setStep(3);
  }, []);

  const mapBcmrErrorToField = useCallback((message: string): BcmrFieldKey => {
    const lower = message.toLowerCase();
    if (lower.includes('token category')) return 'tokenCategory';
    if (lower.includes('token name')) return 'tokenName';
    if (lower.includes('token symbol')) return 'tokenSymbol';
    if (lower.includes('decimals')) return 'tokenDecimals';
    if (lower.includes('icon')) return 'iconUri';
    if (lower.includes('official site') || lower.includes('web'))
      return 'webUri';
    if (lower.includes('uri')) return 'registry';
    if (lower.includes('bytecode')) return 'nftBytecode';
    if (lower.includes('nft type')) return 'nftTypes';
    if (lower.includes('nft field')) return 'nftFields';
    return 'general';
  }, []);

  const handleUploadBcmrImage = useCallback(async () => {
    setBcmrFieldErrors((prev) => ({
      ...prev,
      image: undefined,
      iconUri: undefined,
    }));
    if (!bcmrImageFile) {
      setBcmrFieldError('image', 'Select an image file first.');
      return;
    }
    setBcmrImageUploadStatus({
      phase: 'uploading',
      message: 'Uploading image to IPFS...',
    });
    setLoading(true);
    try {
      const result = await uploadToIpfsRelay(bcmrImageFile, {
        filename: bcmrImageFile.name,
      });
      const ipfsUri = `ipfs://${result.cid}`;
      setBcmrImageUploadStatus({
        phase: 'verifying',
        message: 'Waiting for the image to be reachable from IPFS...',
      });
      await waitForIpfsAvailability(ipfsUri, {
        timeoutMs: 45_000,
        pollIntervalMs: 1_500,
        validateResponse: async (response) => {
          const contentType = response.headers.get('content-type') ?? '';
          if (
            contentType &&
            !contentType.toLowerCase().startsWith('image/') &&
            !contentType.toLowerCase().startsWith('application/octet-stream')
          ) {
            throw new Error(`Unexpected image content type: ${contentType}`);
          }
          await response.arrayBuffer();
        },
      });
      setBcmrImageUpload(result);
      setBcmrIconUri(ipfsUri);
      setBcmrConfirmedFingerprint('');
      setBcmrImageUploadStatus({
        phase: 'ready',
        message: 'Image uploaded and verified on IPFS.',
      });
      setStatus('Image uploaded to IPFS.');
    } catch (e: unknown) {
      setBcmrImageUploadStatus({
        phase: 'error',
        message: getErrorMessage(e, 'Failed to upload image to IPFS.'),
      });
      setBcmrFieldError(
        'image',
        getErrorMessage(e, 'Failed to upload image to IPFS.')
      );
    } finally {
      setLoading(false);
    }
  }, [bcmrImageFile, setBcmrFieldError, setLoading, setStatus]);

  /**
   * Author the registry in the core, upload it, and return what the mint
   * transaction should publish — or null, with the reason shown, when it is
   * not ready. Called from the editor and, when nothing is published yet,
   * directly from "Review & mint", so a mint never needs a separate step.
   */
  const handleConfirmBcmr =
    useCallback(async (): Promise<MintBcmrPublication | null> => {
      const parsedDecimals = Number.parseInt(bcmrTokenDecimals, 10);
      const trimmedNftTypes = bcmrNftTypesJson.trim();
      const trimmedNftFields = bcmrNftFieldsJson.trim();
      const nextErrors: Partial<Record<BcmrFieldKey, string>> = {};

      if (
        genesisSources.length !== 1 ||
        !/^[0-9a-f]{64}$/i.test(bcmrAuthbase)
      ) {
        nextErrors.general =
          'Token metadata needs exactly one genesis source for the new token.';
      }
      if (!Number.isFinite(parsedDecimals) || parsedDecimals < 0) {
        nextErrors.tokenDecimals =
          'Decimals must be a whole number from 0 to 18.';
      }
      const parseJsonObject = (
        text: string,
        field: BcmrFieldKey,
        message: string
      ) => {
        if (!text) return undefined;
        try {
          const parsed: unknown = JSON.parse(text);
          if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
            return parsed as Record<string, never>;
          }
        } catch {
          // Reported below.
        }
        nextErrors[field] = message;
        return undefined;
      };

      let nfts: BcmrNftsSchemaInput | undefined;
      if (bcmrHasNfts && bcmrNftKind === 'sequential') {
        // A sequential registry names every NFT, keyed by its exact commitment.
        const types: Record<string, { name: string }> = {};
        for (const draft of genesisNftDrafts) {
          const key = draft.config.nftCommitment.trim().toLowerCase();
          types[key] = {
            name: draft.config.nftSerial
              ? `#${draft.config.nftSerial}`
              : key
                ? `NFT ${key}`
                : '#0',
          };
        }
        nfts = {
          kind: 'sequential',
          description: bcmrNftsDescription.trim(),
          types,
        };
      } else if (bcmrHasNfts) {
        nfts = { kind: 'parsable', description: bcmrNftsDescription.trim() };
        if (bcmrNftAdvanced) {
          const bytecode = bcmrNftBytecode.trim();
          if (bytecode) nfts.bytecode = bytecode;
          const types = parseJsonObject(
            trimmedNftTypes,
            'nftTypes',
            'NFT types must be valid JSON: an object of type keys.'
          );
          if (types) nfts.types = types;
          const fields = parseJsonObject(
            trimmedNftFields,
            'nftFields',
            'NFT fields must be valid JSON: an object of field identifiers.'
          );
          if (fields) nfts.fields = fields;
        }
      }

      if (Object.keys(nextErrors).length > 0) {
        setBcmrFieldErrors(nextErrors);
        setShowBcmrPopup(true);
        return null;
      }

      clearBcmrFieldErrors();
      setBcmrRegistryUploadStatus({
        phase: 'uploading',
        message: 'Uploading token metadata to IPFS...',
      });

      setLoading(true);
      try {
        let authored: AuthoredBcmrRegistry;
        try {
          authored = generateBcmrRegistry({
            network,
            baseRegistry: await (async () => {
              try {
                const existing =
                  await bcmrService.resolveIdentityRegistry(bcmrAuthbase);
                return existing.registry;
              } catch (error) {
                if (isBcmrRegistryNotFoundError(error)) return undefined;
                throw error;
              }
            })(),
            authbase: bcmrAuthbase,
            tokenCategory: bcmrTokenCategory,
            tokenName: bcmrTokenName,
            tokenDescription: bcmrTokenDescription,
            tokenSymbol: bcmrTokenSymbol,
            tokenDecimals: parsedDecimals,
            iconUri: bcmrIconUri,
            webUri: bcmrWebUri,
            nfts,
          });
        } catch (e: unknown) {
          const message = getErrorMessage(e, 'Could not build token metadata.');
          const field =
            e instanceof BcmrRegistryError
              ? e.field
              : mapBcmrErrorToField(message);
          setBcmrRegistryUploadStatus({ phase: 'error', message });
          setBcmrFieldError(field as BcmrFieldKey, message);
          setShowBcmrPopup(true);
          return null;
        }

        // From here the registry is fixed: its hash and link are known, so
        // even a failed upload can be finished later without changing the mint.
        setBcmrAuthored(authored);
        setBcmrConfirmedFingerprint(bcmrFormFingerprint);
        setBcmrUris([authored.ipfsUri]);

        try {
          const result = await uploadToIpfsRelay(
            new Blob([authored.registryJson], { type: 'application/json' }),
            { filename: 'bitcoin-cash-metadata-registry.json', rawCid: true }
          );
          const relayUri = `ipfs://${result.cid}`;
          setBcmrRegistryUploadStatus({
            phase: 'verifying',
            message:
              'Waiting for the token metadata to be reachable from IPFS...',
          });
          await waitForIpfsAvailability(relayUri, {
            timeoutMs: 45_000,
            pollIntervalMs: 1_500,
            validateResponse: async (response) => {
              const body = await response.text();
              if (sha256.text(body) !== authored.sha256) {
                throw new Error(
                  'Uploaded token metadata is reachable but does not match the expected content.'
                );
              }
            },
          });

          // OPTN's upload relay currently answers with a CIDv0 link, not the
          // raw CIDv1 computed from the bytes. The link it actually serves
          // goes first; the computed one follows so anyone re-adding the
          // file with cid-version=1 makes it resolve too.
          const uris =
            result.cid === authored.ipfsCid
              ? [authored.ipfsUri]
              : [relayUri, authored.ipfsUri];
          setBcmrUris(uris);
          setBcmrRegistryUploadStatus({
            phase: 'ready',
            message: 'Token metadata uploaded and verified on IPFS.',
          });
          showToast('Token metadata uploaded and verified on IPFS.');
          setShowBcmrPopup(false);
          return { enabled: true, registryJson: authored.registryJson, uris };
        } catch (e: unknown) {
          const message = getErrorMessage(
            e,
            'Failed to upload token metadata.'
          );
          setBcmrRegistryUploadStatus({ phase: 'error', message });
          setBcmrFieldError('registry', message);
          return null;
        }
      } finally {
        setLoading(false);
      }
    }, [
      bcmrTokenDecimals,
      bcmrNftTypesJson,
      bcmrNftFieldsJson,
      genesisSources.length,
      bcmrAuthbase,
      bcmrHasNfts,
      bcmrNftKind,
      genesisNftDrafts,
      bcmrNftsDescription,
      bcmrNftAdvanced,
      bcmrNftBytecode,
      clearBcmrFieldErrors,
      network,
      bcmrService,
      bcmrTokenCategory,
      bcmrTokenName,
      bcmrTokenDescription,
      bcmrTokenSymbol,
      bcmrIconUri,
      bcmrWebUri,
      mapBcmrErrorToField,
      setBcmrFieldError,
      bcmrFormFingerprint,
      setLoading,
      showToast,
    ]);

  const handleReviewAndMint = useCallback(async () => {
    if (bcmrEnabled && !bcmrUploadsComplete) {
      const publication = await handleConfirmBcmr();
      if (!publication) return;
      await prepareMint(publication);
      return;
    }
    await prepareMint();
  }, [bcmrEnabled, bcmrUploadsComplete, handleConfirmBcmr, prepareMint]);

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] min-h-0 px-4 pt-4 pb-[calc(var(--safe-bottom)+1rem)] flex flex-col overflow-hidden wallet-page">
      <div className="flex-none space-y-4">
        <div className="flex justify-center">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="OPTN"
            className="h-auto w-full max-w-[260px] object-contain"
          />
        </div>

        {toast ? (
          <div className="px-3 py-2 rounded-xl wallet-popup-panel text-xs font-semibold">
            {toast}
          </div>
        ) : null}
      </div>

      <div
        className={`flex-1 min-h-0 overflow-y-auto overscroll-contain pt-4 pr-1 ${contentClassName}`}
      >
        <div className="space-y-6">
          {/* Stepper */}
          <Stepper step={step} canGoTo={canGoToStep} onStep={setStep} />

          {/* Step content (one screen per step for mobile) */}
          <div className="relative overflow-hidden">
            <div
              className="flex transition-all duration-300 ease-out"
              style={{
                width: '300%',
                transform:
                  step === 1
                    ? 'translateX(0%)'
                    : step === 2
                      ? 'translateX(-33.3333%)'
                      : 'translateX(-66.6666%)',
              }}
            >
              <div
                className={`w-1/3 px-1 shrink-0 transition-opacity duration-300 ${
                  step === 2 ? 'opacity-100' : 'opacity-80'
                }`}
                style={{ order: 2 }}
              >
                {mountedSteps.has(2) ? (
                  <RecipientsStepCard
                    addresses={addresses}
                    selectedRecipientCashAddrs={selectedRecipientCashAddrs}
                    recipientTokenAddressByCash={recipientTokenAddressByCash}
                    selectedRecipientCount={selectedRecipientCount}
                    onToggleRecipient={toggleRecipient}
                    onCopyAddress={handleCopyRecipientAddress}
                  />
                ) : null}
              </div>

              <div
                className={`w-1/3 px-1 shrink-0 transition-opacity duration-300 ${
                  step === 1 ? 'opacity-100' : 'opacity-80'
                }`}
                style={{ order: 1 }}
              >
                {mountedSteps.has(1) ? (
                  <SourcesStepCard
                    displaySourceUtxos={displaySourceUtxos}
                    selectedKeys={selectedKeys}
                    selectedCount={selectedCount}
                    pendingCount={pendingCount}
                    loading={loading}
                    canCreateSource={!!changeAddress}
                    showCreateSourceAction={true}
                    onStartBootstrapFlow={startBootstrapFlow}
                    onToggleSelect={toggleSelect}
                    onCopyCategory={handleCopyCategory}
                    onJumpToAmounts={handleJumpToAmounts}
                  />
                ) : null}
              </div>

              <div
                className={`w-1/3 px-1 shrink-0 transition-opacity duration-300 ${
                  step === 3 ? 'opacity-100' : 'opacity-80'
                }`}
                style={{ order: 3 }}
              >
                {mountedSteps.has(3) ? (
                  <AmountsStepCard
                    selectedUtxos={selectedUtxos}
                    selectedRecipientCount={selectedRecipientCount}
                    outputDrafts={outputDrafts}
                    onOpenAddOutputDraftForm={openAddOutputDraftForm}
                    onOpenEditOutputDraftForm={openEditOutputDraftForm}
                  />
                ) : null}
                {mountedSteps.has(3) ? (
                  <div className="mt-4 wallet-card rounded-[20px] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold">
                        {addonT('common.tokenMetadata', 'Token metadata')}
                      </h3>
                      {bcmrEnabled ? (
                        <Badge tone={bcmrUploadsComplete ? 'green' : 'amber'}>
                          {!bcmrUploadsComplete
                            ? addonT(
                                'module.bcmrWithMint',
                                'Published with mint'
                              )
                            : addonT('module.bcmrReady', 'Ready')}
                        </Badge>
                      ) : selectedSourceHasExistingBcmr ? (
                        <Badge tone="green">
                          {addonT('module.bcmrPresent', 'BCMR already present')}
                        </Badge>
                      ) : null}
                    </div>
                    {bcmrEnabled ? (
                      <>
                        <p className="text-sm wallet-muted">
                          {addonT(
                            'module.bcmrAlwaysPublished',
                            'Every new token is published with its metadata. The fields are prefilled; edit them if you like.'
                          )}
                        </p>
                        <div className="text-sm">
                          <span className="font-semibold">
                            {bcmrTokenName || '—'}
                          </span>
                          {' · '}
                          <span className="font-mono">
                            {bcmrTokenSymbol || '—'}
                          </span>
                          {bcmrHasNfts
                            ? ` · ${
                                bcmrNftKind === 'parsable'
                                  ? addonT('module.parsable', 'Parsable')
                                  : addonT('module.sequential', 'Sequential')
                              }`
                            : null}
                        </div>
                        <button
                          type="button"
                          onClick={openBcmrEditor}
                          className="wallet-btn-secondary px-3 py-2 text-sm"
                        >
                          {addonT('common.editMetadata', 'Edit metadata')}
                        </button>
                        {bcmrRegistryUploadStatus.phase === 'error' &&
                        bcmrAuthored ? (
                          <div className="rounded-xl wallet-surface-strong p-3 space-y-2 text-sm">
                            <p className="wallet-danger-text">
                              {bcmrRegistryUploadStatus.message}
                            </p>
                            <div>
                              <button
                                type="button"
                                disabled={loading}
                                onClick={() => void handleConfirmBcmr()}
                                className="wallet-btn-secondary px-3 py-2 text-sm disabled:opacity-50"
                              >
                                {addonT('module.retryUpload', 'Retry upload')}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="text-sm wallet-muted">
                        {addonT(
                          'module.bcmrFromAuthority',
                          'Minting from an existing token keeps its current metadata. Metadata is published when a new token is created.'
                        )}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Status / errors */}
          {(errorMessage || status || txid) && (
            <div className="rounded-2xl border border-[var(--wallet-border)] wallet-card shadow-sm p-4 space-y-2">
              {errorMessage && (
                <div className="rounded-xl bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-sm p-3">
                  {errorMessage}
                </div>
              )}
              {status && (
                <div className="rounded-xl wallet-surface-strong text-sm p-3">
                  {status}
                </div>
              )}
              {txid && (
                <div className="rounded-xl wallet-surface-strong text-sm p-3 break-all">
                  <div className="font-semibold flex items-center justify-between">
                    Broadcast txid
                    <button
                      type="button"
                      className="text-sm font-semibold text-blue-500"
                      onClick={() => copyText(txid, 'Txid copied')}
                    >
                      Copy
                    </button>
                  </div>
                  <div className="font-mono text-xs mt-1">{txid}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Sticky bottom “wallet-style” action bar */}
      <div className="mt-auto flex-none pt-3 space-y-3">
        <div className="rounded-[22px] wallet-card shadow-[0_10px_30px_rgba(0,0,0,0.12)] p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {step === 1
                  ? 'Step 1: Source UTXOs'
                  : step === 2
                    ? 'Step 2: Recipients'
                    : `Step 3: Amounts (${activeOutputDrafts.length} outputs)`}
              </div>
              {/* <div className="text-[12px] text-gray-500">
                Fee policy: 1 sat/byte • Change: auto
              </div> */}
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={selectedRecipientCount > 0 ? 'green' : 'gray'}>
                {selectedRecipientCount > 0
                  ? `${selectedRecipientCount} recipient${
                      selectedRecipientCount === 1 ? '' : 's'
                    }`
                  : 'No recipients'}
              </Badge>
              <Badge tone={selectedCount > 0 ? 'green' : 'gray'}>
                {selectedCount > 0
                  ? `${selectedCount} UTXO${selectedCount === 1 ? '' : 's'}`
                  : 'No UTXOs'}
              </Badge>
            </div>
          </div>

          {step < 3 ? (
            <button
              type="button"
              onClick={handleContinueStep}
              disabled={
                loading ||
                (step === 1 && selectedCount === 0) ||
                (step === 2 && selectedRecipientCount === 0)
              }
              className={
                loading ||
                (step === 1 && selectedCount === 0) ||
                (step === 2 && selectedRecipientCount === 0)
                  ? 'wallet-btn-secondary w-full px-4 py-3 font-semibold disabled:opacity-50'
                  : 'wallet-btn-primary w-full px-4 py-3 font-semibold'
              }
            >
              Continue
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleReviewAndMint()}
              disabled={
                loading ||
                selectedCount === 0 ||
                selectedRecipientCount === 0 ||
                activeOutputDrafts.length === 0 ||
                bcmrImageUploadStatus.phase === 'uploading' ||
                bcmrImageUploadStatus.phase === 'verifying'
              }
              className="wallet-btn-primary w-full px-4 py-3 font-semibold disabled:opacity-50"
            >
              {loading
                ? 'Preparing…'
                : bcmrEnabled && !bcmrUploadsComplete
                  ? `Publish metadata & review (${activeOutputDrafts.length})`
                  : `Review & mint (${activeOutputDrafts.length})`}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => navigate(backTarget)}
          className="wallet-btn-danger w-full py-3 font-semibold"
        >
          Back
        </button>
      </div>

      {showOutputPopup ? (
        <Popup
          closePopups={() => {
            setShowOutputPopup(false);
            setEditingOutputDraftId(null);
          }}
          closeButtonText="Close"
        >
          <div className="p-4 space-y-4">
            <div>
              <h3 className="text-xl font-bold text-center">
                {editingOutputDraftId ? 'Edit output' : 'Add output'}
              </h3>
              <p className="mt-1 text-sm wallet-muted text-center">
                Create one mint output mapping.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-semibold mb-1">
                  Recipient
                </label>
                <select
                  value={outputFormRecipient}
                  onChange={(e) => setOutputFormRecipient(e.target.value)}
                  className="wallet-input p-4 w-full rounded-[16px] font-mono text-sm min-h-14"
                >
                  <option value="" disabled>
                    Select a recipient
                  </option>
                  {addresses
                    .map((addr) => addr.address)
                    .map((addr) => (
                      <option key={addr} value={addr}>
                        {addr}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold mb-1">
                  Source UTXO
                </label>
                <select
                  value={outputFormSourceKey}
                  onChange={(e) => {
                    const nextSourceKey = e.target.value;
                    setOutputFormSourceKey(nextSourceKey);
                    const nextSource = selectedUtxos.find(
                      (utxo) => utxoKey(utxo) === nextSourceKey
                    );
                    if (nextSource && !canMintFungibleFromSource(nextSource)) {
                      setOutputFormMintType('NFT');
                    }
                    setOutputFormCommitmentMode(
                      nftLayoutForSource(nextSource ?? null) === 'custom'
                        ? 'custom'
                        : 'serial'
                    );
                    setOutputFormNftSerial(nextNftSerial(nextSource ?? null));
                  }}
                  className="wallet-input p-4 w-full rounded-[16px] text-sm min-h-14"
                >
                  <option value="" disabled>
                    Select a source
                  </option>
                  {selectedUtxos.map((u) => {
                    const key = utxoKey(u);
                    const category = getMintSourceCategory(u);
                    return (
                      <option key={key} value={key}>
                        {`${shortHash(category, 12, 8)} • ${describeMintSourceKind(
                          u
                        )}`}
                      </option>
                    );
                  })}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  if (outputFormAllowsFungible) {
                    setOutputFormMintType('FT');
                  }
                }}
                className={
                  outputFormMintType === 'FT' && outputFormAllowsFungible
                    ? 'wallet-segment-active px-3 py-2 rounded-xl text-sm font-semibold'
                    : outputFormAllowsFungible
                      ? 'wallet-segment-inactive px-3 py-2 rounded-xl text-sm font-semibold'
                      : 'wallet-segment-inactive px-3 py-2 rounded-xl text-sm font-semibold opacity-50'
                }
                disabled={!outputFormAllowsFungible}
              >
                FT
              </button>
              <button
                type="button"
                onClick={() => setOutputFormMintType('NFT')}
                className={
                  outputFormMintType === 'NFT'
                    ? 'wallet-segment-active px-3 py-2 rounded-xl text-sm font-semibold'
                    : 'wallet-segment-inactive px-3 py-2 rounded-xl text-sm font-semibold'
                }
              >
                NFT
              </button>
            </div>

            {outputFormSourceKind && !outputFormAllowsFungible ? (
              <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3 text-sm wallet-muted">
                {outputFormSourceKind === 'minting-nft'
                  ? 'This source can only mint NFT outputs. Fungible outputs are only available from genesis UTXOs.'
                  : 'This source is not eligible for fungible minting.'}
              </div>
            ) : null}

            {outputFormMintType === 'FT' ? (
              <div className="space-y-2">
                <label className="block text-sm font-semibold">
                  {addonT('common.ftAmount', 'FT amount')}
                </label>
                <input
                  type="number"
                  min="1"
                  value={outputFormFtAmount}
                  onChange={(e) => setOutputFormFtAmount(e.target.value)}
                  className="wallet-input wallet-surface-strong p-4 w-full rounded-[16px] text-2xl font-semibold tracking-tight"
                />
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-sm font-semibold mb-1">
                    NFT capability
                  </label>
                  <select
                    value={outputFormNftCapability}
                    onChange={(e) =>
                      setOutputFormNftCapability(
                        e.target.value as MintConfig['nftCapability']
                      )
                    }
                    className="wallet-input p-3 w-full rounded-xl"
                  >
                    <option value="none">none</option>
                    <option value="mutable">mutable</option>
                    <option value="minting">minting</option>
                  </select>
                </div>
                {outputFormLayout !== 'custom' &&
                outputFormCommitmentMode === 'serial' ? (
                  <div>
                    <label className="block text-sm font-semibold mb-1">
                      {addonT('module.nftNumber', 'NFT number')}{' '}
                      <FieldHint
                        label={addonT('module.nftNumber', 'NFT number')}
                        hint={addonT(
                          'module.hintNftNumber',
                          'Written into the NFT'
                        )}
                      />
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={outputFormNftSerial}
                      onChange={(e) => setOutputFormNftSerial(e.target.value)}
                      className="wallet-input w-full"
                      placeholder={addonT('module.nextNumber', 'next number')}
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-sm font-semibold mb-1">
                      Commitment{' '}
                      <FieldHint
                        label="Commitment"
                        hint={addonT(
                          'module.hintCommitment',
                          'Raw NFT data, in hex'
                        )}
                      />
                    </label>
                    <input
                      value={outputFormNftCommitment}
                      onChange={(e) =>
                        setOutputFormNftCommitment(e.target.value)
                      }
                      className="wallet-input w-full font-mono text-xs"
                      placeholder={addonT('module.optionalHex', 'optional hex')}
                    />
                  </div>
                )}
              </div>
            )}

            {outputFormMintType === 'NFT' && outputFormLayout !== 'custom' ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {(['serial', 'custom'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={outputFormCommitmentMode === mode}
                      onClick={() => setOutputFormCommitmentMode(mode)}
                      className={`px-3 py-2 rounded-xl text-sm font-semibold ${
                        outputFormCommitmentMode === mode
                          ? 'wallet-segment-active'
                          : 'wallet-segment-inactive'
                      }`}
                    >
                      {mode === 'serial'
                        ? addonT('module.byNumber', 'By number')
                        : addonT('module.customHex', 'Custom hex')}
                    </button>
                  ))}
                </div>
                {outputFormCommitmentMode === 'serial' ? (
                  <p className="text-xs wallet-muted break-all">
                    {outputFormLayout === 'parsable'
                      ? addonT(
                          'module.commitmentParsable',
                          'Commitment: type 00, then the number.'
                        )
                      : addonT(
                          'module.commitmentSequential',
                          'Commitment: the number itself.'
                        )}{' '}
                    <span className="font-mono">
                      {outputFormCommitmentPreview || '—'}
                    </span>
                  </p>
                ) : outputFormLayout === 'parsable' &&
                  !outputFormNftCommitment
                    .trim()
                    .toLowerCase()
                    .startsWith('00') ? (
                  <p className="text-xs wallet-danger-text">
                    {addonT(
                      'module.commitmentOffLayout',
                      'This commitment does not start with type 00, so wallets will not match it to the collection.'
                    )}
                  </p>
                ) : null}
              </div>
            ) : null}

            <button
              type="button"
              onClick={saveOutputDraftForm}
              disabled={!outputFormRecipient || !outputFormSourceKey}
              className="wallet-btn-primary w-full px-4 py-3 font-semibold disabled:opacity-50"
            >
              {editingOutputDraftId
                ? addonT('common.updateOutput', 'Update output')
                : addonT('common.saveOutput', 'Save output')}
            </button>
            {editingOutputDraftId ? (
              <button
                type="button"
                onClick={deleteOutputDraftForm}
                className="wallet-btn-danger w-full px-4 py-3 font-semibold"
              >
                {addonT('common.deleteOutput', 'Delete output')}
              </button>
            ) : null}
          </div>
        </Popup>
      ) : null}

      {showBcmrPopup ? (
        <Popup
          closePopups={() => setShowBcmrPopup(false)}
          closeButtonText="Close"
        >
          <div className="p-4 space-y-4">
            <div>
              <h3 className="text-xl font-bold text-center">
                {addonT('common.tokenMetadata', 'Token metadata')}
              </h3>
              <p className="mt-1 text-sm wallet-muted text-center">
                {addonT(
                  'module.bcmrEditorIntro',
                  'Published with the new token. The prefilled fields work as they are.'
                )}
              </p>
            </div>

            {bcmrFieldErrors.general ? (
              <div className="rounded-xl bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-sm p-3">
                {bcmrFieldErrors.general}
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2">
              <label className="block text-sm font-semibold">
                {addonT('module.tokenCategory', 'Token category')}{' '}
                <FieldHint
                  label={addonT('module.tokenCategory', 'Token category')}
                  hint={addonT('module.hintCategory', "The new token's ID")}
                />
              </label>
              <input
                value={bcmrTokenCategory}
                readOnly
                className="wallet-input w-full font-mono text-xs opacity-80"
                placeholder={addonT(
                  'module.selectMintSource',
                  'Select one mint source to derive category'
                )}
              />
              {bcmrFieldErrors.tokenCategory ? (
                <p className="text-xs wallet-danger-text">
                  {bcmrFieldErrors.tokenCategory}
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-semibold">
                  {addonT('module.name', 'Name')}{' '}
                  <FieldHint
                    label={addonT('module.name', 'Name')}
                    hint={addonT('module.hintName', 'Shown in every wallet')}
                  />
                </label>
                <input
                  value={bcmrTokenName}
                  onChange={(e) => setBcmrTokenName(e.target.value)}
                  className="wallet-input w-full"
                />
                {bcmrFieldErrors.tokenName ? (
                  <p className="text-xs wallet-danger-text mt-1">
                    {bcmrFieldErrors.tokenName}
                  </p>
                ) : null}
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  {addonT('module.symbol', 'Symbol')}{' '}
                  <FieldHint
                    label={addonT('module.symbol', 'Symbol')}
                    hint={addonT('module.hintSymbol', 'Short ticker, like BCH')}
                  />
                </label>
                <input
                  value={bcmrTokenSymbol}
                  onChange={(e) =>
                    setBcmrTokenSymbol(e.target.value.toUpperCase())
                  }
                  autoCapitalize="characters"
                  className="wallet-input w-full font-mono"
                />
                {bcmrFieldErrors.tokenSymbol || bcmrSymbolIssue ? (
                  <p className="text-xs wallet-danger-text mt-1">
                    {bcmrFieldErrors.tokenSymbol || bcmrSymbolIssue}
                  </p>
                ) : null}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold">
                {addonT('module.description', 'Description')}{' '}
                <FieldHint
                  label={addonT('module.description', 'Description')}
                  hint={addonT(
                    'module.hintDescription',
                    'Optional, one short sentence'
                  )}
                />
              </label>
              <input
                value={bcmrTokenDescription}
                onChange={(e) => setBcmrTokenDescription(e.target.value)}
                className="wallet-input w-full"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-semibold">
                  {addonT('module.decimals', 'Decimals')}{' '}
                  <FieldHint
                    label={addonT('module.decimals', 'Decimals')}
                    hint={addonT(
                      'module.hintDecimals',
                      'Digits after the point'
                    )}
                  />
                </label>
                <input
                  type="number"
                  min="0"
                  max="18"
                  value={bcmrTokenDecimals}
                  onChange={(e) => setBcmrTokenDecimals(e.target.value)}
                  className="wallet-input w-full"
                />
                {bcmrFieldErrors.tokenDecimals ? (
                  <p className="text-xs wallet-danger-text mt-1">
                    {bcmrFieldErrors.tokenDecimals}
                  </p>
                ) : null}
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  {addonT('module.iconUri', 'Icon URI')}{' '}
                  <FieldHint
                    label={addonT('module.iconUri', 'Icon URI')}
                    hint={addonT('module.hintIcon', 'Link to the token image')}
                  />
                </label>
                <input
                  value={bcmrIconUri}
                  onChange={(e) => setBcmrIconUri(e.target.value)}
                  className="wallet-input w-full font-mono text-xs"
                  placeholder="ipfs://..."
                />
                {bcmrFieldErrors.iconUri ? (
                  <p className="text-xs wallet-danger-text mt-1">
                    {bcmrFieldErrors.iconUri}
                  </p>
                ) : null}
              </div>
            </div>

            <div>
              <label className="block text-sm font-semibold">
                {addonT('module.officialSite', 'Official site')}{' '}
                <FieldHint
                  label={addonT('module.officialSite', 'Official site')}
                  hint={addonT('module.hintSite', 'Project website, optional')}
                />
              </label>
              <input
                value={bcmrWebUri}
                onChange={(e) => setBcmrWebUri(e.target.value)}
                className="wallet-input w-full"
                placeholder="https://project.example"
              />
              {bcmrFieldErrors.webUri ? (
                <p className="text-xs wallet-danger-text mt-1">
                  {bcmrFieldErrors.webUri}
                </p>
              ) : null}
            </div>

            {bcmrHasNfts ? (
              <div className="rounded-xl wallet-surface-strong border border-[var(--wallet-border)] p-3 space-y-2">
                <label className="block text-sm font-semibold">
                  {addonT('module.collectionType', 'Collection type')}{' '}
                  <FieldHint
                    label={addonT('module.collectionType', 'Collection type')}
                    hint={addonT(
                      'module.hintCollectionType',
                      'How NFT data is read'
                    )}
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(['parsable', 'sequential'] as const).map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={bcmrNftKind === kind}
                      onClick={() => setBcmrNftKind(kind)}
                      className={`px-3 py-2 rounded-xl text-sm font-semibold ${
                        bcmrNftKind === kind
                          ? 'wallet-segment-active'
                          : 'wallet-segment-inactive'
                      }`}
                    >
                      {kind === 'parsable'
                        ? addonT('module.parsable', 'Parsable')
                        : addonT('module.sequential', 'Sequential')}
                    </button>
                  ))}
                </div>
                <p className="text-xs wallet-muted">
                  {bcmrNftKind === 'parsable'
                    ? addonT(
                        'module.parsableExplain',
                        'Default: a type byte, then the NFT number. NFTs minted later need no metadata update.'
                      )
                    : addonT(
                        'module.sequentialExplain',
                        'Each NFT is listed by number. NFTs minted later need a metadata update to be named.'
                      )}
                </p>
                <label className="block text-sm font-semibold">
                  {addonT('module.nftsDescription', 'NFT description')}{' '}
                  <FieldHint
                    label={addonT('module.nftsDescription', 'NFT description')}
                    hint={addonT(
                      'module.hintNftsDescription',
                      'How the NFTs are used'
                    )}
                  />
                </label>
                <input
                  value={bcmrNftsDescription}
                  onChange={(e) => setBcmrNftsDescription(e.target.value)}
                  className="wallet-input w-full"
                />

                {bcmrNftKind === 'parsable' ? (
                  <>
                    <button
                      type="button"
                      aria-expanded={bcmrNftAdvanced}
                      onClick={() => setBcmrNftAdvanced((value) => !value)}
                      className="text-xs font-semibold wallet-accent-text"
                    >
                      {bcmrNftAdvanced
                        ? addonT(
                            'module.hideAdvancedLayout',
                            'Use the default layout'
                          )
                        : addonT(
                            'module.showAdvancedLayout',
                            'Custom layout (advanced)'
                          )}
                    </button>
                    {bcmrNftAdvanced ? (
                      <div className="space-y-2">
                        <p className="text-xs wallet-muted">
                          {addonT(
                            'module.advancedLayoutExplain',
                            'Empty fields keep the default layout. A custom bytecode needs its own types and fields.'
                          )}
                        </p>
                        <label className="block text-xs font-semibold">
                          {addonT('module.parseBytecode', 'Parse bytecode')}{' '}
                          <FieldHint
                            label={addonT(
                              'module.parseBytecode',
                              'Parse bytecode'
                            )}
                            hint={addonT(
                              'module.hintBytecode',
                              'Reads fields from NFT data'
                            )}
                          />
                        </label>
                        <input
                          value={bcmrNftBytecode}
                          onChange={(e) => setBcmrNftBytecode(e.target.value)}
                          className="wallet-input w-full font-mono text-xs"
                          placeholder={defaultParseBytecode()}
                        />
                        {bcmrFieldErrors.nftBytecode ? (
                          <p className="text-xs wallet-danger-text mt-1">
                            {bcmrFieldErrors.nftBytecode}
                          </p>
                        ) : null}
                        <label className="block text-xs font-semibold">
                          {addonT('module.nftTypes', 'NFT types')}{' '}
                          <FieldHint
                            label={addonT('module.nftTypes', 'NFT types')}
                            hint={addonT(
                              'module.hintNftTypes',
                              'Names for each NFT type'
                            )}
                          />
                        </label>
                        <textarea
                          value={bcmrNftTypesJson}
                          onChange={(e) => setBcmrNftTypesJson(e.target.value)}
                          rows={4}
                          className="wallet-input w-full font-mono text-xs"
                          placeholder='{"00":{"name":"Collection","fields":["serial"]}}'
                        />
                        {bcmrFieldErrors.nftTypes ? (
                          <p className="text-xs wallet-danger-text mt-1">
                            {bcmrFieldErrors.nftTypes}
                          </p>
                        ) : null}
                        <label className="block text-xs font-semibold">
                          {addonT('module.nftFields', 'NFT fields')}{' '}
                          <FieldHint
                            label={addonT('module.nftFields', 'NFT fields')}
                            hint={addonT(
                              'module.hintNftFields',
                              'Names for each data field'
                            )}
                          />
                        </label>
                        <textarea
                          value={bcmrNftFieldsJson}
                          onChange={(e) => setBcmrNftFieldsJson(e.target.value)}
                          rows={3}
                          className="wallet-input w-full font-mono text-xs"
                          placeholder='{"serial":{"name":"Serial","encoding":{"type":"number"}}}'
                        />
                        {bcmrFieldErrors.nftFields ? (
                          <p className="text-xs wallet-danger-text mt-1">
                            {bcmrFieldErrors.nftFields}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-xl wallet-surface-strong border border-[var(--wallet-border)] p-3 space-y-2">
              <label className="block text-sm font-semibold">
                Optional: upload icon image to IPFS
              </label>
              <input
                type="file"
                accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.bmp,.ico,image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif,image/bmp,image/x-icon"
                className="wallet-input w-full"
                onChange={(e) => {
                  setBcmrImageFile(e.target.files?.[0] ?? null);
                  setBcmrImageUpload(null);
                  setBcmrImageUploadStatus(IDLE_BCMR_UPLOAD_STATUS);
                }}
              />
              <button
                type="button"
                onClick={handleUploadBcmrImage}
                disabled={!bcmrImageFile || loading}
                className="wallet-btn-secondary px-3 py-2 text-sm"
              >
                {bcmrImageUploadStatus.phase === 'uploading'
                  ? 'Uploading image...'
                  : bcmrImageUploadStatus.phase === 'verifying'
                    ? 'Verifying image...'
                    : 'Save image'}
              </button>
              {bcmrImageUploadStatus.message ? (
                <p
                  className={`text-xs ${
                    bcmrImageUploadStatus.phase === 'error'
                      ? 'wallet-danger-text'
                      : bcmrImageUploadStatus.phase === 'ready'
                        ? 'wallet-accent-text'
                        : 'wallet-muted'
                  }`}
                >
                  {bcmrImageUploadStatus.message}
                </p>
              ) : null}
              {bcmrImageUpload ? (
                <div className="text-xs break-all">
                  Image CID: {bcmrImageUpload.cid}
                </div>
              ) : null}
              {bcmrFieldErrors.image ? (
                <p className="text-xs wallet-danger-text">
                  {bcmrFieldErrors.image}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => void handleConfirmBcmr()}
                disabled={
                  loading ||
                  bcmrImageUploadStatus.phase === 'uploading' ||
                  bcmrImageUploadStatus.phase === 'verifying'
                }
                className="wallet-btn-primary px-3 py-2 text-sm"
              >
                {bcmrRegistryUploadStatus.phase === 'uploading'
                  ? 'Uploading metadata...'
                  : bcmrRegistryUploadStatus.phase === 'verifying'
                    ? 'Verifying metadata...'
                    : loading
                      ? 'Publishing...'
                      : addonT('module.publishMetadata', 'Publish metadata')}
              </button>
              {bcmrRegistryUploadStatus.message ? (
                <p
                  className={`text-xs ${
                    bcmrRegistryUploadStatus.phase === 'error'
                      ? 'wallet-danger-text'
                      : bcmrRegistryUploadStatus.phase === 'ready'
                        ? 'wallet-accent-text'
                        : 'wallet-muted'
                  }`}
                >
                  {bcmrRegistryUploadStatus.message}
                </p>
              ) : null}
              {bcmrUris.length > 0 ? (
                <div className="text-xs break-all space-y-1">
                  {bcmrUris.map((uri) => (
                    <div key={uri}>Registry URI: {uri}</div>
                  ))}
                </div>
              ) : null}
              {bcmrAuthored ? (
                <button
                  type="button"
                  onClick={() =>
                    void copyText(
                      bcmrAuthored.registryJson,
                      'Metadata JSON copied'
                    )
                  }
                  className="text-xs font-semibold wallet-accent-text"
                >
                  {addonT(
                    'module.copyMetadataJson',
                    'Copy metadata JSON (backup)'
                  )}
                </button>
              ) : null}
              {bcmrAuthored &&
              bcmrConfirmedFingerprint &&
              bcmrConfirmedFingerprint !== bcmrFormFingerprint ? (
                <p className="text-xs wallet-danger-text">
                  {addonT(
                    'module.metadataChanged',
                    'Fields changed after publishing. Publish again before minting.'
                  )}
                </p>
              ) : null}
              {bcmrFieldErrors.registry ? (
                <p className="text-xs wallet-danger-text">
                  {bcmrFieldErrors.registry}
                </p>
              ) : null}
            </div>
          </div>
        </Popup>
      ) : null}

      {/* Contained confirmation modal */}
      <ContainedSwipeConfirmModal
        open={confirmState.open}
        title={confirmState.title}
        subtitle={confirmState.subtitle}
        warning={confirmState.warning}
        loading={confirmState.loading}
        onCancel={() => {
          if (confirmState.loading) return;
          closeConfirm();
        }}
        onConfirm={() => {
          if (!pendingConfirmActionRef.current || confirmState.loading) return;
          void pendingConfirmActionRef.current();
        }}
      >
        {confirmState.body}
      </ContainedSwipeConfirmModal>
    </div>
  );
};

export default MintCashTokensPoCApp;
