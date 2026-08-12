import React, { useEffect, useMemo, useState } from 'react';
import {
  CapacitorBarcodeScannerTypeHint,
} from '@capacitor/barcode-scanner';
import { Toast } from '@capacitor/toast';
import {
  getBarcodeScannerErrorMessage,
  scanBarcodeSafely,
} from '../../../../utils/barcodeScanner';
import type { AddonSDK } from '../../../../services/AddonsSDK';
import SectionCard from '../../../../components/ui/SectionCard';
import Popup from '../../../../components/transaction/Popup';
import { ContainedSwipeConfirmModal } from '../../mint-cashtokens-poc/components/uiPrimitives';
import { Network } from '../../../../redux/networkSlice';
import { parseBip21Uri } from '../../../../utils/bip21';
import {
  buildApprovedDistributionTransaction,
  executeApprovedDistributionSend,
  type DistributionTxPreview,
} from '../services/executeDistributionSend';
import type {
  DistributionJobRecord,
  DistributionRecipient,
  AirdropWorkspace,
  WalletAirdropAsset,
} from '../types';

type FlowStep = 'recipients' | 'asset' | 'send';

type DistributorScreenProps = {
  sdk: AddonSDK;
  workspace: AirdropWorkspace;
  availableTokens: WalletAirdropAsset[];
  feeFundingSats: number;
  feeFundingUtxoCount: number;
};

type AmountRuleMode = 'fixed' | 'has_token' | 'tiered_balance';
type RecipientSourceMode = 'manual' | 'token';

const DISTRIBUTOR_DRAFT_STORAGE_KEY = 'optn.distributor.localDraft.v1';

function makeLocalId(prefix: string) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function shortenMiddle(value: string, head = 12, tail = 8) {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function normalizeAddressKey(address: string) {
  return address.trim().toLowerCase();
}

function looksLikeAddress(value: string) {
  const trimmed = value.trim();
  return /^(bitcoincash:|bchtest:|simpleledger:|etoken:|ecash:)/i.test(trimmed);
}

type ParsedRecipientRow = {
  label: string;
  address: string;
  notes: string;
  source: 'paste';
};

function normalizeParsedRecipient(
  value:
    | string
    | {
        address?: string;
        cashaddr?: string;
        recipientAddress?: string;
        destination_address?: string;
        label?: string;
        name?: string;
        notes?: string;
        memo?: string;
      },
  index: number
): ParsedRecipientRow | null {
  if (typeof value === 'string') {
    const address = value.trim();
    if (!looksLikeAddress(address)) return null;
    return {
      label: `Recipient ${index + 1}`,
      address,
      notes: '',
      source: 'paste',
    };
  }

  const address =
    value.address?.trim() ||
    value.cashaddr?.trim() ||
    value.recipientAddress?.trim() ||
    value.destination_address?.trim() ||
    '';

  if (!looksLikeAddress(address)) return null;

  return {
    label: value.label?.trim() || value.name?.trim() || `Recipient ${index + 1}`,
    address,
    notes: value.notes?.trim() || value.memo?.trim() || '',
    source: 'paste',
  };
}

function parseRecipientJson(text: string) {
  const trimmed = text.trim();
  if (!trimmed || !['[', '{'].includes(trimmed[0])) return null;

  try {
    const parsed = JSON.parse(trimmed) as
      | unknown[]
      | {
          recipients?: unknown[];
          addresses?: unknown[];
          items?: unknown[];
        };

    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.recipients)
        ? parsed.recipients
        : Array.isArray(parsed.addresses)
          ? parsed.addresses
          : Array.isArray(parsed.items)
            ? parsed.items
            : null;

    if (!list) return null;

    return list
      .map((entry, index) =>
        normalizeParsedRecipient(
          typeof entry === 'string' || (entry && typeof entry === 'object')
            ? (entry as string | Parameters<typeof normalizeParsedRecipient>[0])
            : '',
          index
        )
      )
      .filter((row): row is ParsedRecipientRow => Boolean(row));
  } catch {
    return null;
  }
}

function parseRecipientLineEntries(line: string, startingIndex: number) {
  const normalized = line.replace(/\t/g, ',').replace(/;/g, ',').trim();
  if (!normalized) return [];

  const parts = normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1 && parts.every((part) => looksLikeAddress(part))) {
    return parts.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  if (parts.length === 1) {
    const only = parts[0];
    if (looksLikeAddress(only)) {
      return [
        {
          label: `Recipient ${startingIndex + 1}`,
          address: only,
          notes: '',
          source: 'paste' as const,
        },
      ];
    }

    const looseAddresses = only
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => looksLikeAddress(part));

    if (looseAddresses.length === 0) return [];

    return looseAddresses.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  const addressIndex = parts.findIndex((part) => looksLikeAddress(part));
  if (addressIndex === -1) {
    const looseAddresses = normalized
      .split(/[\s,;]+/)
      .map((part) => part.trim())
      .filter((part) => looksLikeAddress(part));

    return looseAddresses.map((address, index) => ({
      label: `Recipient ${startingIndex + index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
  }

  const address = parts[addressIndex];
  const remaining = parts.filter((_, partIndex) => partIndex !== addressIndex);
  const label = remaining[0] || `Recipient ${startingIndex + 1}`;
  const notes = remaining.slice(1).join(', ');

  return [
    {
      label,
      address,
      notes,
      source: 'paste' as const,
    },
  ];
}

function parseRecipientText(text: string) {
  const jsonRows = parseRecipientJson(text);
  if (jsonRows && jsonRows.length > 0) return jsonRows;

  const lineRows = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<ParsedRecipientRow[]>((rows, line) => {
      const parsedRows = parseRecipientLineEntries(line, rows.length);
      rows.push(...parsedRows);
      return rows;
    }, []);

  if (lineRows.length > 0) return lineRows;

  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => looksLikeAddress(part))
    .map((address, index) => ({
      label: `Recipient ${index + 1}`,
      address,
      notes: '',
      source: 'paste' as const,
    }));
}

function describeAmountRule(mode: AmountRuleMode) {
  switch (mode) {
    case 'has_token':
      return 'Only matching holders';
    case 'tiered_balance':
      return 'Balance tiers';
    case 'fixed':
    default:
      return 'Same for everyone';
  }
}

const DistributorScreen: React.FC<DistributorScreenProps> = ({
  sdk,
  workspace,
  availableTokens,
  feeFundingSats,
  feeFundingUtxoCount,
}) => {
  const currentNetwork =
    sdk.wallet.getContext().network === 'chipnet' ? Network.CHIPNET : Network.MAINNET;
  const [recipients, setRecipients] = useState<DistributionRecipient[]>([]);
  const [jobs, setJobs] = useState<DistributionJobRecord[]>([]);
  const [recipientSelection, setRecipientSelection] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const [recipientSourceMode, setRecipientSourceMode] = useState<RecipientSourceMode>('manual');
  const [scanBusy, setScanBusy] = useState(false);
  const [tokenMetadata, setTokenMetadata] = useState<
    Record<string, { name: string; symbol: string; decimals: number }>
  >({});
  const [step, setStep] = useState<FlowStep>('recipients');
  const [txPreview, setTxPreview] = useState<DistributionTxPreview | null>(null);
  const [txPreviewBusy, setTxPreviewBusy] = useState(false);
  const [txPreviewError, setTxPreviewError] = useState('');
  const [showRecipientsPopup, setShowRecipientsPopup] = useState(false);
  const [showTokenImportPopup, setShowTokenImportPopup] = useState(false);
  const [showPayoutPreviewPopup, setShowPayoutPreviewPopup] = useState(false);
  const [showPayoutRulePopup, setShowPayoutRulePopup] = useState(false);
  const [showTxPreviewPopup, setShowTxPreviewPopup] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showManualReferenceInput, setShowManualReferenceInput] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [tokenImportBusy, setTokenImportBusy] = useState(false);
  const [payoutPreviewBusy, setPayoutPreviewBusy] = useState(false);
  const [payoutPreviewRows, setPayoutPreviewRows] = useState<
    Array<{
      recipientId: string;
      label: string;
      address: string;
      amount: string;
    }>
  >([]);
  const [distributionDraft, setDistributionDraft] = useState({
    assetType: workspace.default_asset_type === 'bch' ? ('bch' as const) : ('token' as const),
    tokenCategory: workspace.default_token_category || '',
    amount: workspace.default_amount || '1',
  });
  const [amountRuleDraft, setAmountRuleDraft] = useState({
    mode: 'fixed' as AmountRuleMode,
    referenceCategory: '',
    tiers: [
      { minBalance: '1', amount: workspace.default_amount || '1' },
      { minBalance: '10', amount: workspace.default_amount || '5' },
      { minBalance: '100', amount: workspace.default_amount || '10' },
    ],
  });
  const [tokenImportDraft, setTokenImportDraft] = useState({
    includeCategory: '',
    excludeCategory: '',
    limit: '200',
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;

    try {
      const raw = window.localStorage.getItem(DISTRIBUTOR_DRAFT_STORAGE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw) as {
        workspaceId?: string;
        recipients?: DistributionRecipient[];
        jobs?: DistributionJobRecord[];
        recipientSelection?: Record<string, boolean>;
        importText?: string;
        recipientSourceMode?: RecipientSourceMode;
        step?: FlowStep;
        distributionDraft?: {
          assetType?: 'token' | 'bch';
          tokenCategory?: string;
          amount?: string;
        };
        amountRuleDraft?: {
          mode?: AmountRuleMode;
          referenceCategory?: string;
          tiers?: Array<{ minBalance?: string; amount?: string }>;
        };
        tokenImportDraft?: {
          includeCategory?: string;
          excludeCategory?: string;
          limit?: string;
        };
      };

      if (parsed.workspaceId && parsed.workspaceId !== workspace.id) return;

      if (Array.isArray(parsed.recipients)) {
        setRecipients(parsed.recipients);
      }
      if (Array.isArray(parsed.jobs)) {
        setJobs(parsed.jobs);
      }
      if (parsed.recipientSelection && typeof parsed.recipientSelection === 'object') {
        setRecipientSelection(parsed.recipientSelection);
      }
      if (typeof parsed.importText === 'string') {
        setImportText(parsed.importText);
      }
      if (
        parsed.recipientSourceMode === 'manual' ||
        parsed.recipientSourceMode === 'token'
      ) {
        setRecipientSourceMode(parsed.recipientSourceMode);
      }
      if (
        parsed.step === 'recipients' ||
        parsed.step === 'asset' ||
        parsed.step === 'send'
      ) {
        setStep(parsed.step);
      }
      if (parsed.distributionDraft) {
        setDistributionDraft((prev) => ({
          assetType:
            parsed.distributionDraft?.assetType === 'bch' ? 'bch' : prev.assetType,
          tokenCategory:
            typeof parsed.distributionDraft?.tokenCategory === 'string'
              ? parsed.distributionDraft.tokenCategory
              : prev.tokenCategory,
          amount:
            typeof parsed.distributionDraft?.amount === 'string'
              ? parsed.distributionDraft.amount
              : prev.amount,
        }));
      }
      if (parsed.amountRuleDraft) {
        setAmountRuleDraft((prev) => ({
          mode:
            parsed.amountRuleDraft?.mode === 'has_token' ||
            parsed.amountRuleDraft?.mode === 'tiered_balance'
              ? parsed.amountRuleDraft.mode
              : 'fixed',
          referenceCategory:
            typeof parsed.amountRuleDraft?.referenceCategory === 'string'
              ? parsed.amountRuleDraft.referenceCategory
              : prev.referenceCategory,
          tiers:
            Array.isArray(parsed.amountRuleDraft?.tiers) &&
            parsed.amountRuleDraft.tiers.length > 0
              ? parsed.amountRuleDraft.tiers.map((tier) => ({
                  minBalance: typeof tier?.minBalance === 'string' ? tier.minBalance : '1',
                  amount: typeof tier?.amount === 'string' ? tier.amount : '1',
                }))
              : prev.tiers,
        }));
      }
      if (parsed.tokenImportDraft) {
        setTokenImportDraft((prev) => ({
          includeCategory:
            typeof parsed.tokenImportDraft?.includeCategory === 'string'
              ? parsed.tokenImportDraft.includeCategory
              : prev.includeCategory,
          excludeCategory:
            typeof parsed.tokenImportDraft?.excludeCategory === 'string'
              ? parsed.tokenImportDraft.excludeCategory
              : prev.excludeCategory,
          limit:
            typeof parsed.tokenImportDraft?.limit === 'string'
              ? parsed.tokenImportDraft.limit
              : prev.limit,
        }));
      }
    } catch {
      // Ignore invalid persisted drafts.
    }
  }, [workspace.id]);

  const tokenOptions = useMemo(
    () =>
      availableTokens
        .filter((token) => {
          try {
            return BigInt(token.tokenBalance || '0') > 0n;
          } catch {
            return false;
          }
        })
        .map((token) => ({
          category: token.category,
          label:
            tokenMetadata[token.category]?.name ||
            tokenMetadata[token.category]?.symbol
              ? `${tokenMetadata[token.category]?.name || tokenMetadata[token.category]?.symbol} · ${token.tokenBalance}`
              : `${shortenMiddle(token.category, 14, 10)} · ${token.tokenBalance}`,
        })),
    [availableTokens, tokenMetadata]
  );
  const includePickerValue = tokenOptions.some(
    (token) => token.category === tokenImportDraft.includeCategory
  )
    ? tokenImportDraft.includeCategory
    : '';
  const excludePickerValue = tokenOptions.some(
    (token) => token.category === tokenImportDraft.excludeCategory
  )
    ? tokenImportDraft.excludeCategory
    : '';

  useEffect(() => {
    const defaultTokenCategory =
      workspace.default_token_category ||
      availableTokens[0]?.category ||
      '';
    setDistributionDraft({
      assetType: workspace.default_asset_type === 'bch' ? 'bch' : 'token',
      tokenCategory: defaultTokenCategory,
      amount: workspace.default_amount || '1',
    });
  }, [workspace, availableTokens]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const categories = Array.from(
        new Set(
          availableTokens
            .filter((token) => {
              try {
                return BigInt(token.tokenBalance || '0') > 0n;
              } catch {
                return false;
              }
            })
            .map((token) => token.category)
        )
      );

      if (categories.length === 0) return;

      const nextEntries: Array<[string, { name: string; symbol: string; decimals: number }]> =
        [];

      for (const category of categories) {
        if (tokenMetadata[category]) continue;
        try {
          const metadata = await sdk.bcmr.getTokenMetadata(category);
          if (!metadata) continue;
          nextEntries.push([
            category,
            {
              name: metadata.name || '',
              symbol: metadata.token?.symbol || '',
              decimals: metadata.token?.decimals ?? 0,
            },
          ]);
        } catch {
          // ignore individual token metadata failures
        }
      }

      if (!cancelled && nextEntries.length > 0) {
        setTokenMetadata((prev) => ({
          ...prev,
          ...Object.fromEntries(nextEntries),
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [availableTokens, sdk, tokenMetadata]);

  const selectedRecipientIds = useMemo(
    () =>
      recipients
        .filter((recipient) => recipientSelection[recipient.id])
        .map((recipient) => recipient.id),
    [recipients, recipientSelection]
  );
  const preparedJobs = useMemo(
    () => jobs.filter((job) => job.status === 'prepared'),
    [jobs]
  );
  const preparedJobsPreviewKey = useMemo(
    () =>
      preparedJobs
        .map((job) =>
          [
            job.id,
            job.status,
            job.asset_type,
            job.token_category || '',
            job.amount,
            job.destination_address,
          ].join(':')
        )
        .join('|'),
    [preparedJobs]
  );
  const selectedRecipientCount = selectedRecipientIds.length;
  const selectedTokenBalance = useMemo(() => {
    const match = availableTokens.find(
      (token) => token.category === distributionDraft.tokenCategory
    );
    try {
      return BigInt(match?.tokenBalance || '0');
    } catch {
      return 0n;
    }
  }, [availableTokens, distributionDraft.tokenCategory]);
  const requestedAmountRaw = distributionDraft.amount.trim();
  const requestedAmountNumber = Number(requestedAmountRaw);
  const requestedAmountIsWholeNumber =
    requestedAmountRaw.length > 0 &&
    Number.isFinite(requestedAmountNumber) &&
    requestedAmountNumber > 0 &&
    Number.isInteger(requestedAmountNumber);
  const requestedAmountBigInt = requestedAmountIsWholeNumber
    ? BigInt(requestedAmountRaw)
    : 0n;
  const amountRuleNeedsReference = amountRuleDraft.mode !== 'fixed';
  const amountRuleReferenceInvalid =
    amountRuleNeedsReference &&
    !/^[0-9a-f]{64}$/.test(amountRuleDraft.referenceCategory.trim().toLowerCase());
  const tierRuleInvalid =
    amountRuleDraft.mode === 'tiered_balance' &&
    amountRuleDraft.tiers.filter((tier) => tier.minBalance.trim() && tier.amount.trim()).length === 0;
  const activeTierCount = amountRuleDraft.tiers.filter(
    (tier) => tier.minBalance.trim() && tier.amount.trim()
  ).length;
  const totalRequestedTokenAmount =
    distributionDraft.assetType === 'token' && amountRuleDraft.mode === 'fixed'
      ? requestedAmountBigInt * BigInt(selectedRecipientCount)
      : 0n;
  const tokenBalanceInsufficient =
    distributionDraft.assetType === 'token' &&
    amountRuleDraft.mode === 'fixed' &&
    selectedRecipientCount > 0 &&
    requestedAmountIsWholeNumber &&
    totalRequestedTokenAmount > selectedTokenBalance;
  const estimatedFeeSats = useMemo(() => {
    const base = distributionDraft.assetType === 'token' ? 320 : 220;
    const perRecipient = distributionDraft.assetType === 'token' ? 85 : 45;
    const extraOutput = distributionDraft.assetType === 'token' ? 60 : 34;
    return base + selectedRecipientCount * perRecipient + extraOutput;
  }, [distributionDraft.assetType, selectedRecipientCount]);
  const estimatedTokenFundingSats =
    distributionDraft.assetType === 'token' && amountRuleDraft.mode === 'fixed'
      ? selectedRecipientCount * 1000 + estimatedFeeSats + 1000
      : 0;
  const estimatedBchFundingSats =
    distributionDraft.assetType === 'bch' &&
    amountRuleDraft.mode === 'fixed' &&
    requestedAmountIsWholeNumber
      ? selectedRecipientCount * requestedAmountNumber + estimatedFeeSats + 1000
      : 0;
  const plainBchFundingInsufficient =
    distributionDraft.assetType === 'token' && amountRuleDraft.mode === 'fixed'
      ? feeFundingSats < estimatedTokenFundingSats || feeFundingUtxoCount === 0
      : distributionDraft.assetType === 'bch' &&
          amountRuleDraft.mode === 'fixed' &&
          requestedAmountIsWholeNumber
        ? feeFundingSats < estimatedBchFundingSats || feeFundingUtxoCount === 0
        : feeFundingUtxoCount === 0;
  const prepareBlockedReason =
    selectedRecipientCount === 0
      ? 'Select at least one recipient.'
      : !requestedAmountRaw
        ? 'Enter an amount to continue.'
        : !requestedAmountIsWholeNumber
          ? 'Use a whole-number amount.'
          : distributionDraft.assetType === 'token' && !distributionDraft.tokenCategory
            ? 'Choose a token from this wallet.'
            : amountRuleReferenceInvalid
              ? 'Choose a valid reference token.'
              : tierRuleInvalid
                ? 'Add at least one valid tier.'
            : tokenBalanceInsufficient
              ? 'Not enough CashTokens for this batch.'
              : plainBchFundingInsufficient
                ? 'Not enough plain BCH UTXOs to fund outputs and fees.'
                : '';

  const importRows = useMemo(() => parseRecipientText(importText), [importText]);

  const pasteFromClipboard = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) {
      throw new Error('Clipboard paste is not available in this environment.');
    }
    const text = await navigator.clipboard.readText();
    setImportText(text);
  };

  const appendRecipientText = (value: string) => {
    const next = value.trim();
    if (!next) return;
    setImportText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${next}` : next));
  };

  const scanRecipientQr = async () => {
    try {
      setScanBusy(true);
      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });

      const scanned = result?.ScanResult?.trim();
      if (!scanned) {
        await Toast.show({ text: 'No QR detected. Try again.' });
        return;
      }

      const parsed = parseBip21Uri(scanned, currentNetwork);
      if (parsed.isValidAddress) {
        appendRecipientText(parsed.normalizedAddress);
        setError('');
        await Toast.show({ text: 'Recipient address added.' });
        return;
      }

      if (looksLikeAddress(scanned)) {
        appendRecipientText(scanned);
        setError('');
        await Toast.show({ text: 'Recipient address added.' });
        return;
      }

      await Toast.show({ text: 'QR did not contain a supported BCH address.' });
    } catch (scanError) {
      console.error('Recipient QR scan failed:', scanError);
      await Toast.show({
        text: getBarcodeScannerErrorMessage(scanError),
      });
    } finally {
      setScanBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;

    if (step !== 'send' || preparedJobs.length === 0) {
      setTxPreview(null);
      setTxPreviewError('');
      setTxPreviewBusy(false);
      return;
    }

    void (async () => {
      try {
        setTxPreviewBusy(true);
        setTxPreviewError('');
        const preview = await buildApprovedDistributionTransaction(sdk, preparedJobs);
        if (!cancelled) {
          setTxPreview(preview);
        }
      } catch (previewError) {
        if (!cancelled) {
          setTxPreview(null);
          setTxPreviewError(
            previewError instanceof Error
              ? previewError.message
              : 'Failed to build transaction preview.'
          );
        }
      } finally {
        if (!cancelled) {
          setTxPreviewBusy(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [preparedJobs, preparedJobsPreviewKey, sdk, step]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hasDraft =
      recipients.length > 0 ||
      jobs.length > 0 ||
      importText.trim().length > 0 ||
      recipientSourceMode !== 'manual' ||
      step !== 'recipients' ||
      distributionDraft.amount !== (workspace.default_amount || '1') ||
        distributionDraft.assetType !==
        (workspace.default_asset_type === 'bch' ? 'bch' : 'token') ||
      distributionDraft.tokenCategory !== (workspace.default_token_category || '') ||
      amountRuleDraft.mode !== 'fixed' ||
      amountRuleDraft.referenceCategory.trim().length > 0 ||
      amountRuleDraft.tiers.some(
        (tier, index) =>
          tier.minBalance !== (index === 0 ? '1' : index === 1 ? '10' : '100') ||
          tier.amount !==
            (index === 0
              ? workspace.default_amount || '1'
              : index === 1
                ? workspace.default_amount || '5'
                : workspace.default_amount || '10')
      ) ||
      tokenImportDraft.includeCategory.trim().length > 0 ||
      tokenImportDraft.excludeCategory.trim().length > 0 ||
      tokenImportDraft.limit.trim() !== '200';

    if (!hasDraft) {
      window.localStorage.removeItem(DISTRIBUTOR_DRAFT_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      DISTRIBUTOR_DRAFT_STORAGE_KEY,
      JSON.stringify({
        workspaceId: workspace.id,
        recipients,
        jobs,
        recipientSelection,
        importText,
        recipientSourceMode,
        step,
        distributionDraft,
        amountRuleDraft,
        tokenImportDraft,
      })
    );
  }, [
    amountRuleDraft,
    distributionDraft,
    importText,
    jobs,
    recipientSourceMode,
    recipientSelection,
    recipients,
    step,
    tokenImportDraft,
    workspace.default_amount,
    workspace.default_asset_type,
    workspace.default_token_category,
    workspace.id,
  ]);

  const resetAirdropFlow = () => {
    const defaultTokenCategory =
      workspace.default_token_category || availableTokens[0]?.category || '';
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(DISTRIBUTOR_DRAFT_STORAGE_KEY);
    }
    setRecipients([]);
    setJobs([]);
    setRecipientSelection({});
    setImportText('');
    setRecipientSourceMode('manual');
    setStep('recipients');
    setTxPreview(null);
    setTxPreviewBusy(false);
    setTxPreviewError('');
    setShowRecipientsPopup(false);
    setShowTokenImportPopup(false);
    setShowPayoutPreviewPopup(false);
    setShowPayoutRulePopup(false);
    setShowTxPreviewPopup(false);
    setShowSendConfirm(false);
    setShowManualReferenceInput(false);
    setTokenImportBusy(false);
    setPayoutPreviewBusy(false);
    setPayoutPreviewRows([]);
    setDistributionDraft({
      assetType: workspace.default_asset_type === 'bch' ? 'bch' : 'token',
      tokenCategory: defaultTokenCategory,
      amount: workspace.default_amount || '1',
    });
    setAmountRuleDraft({
      mode: 'fixed',
      referenceCategory: '',
      tiers: [
        { minBalance: '1', amount: workspace.default_amount || '1' },
        { minBalance: '10', amount: workspace.default_amount || '5' },
        { minBalance: '100', amount: workspace.default_amount || '10' },
      ],
    });
    setTokenImportDraft({
      includeCategory: '',
      excludeCategory: '',
      limit: '200',
    });
  };

  const loadTokenHolderBalances = async (
    category: string,
    options?: {
      maxResults?: number;
      targetAddressKeys?: Set<string>;
    }
  ) => {
    const results = new Map<string, { address: string; balance: bigint }>();
    let cursor: string | undefined;
    const maxResults = options?.maxResults ?? 500;

    while (results.size < maxResults) {
      const page = await sdk.tokenIndex.listTokenHolders({
        category,
        limit: Math.min(200, maxResults - results.size),
        cursor,
      });

      for (const holder of page.holders) {
        const address = holder.locking_address?.trim();
        if (!address || !looksLikeAddress(address)) continue;
        const key = normalizeAddressKey(address);
        if (
          options?.targetAddressKeys &&
          !options.targetAddressKeys.has(key)
        ) {
          continue;
        }
        try {
          results.set(key, {
            address,
            balance: BigInt(holder.ft_balance || '0'),
          });
        } catch {
          // ignore malformed balances
        }
      }

      if (
        options?.targetAddressKeys &&
        results.size >= options.targetAddressKeys.size
      ) {
        break;
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor ?? undefined;
    }

    return results;
  };

  const importTokenHolders = async () => {
    const includeCategory = tokenImportDraft.includeCategory.trim().toLowerCase();
    const excludeCategory = tokenImportDraft.excludeCategory.trim().toLowerCase();
    const requestedLimit = Math.min(
      Math.max(Number.parseInt(tokenImportDraft.limit, 10) || 200, 1),
      500
    );

    if (!/^[0-9a-f]{64}$/.test(includeCategory)) {
      throw new Error('Enter a valid include token category.');
    }
    if (excludeCategory && !/^[0-9a-f]{64}$/.test(excludeCategory)) {
      throw new Error('Exclude token category must be 64-character hex.');
    }

    const includeAddresses = await loadTokenHolderBalances(includeCategory, {
      maxResults: requestedLimit,
    });
    if (includeAddresses.size === 0) {
      throw new Error('No token-holder addresses were returned for that category.');
    }

    let excludeAddresses = new Set<string>();
    if (excludeCategory) {
      const loadedExclude = await loadTokenHolderBalances(excludeCategory, {
        maxResults: requestedLimit,
      });
      excludeAddresses = new Set(loadedExclude.keys());
    }

    const existingAddressKeys = new Set(
      recipients.map((recipient) => normalizeAddressKey(recipient.address))
    );
    const newRecipients: DistributionRecipient[] = [];

    for (const [addressKey, holder] of includeAddresses.entries()) {
      if (excludeAddresses.has(addressKey) || existingAddressKeys.has(addressKey)) continue;
      newRecipients.push({
        id: makeLocalId('rcp'),
        workspace_id: workspace.id,
        label: `Holder ${newRecipients.length + 1}`,
        address: holder.address,
        notes: `Imported from ${shortenMiddle(includeCategory, 10, 8)}`,
        source: 'tokenindex',
        created_at: new Date().toISOString(),
      });
    }

    if (newRecipients.length === 0) {
      throw new Error('No new recipients matched the current token filter.');
    }

    setRecipients((prev) => [...prev, ...newRecipients]);
    setRecipientSelection((prev) => ({
      ...prev,
      ...Object.fromEntries(newRecipients.map((recipient) => [recipient.id, true])),
    }));
    setStatus(
      `Imported ${newRecipients.length} token holder${newRecipients.length === 1 ? '' : 's'}.`
    );
    setError('');
    setShowTokenImportPopup(false);
  };

  const resolvePreparedJobs = async () => {
    const selectedRecipients = recipients.filter((recipient) =>
      selectedRecipientIds.includes(recipient.id)
    );

    if (selectedRecipients.length === 0) {
      throw new Error('Select at least one recipient.');
    }

    if (!requestedAmountIsWholeNumber) {
      throw new Error('Use a whole-number amount.');
    }

    const nextJobs: DistributionJobRecord[] = [];
    const baseAmount = BigInt(requestedAmountRaw);

    if (amountRuleDraft.mode === 'fixed') {
      for (const recipient of selectedRecipients) {
        nextJobs.push({
          id: makeLocalId('job'),
          workspace_id: workspace.id,
          recipient_id: recipient.id,
          destination_address: recipient.address,
          asset_type: distributionDraft.assetType,
          token_category:
            distributionDraft.assetType === 'token'
              ? distributionDraft.tokenCategory
              : undefined,
          amount: requestedAmountRaw,
          status: 'prepared',
          created_at: new Date().toISOString(),
        });
      }
      return nextJobs;
    }

    const referenceCategory = amountRuleDraft.referenceCategory.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(referenceCategory)) {
      throw new Error('Choose a valid reference token category.');
    }

    const selectedAddressKeys = new Set(
      selectedRecipients.map((recipient) => normalizeAddressKey(recipient.address))
    );
    const balanceMap = await loadTokenHolderBalances(referenceCategory, {
      maxResults: Math.max(selectedRecipients.length * 3, 200),
      targetAddressKeys: selectedAddressKeys,
    });

    if (amountRuleDraft.mode === 'has_token') {
      for (const recipient of selectedRecipients) {
        const match = balanceMap.get(normalizeAddressKey(recipient.address));
        if (!match || match.balance <= 0n) continue;
        nextJobs.push({
          id: makeLocalId('job'),
          workspace_id: workspace.id,
          recipient_id: recipient.id,
          destination_address: recipient.address,
          asset_type: distributionDraft.assetType,
          token_category:
            distributionDraft.assetType === 'token'
              ? distributionDraft.tokenCategory
              : undefined,
          amount: baseAmount.toString(),
          status: 'prepared',
          created_at: new Date().toISOString(),
        });
      }
      if (nextJobs.length === 0) {
        throw new Error('No selected recipients hold the required reference token.');
      }
      return nextJobs;
    }

    const tiers = amountRuleDraft.tiers
      .map((tier) => ({
        minBalance: tier.minBalance.trim(),
        amount: tier.amount.trim(),
      }))
      .filter((tier) => tier.minBalance && tier.amount)
      .map((tier) => {
        if (!/^\d+$/.test(tier.minBalance) || !/^\d+$/.test(tier.amount)) {
          throw new Error('Tier balances and amounts must be whole numbers.');
        }
        return {
          minBalance: BigInt(tier.minBalance),
          amount: BigInt(tier.amount),
        };
      })
      .sort((a, b) => (a.minBalance > b.minBalance ? -1 : a.minBalance < b.minBalance ? 1 : 0));

    if (tiers.length === 0) {
      throw new Error('Add at least one valid tier.');
    }

    for (const recipient of selectedRecipients) {
      const match = balanceMap.get(normalizeAddressKey(recipient.address));
      const balance = match?.balance ?? 0n;
      const appliedTier = tiers.find((tier) => balance >= tier.minBalance);
      if (!appliedTier || appliedTier.amount <= 0n) continue;
      nextJobs.push({
        id: makeLocalId('job'),
        workspace_id: workspace.id,
        recipient_id: recipient.id,
        destination_address: recipient.address,
        asset_type: distributionDraft.assetType,
        token_category:
          distributionDraft.assetType === 'token'
            ? distributionDraft.tokenCategory
            : undefined,
        amount: appliedTier.amount.toString(),
        status: 'prepared',
        created_at: new Date().toISOString(),
      });
    }

    if (nextJobs.length === 0) {
      throw new Error('No selected recipients matched the current tier rule.');
    }

    return nextJobs;
  };

  const previewResolvedPayouts = async () => {
    const nextJobs = await resolvePreparedJobs();
    const recipientById = new Map(recipients.map((recipient) => [recipient.id, recipient]));
    setPayoutPreviewRows(
      nextJobs.map((job) => {
        const recipient = recipientById.get(job.recipient_id);
        return {
          recipientId: job.recipient_id,
          label: recipient?.label || 'Recipient',
          address: job.destination_address,
          amount: job.amount,
        };
      })
    );
    setShowPayoutPreviewPopup(true);
  };

  return (
    <div className="space-y-2 overflow-x-hidden">
      {status ? (
        <div className="wallet-success-panel wallet-success-appear rounded-2xl px-4 py-3 text-sm">
          {status}
        </div>
      ) : null}
      {error ? (
        <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="px-1 text-xs font-medium wallet-text-strong">
        Step {step === 'recipients' ? '1' : step === 'asset' ? '2' : '3'} ·{' '}
        {step === 'recipients'
          ? 'Recipients'
          : step === 'asset'
            ? 'Asset'
            : 'Send'}
      </div>

      {step === 'recipients' ? (
        <SectionCard title="Recipients" className="p-4">
          <div className="space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  recipientSourceMode === 'manual'
                    ? 'border-emerald-400 wallet-surface-strong'
                    : 'border-white/10 bg-transparent'
                }`}
                onClick={() => setRecipientSourceMode('manual')}
              >
                <div className="text-sm font-semibold wallet-text-strong">
                  Manual
                </div>
                <div className="text-xs wallet-muted mt-1">
                  Paste or scan addresses
                </div>
              </button>
              <button
                type="button"
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  recipientSourceMode === 'token'
                    ? 'border-emerald-400 wallet-surface-strong'
                    : 'border-white/10 bg-transparent'
                }`}
                onClick={() => setRecipientSourceMode('token')}
              >
                <div className="text-sm font-semibold wallet-text-strong">
                  By Token
                </div>
                <div className="text-xs wallet-muted mt-1">
                  Import holders by category
                </div>
              </button>
            </div>
            {recipientSourceMode === 'manual' ? (
              <>
                <textarea
                  className="wallet-input w-full"
                  rows={4}
                  placeholder="bchtest:...&#10;bchtest:...&#10;bchtest:..."
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                />
                <div className="grid grid-cols-3 gap-2">
                  <button
                    className="wallet-btn-secondary w-full"
                    onClick={() =>
                      void (async () => {
                        try {
                          await pasteFromClipboard();
                          setError('');
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : 'Failed to read clipboard.'
                          );
                        }
                      })()
                    }
                  >
                    Paste
                  </button>
                  <button
                    className="wallet-btn-secondary w-full"
                    disabled={scanBusy}
                    onClick={() => void scanRecipientQr()}
                  >
                    {scanBusy ? 'Scanning…' : 'Scan QR'}
                  </button>
                  <button
                    className="wallet-btn-primary w-full"
                    disabled={importRows.length === 0}
                    onClick={() =>
                      void (async () => {
                        try {
                          const newRecipients: DistributionRecipient[] =
                            importRows.map((row) => ({
                              id: makeLocalId('rcp'),
                              workspace_id: workspace.id,
                              label: row.label,
                              address: row.address,
                              notes: row.notes,
                              source: row.source,
                              created_at: new Date().toISOString(),
                            }));
                          setRecipients((prev) => [...prev, ...newRecipients]);
                          setRecipientSelection((prev) => ({
                            ...prev,
                            ...Object.fromEntries(
                              newRecipients.map((recipient) => [
                                recipient.id,
                                true,
                              ])
                            ),
                          }));
                          setStatus(
                            `Imported ${importRows.length} recipient${importRows.length === 1 ? '' : 's'}.`
                          );
                          setError('');
                          setImportText('');
                        } catch (err) {
                          setError(
                            err instanceof Error
                              ? err.message
                              : 'Failed to add recipients.'
                          );
                        }
                      })()
                    }
                  >
                    Add
                  </button>
                </div>
              </>
            ) : (
              <div className="wallet-surface-strong rounded-2xl px-4 py-3 space-y-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="wallet-surface rounded-full px-3 py-1 wallet-text-strong">
                    {tokenImportDraft.includeCategory
                      ? `Include ${shortenMiddle(tokenImportDraft.includeCategory, 8, 6)}`
                      : 'No include token'}
                  </span>
                  {tokenImportDraft.excludeCategory ? (
                    <span className="wallet-surface rounded-full px-3 py-1 wallet-muted">
                      Exclude{' '}
                      {shortenMiddle(tokenImportDraft.excludeCategory, 8, 6)}
                    </span>
                  ) : null}
                </div>
                <button
                  className="wallet-btn-secondary w-full"
                  onClick={() => setShowTokenImportPopup(true)}
                >
                  Configure Token Import
                </button>
              </div>
            )}
            {recipients.length > 0 ? (
              <button
                className="wallet-btn-secondary w-full"
                onClick={() => setShowRecipientsPopup(true)}
              >
                {selectedRecipientCount} Selected · Edit
              </button>
            ) : null}
            <button
              className="wallet-btn-primary w-full"
              disabled={selectedRecipientIds.length === 0}
              onClick={() => setStep('asset')}
            >
              Continue to Asset
            </button>
          </div>
        </SectionCard>
      ) : null}

      {step === 'asset' ? (
        <SectionCard title="Asset" className="p-4">
          <div className="space-y-2.5">
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 space-y-3">
              <div className="text-sm font-medium wallet-text-strong">
                What are you sending?
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select
                  className="wallet-select"
                  value={distributionDraft.assetType}
                  onChange={(event) =>
                    setDistributionDraft((prev) => ({
                      ...prev,
                      assetType: event.target.value === 'bch' ? 'bch' : 'token',
                    }))
                  }
                >
                  <option value="token">Token</option>
                  <option value="bch">BCH</option>
                </select>
                <input
                  className="wallet-input"
                  placeholder={
                    distributionDraft.assetType === 'bch'
                      ? 'Sats each'
                      : 'Amount each'
                  }
                  value={distributionDraft.amount}
                  onChange={(event) =>
                    setDistributionDraft((prev) => ({
                      ...prev,
                      amount: event.target.value,
                    }))
                  }
                />
              </div>
              {distributionDraft.assetType === 'token' ? (
                <select
                  className="wallet-select"
                  value={distributionDraft.tokenCategory}
                  onChange={(event) =>
                    setDistributionDraft((prev) => ({
                      ...prev,
                      tokenCategory: event.target.value,
                    }))
                  }
                >
                  <option value="">Choose token from wallet</option>
                  {tokenOptions.map((token) => (
                    <option key={token.category} value={token.category}>
                      {token.label}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 space-y-3">
              <div className="text-sm font-medium wallet-text-strong">
                How should payouts work?
              </div>
              <div className="grid grid-cols-1 gap-2">
                {[
                  {
                    mode: 'fixed' as AmountRuleMode,
                    title: 'Same for everyone',
                    description: 'One amount to all selected recipients.',
                  },
                  {
                    mode: 'has_token' as AmountRuleMode,
                    title: 'Only matching holders',
                    description:
                      'Only recipients holding another token get paid.',
                  },
                  {
                    mode: 'tiered_balance' as AmountRuleMode,
                    title: 'Balance tiers',
                    description: 'Use token balances to vary the payout.',
                  },
                ].map((option) => {
                  const active = amountRuleDraft.mode === option.mode;
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      className={`text-left rounded-2xl border px-4 py-3 transition ${
                        active
                          ? 'border-emerald-400 wallet-surface-strong'
                          : 'border-white/10 bg-transparent'
                      }`}
                      onClick={() =>
                        setAmountRuleDraft((prev) => ({
                          ...prev,
                          mode: option.mode,
                        }))
                      }
                    >
                      <div className="text-sm font-semibold wallet-text-strong">
                        {option.title}
                      </div>
                      <div className="text-xs wallet-muted mt-1">
                        {option.description}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="wallet-surface rounded-full px-3 py-1 wallet-text-strong">
                  {describeAmountRule(amountRuleDraft.mode)}
                </span>
                <span className="wallet-surface rounded-full px-3 py-1 wallet-muted">
                  {selectedRecipientCount} selected
                </span>
                {amountRuleDraft.mode === 'tiered_balance' ? (
                  <span className="wallet-surface rounded-full px-3 py-1 wallet-muted">
                    {activeTierCount} tiers
                  </span>
                ) : null}
                {amountRuleNeedsReference &&
                amountRuleDraft.referenceCategory ? (
                  <span className="wallet-surface rounded-full px-3 py-1 wallet-muted">
                    Ref {shortenMiddle(amountRuleDraft.referenceCategory, 8, 6)}
                  </span>
                ) : null}
              </div>
              {amountRuleDraft.mode !== 'fixed' ? (
                <button
                  type="button"
                  className="wallet-btn-secondary w-full"
                  onClick={() => setShowPayoutRulePopup(true)}
                >
                  Configure Payout Rule
                </button>
              ) : null}
            </div>
            {distributionDraft.assetType === 'token' &&
            tokenOptions.length === 0 ? (
              <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
                No wallet tokens available for token distribution.
              </div>
            ) : null}
            {tokenBalanceInsufficient ? (
              <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
                This batch needs {totalRequestedTokenAmount.toString()}{' '}
                CashTokens, but the selected wallet token only has{' '}
                {selectedTokenBalance.toString()}.
              </div>
            ) : null}
            {plainBchFundingInsufficient ? (
              <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
                This wallet needs more plain BCH UTXOs to cover recipient sats
                and network fees. Token UTXOs are not used to pay fees in this
                flow.
              </div>
            ) : null}
            <button
              className="wallet-btn-secondary w-full"
              disabled={Boolean(prepareBlockedReason) || payoutPreviewBusy}
              onClick={() =>
                void (async () => {
                  try {
                    setPayoutPreviewBusy(true);
                    await previewResolvedPayouts();
                    setError('');
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : 'Failed to preview payouts.'
                    );
                  } finally {
                    setPayoutPreviewBusy(false);
                  }
                })()
              }
            >
              {payoutPreviewBusy ? 'Previewing…' : 'Preview Payouts'}
            </button>
            <button
              className="wallet-btn-primary w-full"
              disabled={Boolean(prepareBlockedReason)}
              onClick={() =>
                void (async () => {
                  try {
                    const nextJobs = await resolvePreparedJobs();
                    const totalPreparedAmount = nextJobs.reduce(
                      (sum, job) => sum + BigInt(job.amount),
                      0n
                    );
                    if (
                      distributionDraft.assetType === 'token' &&
                      totalPreparedAmount > selectedTokenBalance
                    ) {
                      throw new Error(
                        'Not enough CashTokens for the resolved batch.'
                      );
                    }
                    setJobs(nextJobs);
                    setStatus(
                      `Prepared ${nextJobs.length} recipient${nextJobs.length === 1 ? '' : 's'}.`
                    );
                    setError('');
                    setStep('send');
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : 'Failed to prepare jobs.'
                    );
                  }
                })()
              }
            >
              Continue to Send
            </button>
            {prepareBlockedReason ? (
              <div className="text-xs wallet-muted text-center">
                {prepareBlockedReason}
              </div>
            ) : null}
            <button
              className="wallet-btn-secondary w-full"
              onClick={() => setStep('recipients')}
            >
              Back to Recipients
            </button>
          </div>
        </SectionCard>
      ) : null}

      {step === 'send' ? (
        <SectionCard title="Send" className="p-4">
          <div className="space-y-2">
            {txPreviewBusy ? (
              <div className="wallet-surface-strong rounded-2xl px-4 py-3 text-sm wallet-muted">
                Building transaction preview…
              </div>
            ) : null}
            {txPreviewError ? (
              <div className="wallet-warning-panel rounded-2xl px-4 py-3 text-sm">
                {txPreviewError}
              </div>
            ) : null}
            <div className="text-sm wallet-muted">
              {preparedJobs.length} recipients · total{' '}
              {preparedJobs
                .reduce((sum, job) => sum + BigInt(job.amount), 0n)
                .toString()}{' '}
              · {distributionDraft.assetType === 'token' ? 'Token' : 'BCH'}
              {txPreview ? ` · fee ${txPreview.feeSats} sats` : ''}
            </div>
            {jobs.length === 0 ? (
              <p className="text-sm wallet-muted">No prepared jobs yet.</p>
            ) : (
              <>
                {txPreview ? (
                  <button
                    className="wallet-btn-secondary w-full mb-2"
                    onClick={() => setShowTxPreviewPopup(true)}
                  >
                    Review Transaction
                  </button>
                ) : null}
                {preparedJobs.length > 0 ? (
                  <button
                    className="wallet-btn-primary w-full mb-2"
                    disabled={txPreviewBusy || !!txPreviewError || !txPreview}
                    onClick={() => setShowSendConfirm(true)}
                  >
                    Send Airdrop
                  </button>
                ) : null}
              </>
            )}
            <button
              className="wallet-btn-secondary w-full mt-2"
              onClick={() => setStep('asset')}
            >
              Back to Asset
            </button>
          </div>
        </SectionCard>
      ) : null}

      {showTxPreviewPopup && txPreview ? (
        <Popup
          closePopups={() => setShowTxPreviewPopup(false)}
          closeButtonText="Done"
        >
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold wallet-text-strong">
                Transaction Review
              </div>
              <div className="text-sm wallet-muted">
                {txPreview.inputs.length} inputs ·{' '}
                {txPreview.finalOutputs.length} outputs · {txPreview.feeSats}{' '}
                sats fee
              </div>
            </div>
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 text-sm space-y-2">
              <div className="font-medium wallet-text-strong">Inputs</div>
              <div className="max-h-44 overflow-y-auto pr-1 space-y-2">
                {txPreview.inputs.map((input, index) => (
                  <div
                    key={`${input.tx_hash}:${input.tx_pos}:${index}`}
                    className="text-xs wallet-muted break-all"
                  >
                    {input.token
                      ? `Token input · ${shortenMiddle(input.token.category, 12, 8)} · ${String(input.token.amount)}`
                      : `BCH fee input · ${shortenMiddle(input.tx_hash, 12, 8)}:${input.tx_pos} · ${input.amount ?? input.value} sats`}
                  </div>
                ))}
              </div>
            </div>
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 text-sm space-y-2">
              <div className="font-medium wallet-text-strong">Outputs</div>
              <div className="max-h-52 overflow-y-auto pr-1 space-y-2">
                {txPreview.finalOutputs.map((output, index) =>
                  'recipientAddress' in output ? (
                    <div
                      key={`${output.recipientAddress}:${index}`}
                      className="text-xs wallet-muted break-all"
                    >
                      <div className="wallet-text-strong">
                        {output.token
                          ? output.recipientAddress ===
                            txPreview.tokenChangeAddress
                            ? 'Token change'
                            : 'Token recipient'
                          : output.recipientAddress === txPreview.changeAddress
                            ? 'BCH change'
                            : 'BCH recipient'}
                      </div>
                      <div>{output.recipientAddress}</div>
                      <div>{String(output.amount)} sats</div>
                      {output.token ? (
                        <div>
                          {shortenMiddle(output.token.category, 12, 8)} ·{' '}
                          {String(output.token.amount)}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div
                      key={`opreturn:${index}`}
                      className="text-xs wallet-muted"
                    >
                      OP_RETURN
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        </Popup>
      ) : null}

      {showPayoutRulePopup ? (
        <Popup
          closePopups={() => setShowPayoutRulePopup(false)}
          closeButtonText="Done"
        >
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold wallet-text-strong">
                Payout Rule
              </div>
              <div className="text-sm wallet-muted">
                Configure how recipient amounts are decided.
              </div>
            </div>

            {amountRuleNeedsReference ? (
              <div className="wallet-surface-strong rounded-2xl px-4 py-3 space-y-2">
                <div className="text-sm font-medium wallet-text-strong">
                  {amountRuleDraft.mode === 'has_token'
                    ? 'Required holder token'
                    : 'Reference balance token'}
                </div>
                {!showManualReferenceInput && tokenOptions.length > 0 ? (
                  <select
                    className="wallet-select"
                    value={amountRuleDraft.referenceCategory}
                    onChange={(event) =>
                      setAmountRuleDraft((prev) => ({
                        ...prev,
                        referenceCategory: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose token</option>
                    {tokenOptions.map((token) => (
                      <option
                        key={`rule:${token.category}`}
                        value={token.category}
                      >
                        {token.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {showManualReferenceInput || tokenOptions.length === 0 ? (
                  <input
                    className="wallet-input w-full"
                    placeholder="Paste token category"
                    value={amountRuleDraft.referenceCategory}
                    onChange={(event) =>
                      setAmountRuleDraft((prev) => ({
                        ...prev,
                        referenceCategory: event.target.value,
                      }))
                    }
                  />
                ) : null}
                {tokenOptions.length > 0 ? (
                  <button
                    type="button"
                    className="text-xs wallet-muted underline underline-offset-4"
                    onClick={() => setShowManualReferenceInput((prev) => !prev)}
                  >
                    {showManualReferenceInput
                      ? 'Use wallet token picker'
                      : 'Paste category instead'}
                  </button>
                ) : null}
              </div>
            ) : null}

            {amountRuleDraft.mode === 'tiered_balance' ? (
              <div className="wallet-surface-strong rounded-2xl px-4 py-3 space-y-3">
                <div className="text-sm font-medium wallet-text-strong">
                  Payout tiers
                </div>
                {amountRuleDraft.tiers.map((tier, index) => (
                  <div key={`popup-tier:${index}`} className="space-y-2">
                    <div className="text-xs uppercase tracking-wide wallet-muted">
                      Tier {index + 1}
                    </div>
                    <div className="text-xs wallet-muted">
                      If holder has at least this balance, send this amount.
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        className="wallet-input"
                        placeholder="Holds at least"
                        value={tier.minBalance}
                        onChange={(event) =>
                          setAmountRuleDraft((prev) => ({
                            ...prev,
                            tiers: prev.tiers.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, minBalance: event.target.value }
                                : entry
                            ),
                          }))
                        }
                      />
                      <input
                        className="wallet-input"
                        placeholder="Send"
                        value={tier.amount}
                        onChange={(event) =>
                          setAmountRuleDraft((prev) => ({
                            ...prev,
                            tiers: prev.tiers.map((entry, entryIndex) =>
                              entryIndex === index
                                ? { ...entry, amount: event.target.value }
                                : entry
                            ),
                          }))
                        }
                      />
                    </div>
                    {amountRuleDraft.tiers.length > 1 ? (
                      <button
                        type="button"
                        className="text-xs wallet-muted underline underline-offset-4"
                        onClick={() =>
                          setAmountRuleDraft((prev) => ({
                            ...prev,
                            tiers: prev.tiers.filter(
                              (_, entryIndex) => entryIndex !== index
                            ),
                          }))
                        }
                      >
                        Remove tier
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  type="button"
                  className="wallet-btn-secondary w-full"
                  onClick={() =>
                    setAmountRuleDraft((prev) => ({
                      ...prev,
                      tiers: [...prev.tiers, { minBalance: '', amount: '' }],
                    }))
                  }
                >
                  Add Tier
                </button>
              </div>
            ) : null}
          </div>
        </Popup>
      ) : null}

      {showPayoutPreviewPopup ? (
        <Popup
          closePopups={() => setShowPayoutPreviewPopup(false)}
          closeButtonText="Done"
        >
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold wallet-text-strong">
                Payout Preview
              </div>
              <div className="text-sm wallet-muted">
                {payoutPreviewRows.length} recipients qualify for this batch.
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto pr-1 space-y-2">
              {payoutPreviewRows.map((row) => (
                <div
                  key={`${row.recipientId}:${row.address}`}
                  className="wallet-surface-strong rounded-[18px] p-3"
                >
                  <div className="font-medium wallet-text-strong">
                    {row.label}
                  </div>
                  <div className="mt-1 text-xs wallet-muted break-all">
                    {row.address}
                  </div>
                  <div className="mt-2 text-sm wallet-text-strong">
                    {row.amount}{' '}
                    {distributionDraft.assetType === 'token' ? 'token' : 'sats'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Popup>
      ) : null}

      <ContainedSwipeConfirmModal
        open={showSendConfirm && Boolean(txPreview)}
        title="Send Airdrop"
        subtitle={
          txPreview
            ? `${preparedJobs.length} recipients · fee ${txPreview.feeSats} sats`
            : undefined
        }
        warning="Broadcasts immediately after confirmation."
        loading={sendBusy}
        onCancel={() => {
          if (sendBusy) return;
          setShowSendConfirm(false);
        }}
        onConfirm={() => {
          void (async () => {
            if (!txPreview) return;
            try {
              setSendBusy(true);
              const result = await executeApprovedDistributionSend(
                sdk,
                {
                  completeDistributionJob: async ({ jobId, status, txid }) => {
                    setJobs((prev) =>
                      prev.map((job) =>
                        job.id === jobId
                          ? {
                              ...job,
                              status,
                              txid: txid ?? job.txid,
                              completed_at: new Date().toISOString(),
                            }
                          : job
                      )
                    );
                    return {};
                  },
                },
                preparedJobs
              );
              setStatus(
                result.broadcastState === 'submitted'
                  ? `Distribution submitted for ${preparedJobs.length} job${
                      preparedJobs.length === 1 ? '' : 's'
                    }. Keep the txid and avoid sending again until it appears in history.`
                  : `Sent ${preparedJobs.length} distribution job${
                      preparedJobs.length === 1 ? '' : 's'
                    } in one transaction.`
              );
              setError('');
              resetAirdropFlow();
            } catch (sendError) {
              setError(
                sendError instanceof Error
                  ? sendError.message
                  : 'Failed to send batch distribution.'
              );
            } finally {
              setSendBusy(false);
              setShowSendConfirm(false);
            }
          })();
        }}
      >
        {txPreview ? (
          <div className="space-y-3">
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 text-sm">
              {preparedJobs.length} recipients · total{' '}
              {preparedJobs
                .reduce((sum, job) => sum + BigInt(job.amount), 0n)
                .toString()}{' '}
              · {distributionDraft.assetType === 'token' ? 'Token' : 'BCH'}
            </div>
            <div className="wallet-surface-strong rounded-2xl px-4 py-3 text-sm">
              {txPreview.inputs.length} inputs · {txPreview.finalOutputs.length}{' '}
              outputs
            </div>
          </div>
        ) : null}
      </ContainedSwipeConfirmModal>

      {showRecipientsPopup ? (
        <Popup
          closePopups={() => setShowRecipientsPopup(false)}
          closeButtonText="Done"
        >
          <div className="space-y-4">
            <div>
              <div className="text-lg font-semibold wallet-text-strong">
                Recipients
              </div>
              <div className="text-sm wallet-muted">
                Select who should receive this airdrop.
              </div>
            </div>
            <div className="space-y-2">
              {recipients.length === 0 ? (
                <p className="text-sm wallet-muted">
                  No recipients loaded yet.
                </p>
              ) : (
                recipients.map((recipient) => (
                  <label
                    key={recipient.id}
                    className="wallet-surface-strong rounded-[18px] p-3 flex items-start gap-3 overflow-hidden"
                  >
                    <input
                      type="checkbox"
                      checked={Boolean(recipientSelection[recipient.id])}
                      onChange={(event) =>
                        setRecipientSelection((prev) => ({
                          ...prev,
                          [recipient.id]: event.target.checked,
                        }))
                      }
                    />
                    <div className="min-w-0">
                      <div className="font-medium wallet-text-strong">
                        {recipient.label}
                      </div>
                      <div className="mt-1 text-xs wallet-muted break-all">
                        {recipient.address}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        </Popup>
      ) : null}

      {showTokenImportPopup ? (
        <Popup
          closePopups={() => setShowTokenImportPopup(false)}
          closeButtonText="Done"
        >
          <div className="space-y-4 min-w-0 overflow-x-hidden">
            <div>
              <div className="text-lg font-semibold wallet-text-strong">
                Import by Token
              </div>
              <div className="text-sm wallet-muted">
                Add holders of one token, with an optional exclude token.
              </div>
            </div>
            {tokenOptions.length > 0 ? (
              <div className="space-y-2">
                <select
                  className="wallet-select min-w-0"
                  value={includePickerValue}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    setTokenImportDraft((prev) => ({
                      ...prev,
                      includeCategory: event.target.value,
                    }));
                  }}
                >
                  <option value="">Use wallet token for include</option>
                  {tokenOptions.map((token) => (
                    <option
                      key={`include:${token.category}`}
                      value={token.category}
                    >
                      {token.label}
                    </option>
                  ))}
                </select>
                <select
                  className="wallet-select min-w-0"
                  value={excludePickerValue}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    setTokenImportDraft((prev) => ({
                      ...prev,
                      excludeCategory: event.target.value,
                    }));
                  }}
                >
                  <option value="">Use wallet token for exclude</option>
                  {tokenOptions.map((token) => (
                    <option
                      key={`exclude:${token.category}`}
                      value={token.category}
                    >
                      {token.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <input
              className="wallet-input w-full"
              placeholder="Include token category"
              value={tokenImportDraft.includeCategory}
              onChange={(event) =>
                setTokenImportDraft((prev) => ({
                  ...prev,
                  includeCategory: event.target.value,
                }))
              }
            />
            <input
              className="wallet-input w-full"
              placeholder="Exclude token category (optional)"
              value={tokenImportDraft.excludeCategory}
              onChange={(event) =>
                setTokenImportDraft((prev) => ({
                  ...prev,
                  excludeCategory: event.target.value,
                }))
              }
            />
            <input
              className="wallet-input w-full"
              placeholder="Max holders"
              value={tokenImportDraft.limit}
              onChange={(event) =>
                setTokenImportDraft((prev) => ({
                  ...prev,
                  limit: event.target.value,
                }))
              }
            />
            <button
              className="wallet-btn-primary w-full"
              disabled={tokenImportBusy}
              onClick={() =>
                void (async () => {
                  try {
                    setTokenImportBusy(true);
                    await importTokenHolders();
                  } catch (err) {
                    setError(
                      err instanceof Error
                        ? err.message
                        : 'Failed to import token holders.'
                    );
                  } finally {
                    setTokenImportBusy(false);
                  }
                })()
              }
            >
              {tokenImportBusy ? 'Importing…' : 'Import Holders'}
            </button>
          </div>
        </Popup>
      ) : null}
    </div>
  );
};

export default DistributorScreen;
