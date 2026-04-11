// src/pages/apps/mintCashTokensPoCApp/MintCashTokensPoCApp.tsx

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';

import {
  buildBcmrPublicationOpReturn,
  generateBcmrRegistryJson,
  buildBootstrapPreview,
  buildMintPreview,
  parseUrisInput,
  selectFeeCandidates,
  selectGenesisUtxos,
  validateMintRequest,
} from './services';
import {
  IpfsUploadResult,
  uploadToIpfsRelay,
  waitForIpfsAvailability,
} from '../../../services/IpfsService';
import type { AddonSDK } from '../../../services/AddonsSDK';
import { copyToClipboard } from '../../../utils/clipboard';
import { sha256 } from '../../../utils/hash';
import BcmrService, {
  isBcmrRegistryNotFoundError,
} from '../../../services/BcmrService';

import TxSummary from '../../../components/confirm/TxSummary';
import {
  AmountsStepCard,
  Badge,
  ContainedSwipeConfirmModal,
  RecipientsStepCard,
  SourcesStepCard,
  Stepper,
} from './components';
import { DEFAULT_CFG } from './types';
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
  utxoKey,
} from './utils';
import { useSmoothResetTransition } from '../shared/useSmoothResetTransition';

type MintCashTokensPoCAppProps = {
  sdk: AddonSDK;
};

type BcmrFieldKey =
  | 'tokenCategory'
  | 'tokenName'
  | 'tokenSymbol'
  | 'tokenDecimals'
  | 'iconUri'
  | 'webUri'
  | 'registry'
  | 'image'
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

const MintCashTokensPoCApp: React.FC<MintCashTokensPoCAppProps> = ({ sdk }) => {
  const navigate = useNavigate();
  const walletId = sdk.wallet.getContext().walletId;

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
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
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
  const [bcmrEnabled, setBcmrEnabled] = useState(false);
  const [bcmrRegistryJson, setBcmrRegistryJson] = useState('');
  const [bcmrUrisText, setBcmrUrisText] = useState('');
  const [bcmrTokenName, setBcmrTokenName] = useState('');
  const [bcmrTokenDescription, setBcmrTokenDescription] = useState('');
  const [bcmrTokenSymbol, setBcmrTokenSymbol] = useState('');
  const [bcmrTokenDecimals, setBcmrTokenDecimals] = useState('0');
  const [bcmrIconUri, setBcmrIconUri] = useState('');
  const [bcmrWebUri, setBcmrWebUri] = useState('');
  const [bcmrImageFile, setBcmrImageFile] = useState<File | null>(null);
  const [bcmrImageUpload, setBcmrImageUpload] =
    useState<IpfsUploadResult | null>(null);
  const [bcmrImageUploadStatus, setBcmrImageUploadStatus] =
    useState<BcmrUploadStatus>(IDLE_BCMR_UPLOAD_STATUS);
  const [bcmrRegistryUpload, setBcmrRegistryUpload] =
    useState<IpfsUploadResult | null>(null);
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

  const refreshWalletSnapshot = useCallback(async (forceRefresh = false) => {
    const walletAddresses = await sdk.wallet.listAddresses();

    if (forceRefresh) {
      await Promise.all(
        walletAddresses.map((walletAddress) =>
          sdk.utxos.refreshAndStore(walletAddress.address).catch(() => null)
        )
      );
    }

    const utxoRes = await sdk.utxos.listForWallet();

    setAddresses(walletAddresses);
    setChangeAddress((prev) => prev || walletAddresses[0]?.address || '');
    setFlatUtxos(mergeWalletUtxos(utxoRes));
  }, [sdk]);

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

  const walletGenesisCandidates: MintAppUtxo[] = useMemo(
    () => selectGenesisUtxos(flatUtxos),
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

  const displayGenesisUtxos: MintDisplayUtxo[] = useMemo(() => {
    const all = [...bootstrapGenesisUtxos, ...walletGenesisCandidates];
    const seen = new Set<string>();
    const out: MintAppUtxo[] = [];
    for (const u of all) {
      const k = utxoKey(u);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(u);
    }
    return out;
  }, [bootstrapGenesisUtxos, walletGenesisCandidates]);

  const displayGenesisUtxoByKey = useMemo(() => {
    const out = new Map<string, MintDisplayUtxo>();
    for (const u of displayGenesisUtxos) {
      out.set(utxoKey(u), u);
    }
    return out;
  }, [displayGenesisUtxos]);

  const selectedUtxos: MintAppUtxo[] = useMemo(() => {
    if (selectedKeys.size === 0) return [];
    const out: MintAppUtxo[] = [];
    for (const key of selectedKeys) {
      const utxo = displayGenesisUtxoByKey.get(key);
      if (utxo) out.push(utxo);
    }
    return out;
  }, [displayGenesisUtxoByKey, selectedKeys]);

  const selectedCount = selectedUtxos.length;
  const pendingCount = bootstrapGenesisUtxos.length;

  const orderedSelectedRecipients = useMemo(() => {
    const set = selectedRecipientCashAddrs;
    return addresses.map((a) => a.address).filter((addr) => set.has(addr));
  }, [addresses, selectedRecipientCashAddrs]);

  const selectedRecipientCount = orderedSelectedRecipients.length;

  const bcmrSelectedCategories = useMemo(
    () => Array.from(new Set(selectedUtxos.map((utxo) => utxo.tx_hash))),
    [selectedUtxos]
  );
  const bcmrAuthbase = bcmrSelectedCategories.length === 1 ? bcmrSelectedCategories[0] : '';
  const bcmrTokenCategory = bcmrAuthbase;

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
  ]);

  const bcmrRegistryIsCurrent =
    bcmrRegistryUploadStatus.phase === 'ready' &&
    bcmrRegistryJson.length > 0 &&
    bcmrConfirmedFingerprint.length > 0 &&
    bcmrConfirmedFingerprint === bcmrFormFingerprint;

  const bcmrReadyForMint =
    !bcmrEnabled ||
    (bcmrRegistryIsCurrent &&
      bcmrRegistryUpload !== null &&
      bcmrUrisText.trim().length > 0);

  const bcmrMintReadinessMessage = !bcmrEnabled
    ? ''
    : bcmrImageUploadStatus.phase === 'uploading' ||
        bcmrRegistryUploadStatus.phase === 'uploading'
      ? 'Uploading BCMR assets to IPFS...'
      : bcmrImageUploadStatus.phase === 'verifying' ||
          bcmrRegistryUploadStatus.phase === 'verifying'
        ? 'Verifying BCMR assets on IPFS...'
        : bcmrRegistryUploadStatus.phase === 'error'
          ? bcmrRegistryUploadStatus.message || 'BCMR registry upload failed.'
          : bcmrImageUploadStatus.phase === 'error'
            ? bcmrImageUploadStatus.message || 'BCMR image upload failed.'
            : bcmrRegistryUploadStatus.phase !== 'ready'
              ? 'Confirm BCMR metadata before minting.'
              : !bcmrRegistryIsCurrent
                ? 'BCMR fields changed. Confirm BCMR again before minting.'
                : 'BCMR metadata is ready for minting.';

  const bcmrPublication = useMemo<MintBcmrPublication | undefined>(() => {
    if (!bcmrEnabled || !bcmrReadyForMint) return undefined;
    return {
      enabled: true,
      registryJson: bcmrRegistryJson,
      uris: parseUrisInput(bcmrUrisText),
    };
  }, [bcmrEnabled, bcmrReadyForMint, bcmrRegistryJson, bcmrUrisText]);

  const bcmrPreview = useMemo(() => {
    if (!bcmrPublication?.enabled) return null;
    try {
      return buildBcmrPublicationOpReturn({
        registryJson: bcmrPublication.registryJson,
        uris: bcmrPublication.uris,
      });
    } catch {
      return null;
    }
  }, [bcmrPublication]);

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

  const addOutputDraft = useCallback(() => {
    const recipientCashAddr = orderedSelectedRecipients[0];
    const sourceKey = selectedUtxos[0] ? utxoKey(selectedUtxos[0]) : '';
    if (!recipientCashAddr || !sourceKey) return;
    const id = `draft-${Date.now()}-${draftSeq.current++}`;
    setOutputDrafts((prev) => [
      ...prev,
      { id, recipientCashAddr, sourceKey, config: { ...DEFAULT_CFG } },
    ]);
    setExpandedDraftId(id);
  }, [orderedSelectedRecipients, selectedUtxos]);

  const updateOutputDraft = useCallback(
    (id: string, patch: Partial<MintOutputDraft>) => {
      setOutputDrafts((prev) =>
        prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
      );
    },
    []
  );

  const updateOutputDraftConfig = useCallback(
    (id: string, patch: Partial<MintConfig>) => {
      setOutputDrafts((prev) =>
        prev.map((d) =>
          d.id === id ? { ...d, config: { ...d.config, ...patch } } : d
        )
      );
    },
    []
  );

  const removeOutputDraft = useCallback((id: string) => {
    setOutputDrafts((prev) => prev.filter((d) => d.id !== id));
    setExpandedDraftId((prev) => (prev === id ? null : prev));
  }, []);

  const duplicateOutputDraft = useCallback((id: string) => {
    setOutputDrafts((prev) => {
      const target = prev.find((d) => d.id === id);
      if (!target) return prev;
      return [
        ...prev,
        {
          ...target,
          id: `draft-${Date.now()}-${draftSeq.current++}`,
        },
      ];
    });
  }, []);

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

  const canGoToStep = useCallback(
    (n: 1 | 2 | 3) => {
      if (n === 1) return true;
      if (n === 2) return selectedCount > 0;
      return selectedCount > 0 && selectedRecipientCount > 0;
    },
    [selectedCount, selectedRecipientCount]
  );

  const handleBackStep = useCallback(() => {
    setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s));
  }, []);

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

  useEffect(() => {
    if (
      activeOutputDrafts.length === outputDrafts.length &&
      activeOutputDrafts.every((d, i) => d === outputDrafts[i])
    ) {
      return;
    }
    setOutputDrafts(activeOutputDrafts);
  }, [activeOutputDrafts, outputDrafts]);

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
    setExpandedDraftId(null);
    setBootstrapTxids([]);
    setMountedSteps(new Set([1]));
    setStep(1);
    setSelectedRecipientCashAddrs(
      addresses[0]?.address ? new Set([addresses[0].address]) : new Set()
    );
    draftSeq.current = 0;
    setBcmrEnabled(false);
    setBcmrRegistryJson('');
    setBcmrUrisText('');
    setBcmrTokenName('');
    setBcmrTokenDescription('');
    setBcmrTokenSymbol('');
    setBcmrTokenDecimals('0');
    setBcmrIconUri('');
    setBcmrWebUri('');
    setBcmrImageFile(null);
    setBcmrImageUpload(null);
    setBcmrRegistryUpload(null);
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
        'No fee UTXOs available. Need a non-token UTXO with vout != 0.'
      );
      return;
    }

    setLoading(true);
    try {
      const fundingUtxos = [feeCandidates[0]];
      const { built, feePaid } = await buildBootstrapPreview({
        sdk,
        fundingUtxos,
        toAddress: myAddress,
        changeAddress,
      });

      openConfirm({
        title: 'Create Category UTXO',
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
            setStatus('Broadcasting Category UTXO creation...');
            const sent = await sdk.tx.broadcast(built.hex);
            const sentTxid = sent?.txid ?? '';
            if (!sentTxid)
              throw new Error(
                sent?.errorMessage || 'Broadcast returned no txid.'
              );

            const submitted = sent.broadcastState === 'submitted';
            closeConfirm();
            await runSmoothReset(async () => {
              await refreshWalletSnapshot(true);
              resetMintComposer();
            });
            setTxid(sentTxid);
            setStatus(
              submitted
                ? 'Category UTXO submitted. Keep the txid and avoid sending it again.'
                : 'Category UTXO created. Returned to the start screen.'
            );
            showToast(
              submitted ? 'Category UTXO submitted' : 'Category UTXO created'
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
    sdk,
    setErrorMessage,
    setLoading,
    openConfirm,
    setStatus,
    setTxid,
    showToast,
    refreshWalletSnapshot,
    closeConfirm,
    setConfirmLoading,
  ]);

  /**
   * Build mint tx:
   * - inputs: genesis (vout=0 selected) + fee utxos (vout!=0 && !token)
   * - outputs: N token outputs + auto change
   * Enforce 1 sat/byte by builder.
   */
  const prepareMint = useCallback(async () => {
    resetFlowMessages();
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
        setErrorMessage('Wait for the BCMR IPFS upload to finish before minting.');
        return;
      }
      if (!bcmrReadyForMint) {
        setErrorMessage(
          'Confirm BCMR metadata and wait for IPFS verification before minting.'
        );
        return;
      }
    }

    setLoading(true);
    setStatus('Preparing transaction for review...');

    try {
      const { built, inputsForBuild, feePaid } = await buildMintPreview({
        sdk,
        selectedUtxos,
        flatUtxos,
        activeOutputDrafts,
        changeAddress,
        sdkAddressBook,
        tokenOutputSats: TOKEN_OUTPUT_SATS,
        bcmrPublication,
      });

      openConfirm({
        title: `Confirm mint (${activeOutputDrafts.length} output${
          activeOutputDrafts.length === 1 ? '' : 's'
        })`,
        subtitle: 'Fee policy: 1 sat/byte. Review before broadcast.',
        warning: <>This will broadcast immediately after confirmation.</>,
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
            const sent = await sdk.tx.broadcast(built.hex);
            const sentTxid = sent?.txid ?? '';
            if (!sentTxid)
              throw new Error(sent?.errorMessage || 'Broadcast failed.');
            const submitted = sent.broadcastState === 'submitted';
            closeConfirm();
            await runSmoothReset(async () => {
              await refreshWalletSnapshot(true);
              resetMintComposer();
            });
            setTxid(sentTxid);
            setStatus(
              submitted
                ? 'Mint transaction submitted. Keep the txid and avoid sending it again.'
                : 'Mint successful. Returned to the start screen.'
            );
            showToast(submitted ? 'Transaction submitted' : 'Broadcasted');
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
  }, [
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
    bcmrReadyForMint,
    setErrorMessage,
    setLoading,
    setStatus,
    sdk,
    flatUtxos,
    sdkAddressBook,
    bcmrPublication,
    openConfirm,
    setTxid,
    closeConfirm,
    showToast,
    refreshWalletSnapshot,
    setConfirmLoading,
  ]);

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

  const handleConfirmBcmr = useCallback(async () => {
    const trimmedCategory = bcmrTokenCategory.trim();
    const trimmedName = bcmrTokenName.trim();
    const trimmedSymbol = bcmrTokenSymbol.trim();
    const trimmedIcon = bcmrIconUri.trim();
    const trimmedWeb = bcmrWebUri.trim();
    const parsedDecimals = Number.parseInt(bcmrTokenDecimals, 10);

    const nextErrors: Partial<Record<BcmrFieldKey, string>> = {};

    if (bcmrSelectedCategories.length !== 1) {
      nextErrors.general =
        'BCMR publication requires exactly one selected genesis category.';
    } else if (!/^[0-9a-f]{64}$/i.test(bcmrAuthbase.trim())) {
      nextErrors.general = 'Authbase is not ready. Select a valid source UTXO.';
    }
    if (!/^[0-9a-f]{64}$/i.test(trimmedCategory)) {
      nextErrors.tokenCategory = 'Token category must be 64 hex characters.';
    }
    if (!trimmedName) {
      nextErrors.tokenName = 'Name is required.';
    }
    if (!trimmedSymbol) {
      nextErrors.tokenSymbol = 'Symbol is required.';
    }
    if (!Number.isFinite(parsedDecimals) || parsedDecimals < 0) {
      nextErrors.tokenDecimals = 'Decimals must be a non-negative number.';
    }
    if (trimmedIcon && !/^(ipfs|https?):\/\//i.test(trimmedIcon)) {
      nextErrors.iconUri = 'Icon URI must start with ipfs:// or https://';
    }
    if (trimmedWeb && !/^https?:\/\//i.test(trimmedWeb)) {
      nextErrors.webUri = 'Official site must start with https:// or http://';
    }

    if (Object.keys(nextErrors).length > 0) {
      setBcmrFieldErrors(nextErrors);
      return;
    }

    clearBcmrFieldErrors();
    setBcmrRegistryUpload(null);
    setBcmrRegistryUploadStatus({
      phase: 'uploading',
      message: 'Uploading BCMR registry to IPFS...',
    });

    setLoading(true);
    try {
      const json = generateBcmrRegistryJson({
        baseRegistry: await (async () => {
          try {
            const existing = await bcmrService.resolveIdentityRegistry(
              bcmrAuthbase
            );
            return existing.registry;
          } catch (error) {
            if (isBcmrRegistryNotFoundError(error)) {
              return undefined;
            }
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
      });
      setBcmrRegistryJson(json);

      const blob = new Blob([json], { type: 'application/json' });
      const result = await uploadToIpfsRelay(blob, {
        filename: 'bitcoin-cash-metadata-registry.json',
      });
      const ipfsUri = `ipfs://${result.cid}`;
      setBcmrRegistryUploadStatus({
        phase: 'verifying',
        message: 'Waiting for the BCMR registry to be reachable from IPFS...',
      });
      const expectedHash = sha256.text(json);
      await waitForIpfsAvailability(ipfsUri, {
        timeoutMs: 45_000,
        pollIntervalMs: 1_500,
        validateResponse: async (response) => {
          const body = await response.text();
          if (sha256.text(body) !== expectedHash) {
            throw new Error(
              'Uploaded BCMR registry is reachable but does not match the expected content.'
            );
          }
        },
      });
      setBcmrRegistryUpload(result);
      setBcmrUrisText(ipfsUri);
      setBcmrConfirmedFingerprint(bcmrFormFingerprint);
      setBcmrRegistryUploadStatus({
        phase: 'ready',
        message: 'BCMR registry uploaded and verified on IPFS.',
      });
      setStatus('BCMR registry confirmed and uploaded to IPFS.');
    } catch (e: unknown) {
      const message = getErrorMessage(e, 'Failed to confirm BCMR metadata.');
      setBcmrRegistryUploadStatus({
        phase: 'error',
        message,
      });
      const field = mapBcmrErrorToField(message);
      setBcmrFieldError(field, message);
    } finally {
      setLoading(false);
    }
  }, [
    clearBcmrFieldErrors,
    bcmrTokenCategory,
    bcmrTokenName,
    bcmrTokenSymbol,
    bcmrTokenDecimals,
    bcmrIconUri,
    bcmrWebUri,
    bcmrAuthbase,
    bcmrSelectedCategories.length,
    setLoading,
    bcmrTokenDescription,
    bcmrFormFingerprint,
    bcmrService,
    mapBcmrErrorToField,
    setStatus,
  ]);

  return (
    <div className="container mx-auto max-w-md h-full min-h-0 px-4 pt-4 pb-3 flex flex-col overflow-hidden wallet-page">
      <div className="flex-none space-y-4">
        <div className="flex justify-center">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="OPTN"
            className="h-auto w-full max-w-[260px] object-contain"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <h1 className="min-w-0 truncate text-2xl font-bold wallet-text-strong tracking-[-0.02em]">
            Mint Tokens
          </h1>
          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="wallet-btn-danger px-4 py-2"
          >
            Go Back
          </button>
        </div>

        {toast ? (
          <div className="px-3 py-2 rounded-xl wallet-popup-panel text-xs font-semibold">
            {toast}
          </div>
        ) : null}
      </div>

      <div className={`flex-1 min-h-0 overflow-y-auto overscroll-contain pt-4 pr-1 ${contentClassName}`}>
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
                    displayGenesisUtxos={displayGenesisUtxos}
                    selectedKeys={selectedKeys}
                    selectedCount={selectedCount}
                    pendingCount={pendingCount}
                    loading={loading}
                    canCreateSource={!!changeAddress}
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
                    activeOutputDrafts={activeOutputDrafts}
                    expandedDraftId={expandedDraftId}
                    orderedSelectedRecipients={orderedSelectedRecipients}
                    onAddOutputDraft={addOutputDraft}
                    onSetExpandedDraftId={setExpandedDraftId}
                    onUpdateOutputDraft={updateOutputDraft}
                    onUpdateOutputDraftConfig={updateOutputDraftConfig}
                    onDuplicateOutputDraft={duplicateOutputDraft}
                    onRemoveOutputDraft={removeOutputDraft}
                  />
                ) : null}
                {mountedSteps.has(3) ? (
                  <div className="mt-4 wallet-card rounded-[20px] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-base font-semibold">
                        Token Metadata
                      </h3>
                      <label className="inline-flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={bcmrEnabled}
                          onChange={(e) => setBcmrEnabled(e.target.checked)}
                        />
                        Include Metadata
                      </label>
                    </div>
                    {bcmrEnabled ? (
                      <>
                        {bcmrFieldErrors.general ? (
                          <div className="rounded-xl bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300 text-sm p-3">
                            {bcmrFieldErrors.general}
                          </div>
                        ) : null}
                        <div className="grid grid-cols-1 gap-2">
                          <label className="block text-sm font-semibold">
                            Token category
                          </label>
                          <input
                            value={bcmrTokenCategory}
                            readOnly
                            className="wallet-input w-full font-mono text-xs opacity-80"
                            placeholder="Select one genesis UTXO to derive category"
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
                              Name
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
                              Symbol
                            </label>
                            <input
                              value={bcmrTokenSymbol}
                              onChange={(e) =>
                                setBcmrTokenSymbol(e.target.value)
                              }
                              className="wallet-input w-full"
                            />
                            {bcmrFieldErrors.tokenSymbol ? (
                              <p className="text-xs wallet-danger-text mt-1">
                                {bcmrFieldErrors.tokenSymbol}
                              </p>
                            ) : null}
                          </div>
                        </div>
                        <div>
                          <label className="block text-sm font-semibold">
                            Description
                          </label>
                          <input
                            value={bcmrTokenDescription}
                            onChange={(e) =>
                              setBcmrTokenDescription(e.target.value)
                            }
                            className="wallet-input w-full"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="block text-sm font-semibold">
                              Decimals
                            </label>
                            <input
                              type="number"
                              min="0"
                              value={bcmrTokenDecimals}
                              onChange={(e) =>
                                setBcmrTokenDecimals(e.target.value)
                              }
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
                              Icon URI
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
                            Official site
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
                              setBcmrImageUploadStatus(
                                IDLE_BCMR_UPLOAD_STATUS
                              );
                            }}
                          />
                          <div className="flex gap-2">
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
                          </div>
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
                            onClick={handleConfirmBcmr}
                            disabled={
                              loading ||
                              bcmrImageUploadStatus.phase === 'uploading' ||
                              bcmrImageUploadStatus.phase === 'verifying'
                            }
                            className="wallet-btn-primary px-3 py-2 text-sm"
                          >
                            {bcmrRegistryUploadStatus.phase === 'uploading'
                              ? 'Uploading BCMR...'
                              : bcmrRegistryUploadStatus.phase === 'verifying'
                                ? 'Verifying BCMR...'
                                : loading
                                  ? 'Confirming...'
                                  : 'Confirm BCMR'}
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
                          {bcmrRegistryUpload ? (
                            <div className="text-xs break-all">
                              Registry URI: ipfs://{bcmrRegistryUpload.cid}
                            </div>
                          ) : null}
                          {bcmrRegistryUpload &&
                          !bcmrRegistryIsCurrent ? (
                            <p className="text-xs wallet-danger-text">
                              BCMR fields changed after the last confirmation.
                              Confirm BCMR again before minting.
                            </p>
                          ) : null}
                          {bcmrFieldErrors.registry ? (
                            <p className="text-xs wallet-danger-text">
                              {bcmrFieldErrors.registry}
                            </p>
                          ) : null}
                        </div>
                        {bcmrPreview ? (
                          <div className="rounded-xl wallet-surface-strong border border-[var(--wallet-border)] p-3 text-xs space-y-1">
                            <div className="break-all">
                              <span className="font-semibold">
                                sha256 hash:{' '}
                              </span>
                              <span className="font-mono">
                                {bcmrPreview.hashHex}
                              </span>
                            </div>
                            <div className="break-all">
                              <span className="font-semibold">
                                script hex:{' '}
                              </span>
                              <span className="font-mono">
                                {bcmrPreview.scriptHex}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="text-xs wallet-danger-text">
                            Confirm BCMR and wait for IPFS verification to
                            enable the BCMR OP_RETURN.
                          </div>
                        )}
                      </>
                    ) : null}
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
      <div className="flex-none pt-3">
        <div className="rounded-[22px] wallet-card shadow-[0_10px_30px_rgba(0,0,0,0.12)] p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {step === 1
                  ? 'Step 1: Category UTXO'
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

          {step === 3 && bcmrEnabled ? (
            <div
              className={`mb-3 rounded-xl px-3 py-2 text-xs ${
                bcmrReadyForMint
                  ? 'wallet-surface-strong wallet-accent-text'
                  : bcmrRegistryUploadStatus.phase === 'error' ||
                      bcmrImageUploadStatus.phase === 'error'
                    ? 'bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-300'
                    : 'wallet-surface-strong wallet-muted'
              }`}
            >
              {bcmrMintReadinessMessage}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={handleBackStep}
              disabled={step === 1 || loading}
              className="wallet-btn-secondary px-4 py-3 font-semibold disabled:opacity-50"
            >
              Back
            </button>

            {step < 3 ? (
              <button
                type="button"
                onClick={handleContinueStep}
                disabled={
                  loading ||
                  (step === 1 && selectedCount === 0) ||
                  (step === 2 && selectedRecipientCount === 0)
                }
                className="wallet-btn-secondary px-4 py-3 font-semibold disabled:opacity-50"
              >
                Continue
              </button>
            ) : (
              <button
                type="button"
                onClick={prepareMint}
                disabled={
                  loading ||
                  selectedCount === 0 ||
                  selectedRecipientCount === 0 ||
                  activeOutputDrafts.length === 0 ||
                  (bcmrEnabled && !bcmrReadyForMint)
                }
                className="wallet-btn-primary px-4 py-3 font-semibold disabled:opacity-50"
              >
                {bcmrEnabled && !bcmrReadyForMint
                  ? 'BCMR pending'
                  : loading
                  ? 'Preparing…'
                  : `Review & mint (${activeOutputDrafts.length})`}
              </button>
            )}
          </div>
        </div>
      </div>

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
