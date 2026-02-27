// src/pages/apps/mintCashTokensPoCApp/MintCashTokensPoCApp.tsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Draggable from 'react-draggable';
import { useDispatch, useSelector } from 'react-redux';

import { RootState } from '../../../redux/store';
import { selectWalletId } from '../../../redux/walletSlice';
import { clearTransaction } from '../../../redux/transactionBuilderSlice';

import useFetchWalletData from '../../../hooks/useFetchWalletData';

import TransactionManager from '../../../apis/TransactionManager/TransactionManager';
import { TOKEN_OUTPUT_SATS } from '../../../utils/constants';

import type { TransactionOutput, UTXO } from '../../../types/types';
import { selectGenesisUtxos } from './selectGenesisUtxos';

import TxSummary from '../../../components/confirm/TxSummary';
import type {
  TxSummaryInput,
  TxSummaryOutput,
} from '../../../components/confirm/TxSummary';

type MintType = 'FT' | 'NFT';
type NftCapability = 'none' | 'mutable' | 'minting';

type MintConfig = {
  mintType: MintType;
  ftAmount: string;
  nftCapability: NftCapability;
  nftCommitment: string;
};

const DEFAULT_CFG: MintConfig = {
  mintType: 'FT',
  ftAmount: '1',
  nftCapability: 'none',
  nftCommitment: '',
};

type MintAppUtxo = UTXO;
type MintOutputDraft = {
  id: string;
  recipientCashAddr: string;
  sourceKey: string;
  config: MintConfig;
};

function utxoKey(u: UTXO): string {
  return `${u.tx_hash}:${u.tx_pos}`;
}

function shortHash(h: string, left = 10, right = 6) {
  if (!h) return '';
  if (h.length <= left + right + 3) return h;
  return `${h.slice(0, left)}…${h.slice(-right)}`;
}

function utxoValue(u: any): bigint {
  const v = u?.value ?? u?.amount ?? 0;
  try {
    return typeof v === 'bigint' ? v : BigInt(v);
  } catch {
    return 0n;
  }
}

function toBigIntSafe(x: string): bigint {
  try {
    const t = (x ?? '').trim();
    if (!t) return 0n;
    return BigInt(t);
  } catch {
    return 0n;
  }
}

function sumOutputs(outputs: TransactionOutput[]): bigint {
  return outputs.reduce((sum: bigint, o: any) => {
    if ('opReturn' in o && o.opReturn) return sum;
    const amt = o?.amount ?? 0;
    try {
      return sum + (typeof amt === 'bigint' ? amt : BigInt(amt));
    } catch {
      return sum;
    }
  }, 0n);
}

function asTxSummaryInputs(utxos: MintAppUtxo[]): TxSummaryInput[] {
  return utxos.map((u) => ({
    txid: u.tx_hash,
    vout: u.tx_pos,
    sats: Number(utxoValue(u)),
    token: !!u.token,
  }));
}

function asTxSummaryOutputs(
  outputs: TransactionOutput[] | undefined
): TxSummaryOutput[] {
  if (!outputs) return [];
  return outputs.map((o, index) => {
    if ('opReturn' in o && o.opReturn) {
      return {
        index,
        address: 'OP_RETURN',
        sats: 0,
        kind: 'bch' as const,
      };
    }
    return {
      index,
      address: o.recipientAddress,
      sats: Number(o.amount ?? 0),
      kind: o.token ? ('token' as const) : ('bch' as const),
    };
  });
}

const Badge: React.FC<{
  children: React.ReactNode;
  tone?: 'gray' | 'blue' | 'green' | 'amber';
}> = ({ children, tone = 'gray' }) => {
  const cls =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-700'
      : tone === 'green'
        ? 'bg-[#E9F7EE] text-[#1E7A3B]'
        : tone === 'amber'
          ? 'bg-amber-50 text-amber-800'
          : 'bg-gray-100 text-gray-600';
  return (
    <span
      className={`px-2 py-0.5 rounded-full text-[11px] font-semibold tracking-tight ${cls}`}
    >
      {children}
    </span>
  );
};

const PillButton: React.FC<{
  children: React.ReactNode;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}> = ({ children, active, onClick, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className={`px-3 py-2 rounded-xl text-sm font-semibold transition ${
      disabled
        ? 'bg-gray-200 text-gray-500'
        : active
          ? 'bg-green-600 text-white'
          : 'bg-gray-100 text-gray-800'
    }`}
  >
    {children}
  </button>
);

const CardShell: React.FC<{
  title: React.ReactNode;
  right?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  collapsible?: boolean;
}> = ({
  title,
  right,
  subtitle,
  children,
  open,
  onToggle,
  collapsible = true,
}) => (
  <div className="rounded-[20px] bg-white shadow-[0_6px_18px_rgba(0,0,0,0.06)] overflow-hidden">
    <button
      type="button"
      className={`w-full px-5 py-4 flex items-start justify-between gap-3 ${
        collapsible ? 'cursor-pointer' : 'cursor-default'
      }`}
      onClick={collapsible ? onToggle : undefined}
    >
      <div className="min-w-0 text-left">
        <div className="flex items-center gap-2">
          <div className="text-base font-semibold">{title}</div>
        </div>
        {subtitle ? (
          <div className="mt-1 text-sm text-gray-600 leading-snug">
            {subtitle}
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {right}
        {collapsible ? (
          <div className="text-gray-500 text-sm font-bold w-5 text-right">
            {open ? '−' : '+'}
          </div>
        ) : null}
      </div>
    </button>

    {open ? <div className="px-4 pb-4">{children}</div> : null}
  </div>
);

const Stepper: React.FC<{
  step: 1 | 2 | 3;
  canGoTo: (n: 1 | 2 | 3) => boolean;
  onStep: (n: 1 | 2 | 3) => void;
}> = ({ step, canGoTo, onStep }) => {
  const items: Array<{ n: 1 | 2 | 3; label: string }> = [
    { n: 1, label: 'Sources' },
    { n: 2, label: 'Recipients' },
    { n: 3, label: 'Amounts' },
  ];

  return (
    <div className="relative bg-gray-100 rounded-2xl p-1 flex">
      {items.map((item) => {
        const active = item.n === step;
        const enabled = canGoTo(item.n);

        return (
          <button
            key={item.n}
            type="button"
            disabled={!enabled}
            onClick={() => enabled && onStep(item.n)}
            className={`relative z-10 flex-1 py-2 text-sm font-semibold rounded-xl transition-all duration-200 ${
              active
                ? 'text-black'
                : enabled
                  ? 'text-gray-600'
                  : 'text-gray-300'
            }`}
          >
            {item.label}
          </button>
        );
      })}

      <div
        className="absolute top-1 bottom-1 w-1/3 bg-white rounded-xl shadow transition-all duration-300"
        style={{
          transform:
            step === 1
              ? 'translateX(0%)'
              : step === 2
                ? 'translateX(100%)'
                : 'translateX(200%)',
        }}
      />
    </div>
  );
};

const QuickChip: React.FC<{ label: string; onClick: () => void }> = ({
  label,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="px-2.5 py-1 rounded-full bg-gray-100 text-gray-800 text-xs font-semibold active:scale-[0.99]"
  >
    {label}
  </button>
);

const ContainedSwipeConfirmModal: React.FC<{
  open: boolean;
  title: string;
  subtitle?: string;
  warning?: React.ReactNode;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children?: React.ReactNode;
}> = ({
  open,
  title,
  subtitle,
  warning,
  loading = false,
  onCancel,
  onConfirm,
  children,
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = useState(0);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) {
      setDragX(0);
      setConfirmed(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyTouch = document.body.style.touchAction;

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.touchAction = prevBodyTouch;
    };
  }, [open]);

  if (!open) return null;

  const maxX = Math.max(0, (trackRef.current?.offsetWidth ?? 0) - 56);
  const threshold = Math.max(0, maxX - 10);

  const handleStop = () => {
    if (confirmed || loading) return;
    if (dragX >= threshold) {
      setConfirmed(true);
      try {
        onConfirm();
      } finally {
        setDragX(0);
        setConfirmed(false);
      }
    } else {
      setDragX(0);
    }
  };

  const progress = Math.min(100, (dragX / Math.max(1, maxX)) * 100);

  return (
    <div
      className="fixed left-0 right-0 z-[3000] px-5"
      // Keep clear of host header (top) and sticky action bar + bottom nav (bottom).
      style={{ top: 68, bottom: 154 }}
    >
      <div
        className="absolute inset-0 rounded-3xl bg-black/30"
        onClick={loading ? undefined : onCancel}
      />

      <div className="relative mx-auto h-full w-full max-w-[360px] flex items-center">
        <div className="w-full max-h-full bg-white rounded-3xl shadow-[0_18px_55px_rgba(0,0,0,0.22)] overflow-hidden flex flex-col">
          <div className="px-5 pt-5 pb-3 border-b border-gray-100">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-lg font-semibold text-gray-900">{title}</div>
                {subtitle ? (
                  <div className="text-sm text-gray-600 mt-1">{subtitle}</div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={onCancel}
                disabled={loading}
                className="shrink-0 inline-flex items-center justify-center rounded-full h-10 w-10 bg-gray-100 text-gray-700 disabled:opacity-50"
                aria-label="Cancel"
                title="Cancel"
              >
                ✕
              </button>
            </div>

            {warning ? (
              <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900">
                {warning}
              </div>
            ) : (
              <div className="mt-3 rounded-xl bg-amber-50 border border-amber-100 px-3 py-2 text-sm text-amber-900">
                Broadcasts immediately after confirmation.
              </div>
            )}
          </div>

          {children ? (
            <div className="px-5 py-4 flex-1 overflow-y-auto overscroll-contain">
              {children}
            </div>
          ) : null}

          <div className="px-5 pb-5 pt-3 border-t border-gray-100 bg-white">
            <div className="text-sm text-gray-600 mb-2">
              {loading ? 'Preparing…' : 'Swipe to confirm and send'}
            </div>

            <div
              ref={trackRef}
              className="relative w-full h-14 rounded-2xl bg-gray-100 overflow-hidden"
            >
              <div
                className="absolute left-0 top-0 h-14 bg-blue-600/10 pointer-events-none"
                style={{ width: `${progress}%` }}
              />

              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-base font-semibold text-gray-700">
                  {loading ? 'Sending…' : 'Drag to confirm'}
                </span>
              </div>

              <Draggable
                axis="x"
                bounds={{ left: 0, right: maxX }}
                position={{ x: dragX, y: 0 }}
                onDrag={(_, data) => setDragX(data.x)}
                onStop={handleStop}
                disabled={loading || confirmed}
              >
                <div className="absolute left-0 top-0 h-14 w-14 rounded-2xl bg-blue-600 shadow-lg flex items-center justify-center text-white text-xl select-none">
                  →
                </div>
              </Draggable>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const MintCashTokensPoCApp: React.FC = () => {
  const dispatch = useDispatch();
  const walletId = useSelector(selectWalletId);
  const utxosByAddress = useSelector((s: RootState) => s.utxos.utxos);

  const [addresses, setAddresses] = useState<
    { address: string; tokenAddress: string }[]
  >([]);
  const [changeAddress, setChangeAddress] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  const [selectedRecipientCashAddrs, setSelectedRecipientCashAddrs] = useState<
    Set<string>
  >(new Set());
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [outputDrafts, setOutputDrafts] = useState<MintOutputDraft[]>([]);
  const [expandedDraftId, setExpandedDraftId] = useState<string | null>(null);
  const draftSeq = useRef(0);

  const [loading, setLoading] = useState(false);
  const [txid, setTxid] = useState<string>('');
  const [status, setStatus] = useState<string>('');

  // Bootstrap
  const [bootstrapTxids, setBootstrapTxids] = useState<string[]>([]);
  const [showCreateMore, setShowCreateMore] = useState(false);

  // Step UI (mobile-friendly)
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // UX feedback (copy)
  const [toast, setToast] = useState<string>('');
  const toastTimer = useRef<number | null>(null);

  // Confirmation modal state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [confirmTitle, setConfirmTitle] = useState('');
  const [confirmSubtitle, setConfirmSubtitle] = useState('');
  const [confirmWarning, setConfirmWarning] = useState<React.ReactNode>(null);
  const [confirmBody, setConfirmBody] = useState<React.ReactNode>(null);
  const [pendingConfirmAction, setPendingConfirmAction] = useState<
    null | (() => Promise<void>)
  >(null);

  useFetchWalletData(
    walletId,
    setAddresses,
    (() => {}) as any,
    (() => {}) as any,
    (() => {}) as any,
    setChangeAddress,
    setErrorMessage
  );

  useEffect(() => {
    if (addresses.length === 0) return;
    if (selectedRecipientCashAddrs.size > 0) return;
    const first = addresses[0].address;
    setSelectedRecipientCashAddrs(new Set([first]));
  }, [addresses, selectedRecipientCashAddrs]);

  const flatUtxos: MintAppUtxo[] = useMemo(
    () => Object.values(utxosByAddress || {}).flat(),
    [utxosByAddress]
  );

  const walletGenesisCandidates: MintAppUtxo[] = useMemo(
    () => selectGenesisUtxos(flatUtxos),
    [flatUtxos]
  );

  const bootstrapGenesisUtxos: MintAppUtxo[] = useMemo(() => {
    const addr =
      Array.from(selectedRecipientCashAddrs)[0] ||
      addresses[0]?.address ||
      '';
    return bootstrapTxids.filter(Boolean).map((tx_hash) => ({
      tx_hash,
      tx_pos: 0,
      value: 1000,
      address: addr,
      height: 0,
      token: undefined,
      __synthetic: 'bootstrap',
    })) as any;
  }, [
    bootstrapTxids,
    selectedRecipientCashAddrs,
    addresses,
  ]);

  const displayGenesisUtxos: MintAppUtxo[] = useMemo(() => {
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

  const selectedUtxos: MintAppUtxo[] = useMemo(() => {
    if (selectedKeys.size === 0) return [];
    return displayGenesisUtxos.filter((u) => selectedKeys.has(utxoKey(u)));
  }, [displayGenesisUtxos, selectedKeys]);

  const selectedCount = selectedUtxos.length;
  const pendingCount = bootstrapGenesisUtxos.length;

  const orderedSelectedRecipients = useMemo(() => {
    const set = selectedRecipientCashAddrs;
    return addresses
      .map((a) => a.address)
      .filter((addr) => set.has(addr));
  }, [addresses, selectedRecipientCashAddrs]);

  const selectedRecipientCount = orderedSelectedRecipients.length;

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

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(''), 1400);
  };

  const copyText = async (txt: string, label = 'Copied') => {
    try {
      await navigator.clipboard.writeText(txt);
      showToast(label);
    } catch {
      // Fallback for some mobile webviews
      try {
        const el = document.createElement('textarea');
        el.value = txt;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        showToast(label);
      } catch {
        showToast('Copy failed');
      }
    }
  };

  const addOutputDraft = () => {
    const recipientCashAddr = orderedSelectedRecipients[0];
    const sourceKey = selectedUtxos[0] ? utxoKey(selectedUtxos[0]) : '';
    if (!recipientCashAddr || !sourceKey) return;
    const id = `draft-${Date.now()}-${draftSeq.current++}`;
    setOutputDrafts((prev) => [
      ...prev,
      { id, recipientCashAddr, sourceKey, config: { ...DEFAULT_CFG } },
    ]);
    setExpandedDraftId(id);
  };

  const updateOutputDraft = (id: string, patch: Partial<MintOutputDraft>) => {
    setOutputDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
    );
  };

  const updateOutputDraftConfig = (
    id: string,
    patch: Partial<MintConfig>
  ) => {
    setOutputDrafts((prev) =>
      prev.map((d) =>
        d.id === id ? { ...d, config: { ...d.config, ...patch } } : d
      )
    );
  };

  const removeOutputDraft = (id: string) => {
    setOutputDrafts((prev) => prev.filter((d) => d.id !== id));
    setExpandedDraftId((prev) => (prev === id ? null : prev));
  };

  const toggleRecipient = (cashAddr: string) => {
    setSelectedRecipientCashAddrs((prev) => {
      const next = new Set(prev);
      if (next.has(cashAddr)) {
        next.delete(cashAddr);
      } else {
        next.add(cashAddr);
      }
      return next;
    });
  };

  const toggleSelect = (u: MintAppUtxo) => {
    const key = utxoKey(u);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  };

  const selectedSourceKeySet = useMemo(
    () => new Set(selectedUtxos.map((u) => utxoKey(u))),
    [selectedUtxos]
  );

  const selectedRecipientSet = useMemo(
    () => new Set(orderedSelectedRecipients),
    [orderedSelectedRecipients]
  );

  useEffect(() => {
    setOutputDrafts((prev) =>
      prev.filter(
        (d) =>
          selectedRecipientSet.has(d.recipientCashAddr) &&
          selectedSourceKeySet.has(d.sourceKey)
      )
    );
  }, [selectedRecipientSet, selectedSourceKeySet]);

  const activeOutputDrafts = useMemo(
    () =>
      outputDrafts.filter(
        (d) =>
          selectedRecipientSet.has(d.recipientCashAddr) &&
          selectedSourceKeySet.has(d.sourceKey)
      ),
    [outputDrafts, selectedRecipientSet, selectedSourceKeySet]
  );

  const openConfirm = (opts: {
    title: string;
    subtitle: string;
    warning?: React.ReactNode;
    body: React.ReactNode;
    onConfirm: () => Promise<void>;
  }) => {
    setConfirmTitle(opts.title);
    setConfirmSubtitle(opts.subtitle);
    setConfirmWarning(opts.warning ?? null);
    setConfirmBody(opts.body);
    setPendingConfirmAction(() => opts.onConfirm);
    setConfirmOpen(true);
  };

  // Build a bootstrap tx that creates output[0] = 1000 sats to myAddress
  const buildBootstrapTx = async (
    fundingUtxos: MintAppUtxo[],
    toAddress: string
  ) => {
    const tm = TransactionManager();
    const outputs: TransactionOutput[] = [
      { recipientAddress: toAddress, amount: 1000n },
    ];

    const built = await tm.buildTransaction(
      outputs,
      null,
      changeAddress,
      fundingUtxos
    );
    if (built.errorMsg) throw new Error(built.errorMsg);
    if (!built.finalOutputs || !built.finalTransaction)
      throw new Error('Failed to build bootstrap transaction.');

    const totalInput = fundingUtxos.reduce((sum, u) => sum + utxoValue(u), 0n);
    const totalOutput = sumOutputs(built.finalOutputs);
    const feePaid = totalInput - totalOutput;

    const changeOut = built.finalOutputs.find(
      (o: any) =>
        !('opReturn' in o) && o.recipientAddress === changeAddress && !o.token
    );
    const changeValue = changeOut
      ? typeof changeOut.amount === 'bigint'
        ? changeOut.amount
        : BigInt(changeOut.amount ?? 0)
      : 0n;

    return { tm, built, feePaid, changeValue };
  };

  const startBootstrapFlow = async () => {
    setErrorMessage('');
    setStatus('');
    setTxid('');

    if (!walletId || walletId <= 0) {
      setErrorMessage('No wallet selected.');
      return;
    }
    if (!changeAddress) {
      setErrorMessage('Change address not ready.');
      return;
    }

    const myAddress =
      orderedSelectedRecipients[0] ||
      addresses[0]?.address;
    if (!myAddress) {
      setErrorMessage('No wallet address available.');
      return;
    }

    // Create exactly one new source per transaction.
    // Fee inputs are strictly non-genesis (vout != 0) and non-token UTXOs.
    const feeCandidates = flatUtxos
      .filter((u) => !u.token && u.tx_pos !== 0)
      .sort((a, b) => (utxoValue(b) > utxoValue(a) ? 1 : -1));
    if (feeCandidates.length === 0) {
      setErrorMessage(
        'No fee UTXOs available. Need a non-token UTXO with vout != 0.'
      );
      return;
    }

    setLoading(true);
    try {
      dispatch(clearTransaction());
      const fundingUtxos = [feeCandidates[0]];
      const { tm, built, feePaid } = await buildBootstrapTx(
        fundingUtxos,
        myAddress
      );

      openConfirm({
        title: 'Create source',
        subtitle: 'Creates one new vout=0 source with 1000 sats.',
        warning: 'This will broadcast immediately after confirmation.',
        body: (
          <TxSummary
            inputs={asTxSummaryInputs(fundingUtxos)}
            outputs={asTxSummaryOutputs(
              built.finalOutputs as TransactionOutput[]
            )}
            bytes={built.bytecodeSize}
            fee={feePaid}
          />
        ),
        onConfirm: async () => {
          setConfirmLoading(true);
          try {
            setStatus('Broadcasting source creation...');
            const sent = await tm.sendTransaction(built.finalTransaction);
            const sentTxid = sent?.txid ?? '';
            if (!sentTxid)
              throw new Error(
                sent?.errorMessage || 'Broadcast returned no txid.'
              );

            setBootstrapTxids((prev) => [...prev, sentTxid]);
            setTxid(sentTxid);

            // Auto-select + config for quick continuation.
            const k = `${sentTxid}:0`;
            setSelectedKeys((prev) => new Set(prev).add(k));

            setStatus('Source created. Ready to mint.');
            showToast('Source created');
            setStep(2);
            setConfirmOpen(false);
          } finally {
            setConfirmLoading(false);
          }
        },
      });
    } catch (e: any) {
      console.error(e);
      setErrorMessage(e?.message || 'Bootstrap failed.');
      setStatus('');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Build mint tx:
   * - inputs: genesis (vout=0 selected) + fee utxos (vout!=0 && !token)
   * - outputs: N token outputs + auto change
   * Enforce 1 sat/byte by builder.
   */
  const prepareMint = async () => {
    setErrorMessage('');
    setTxid('');
    setStatus('');

    if (!walletId || walletId <= 0) {
      setErrorMessage('No wallet selected.');
      return;
    }
    if (selectedRecipientCount === 0) {
      setErrorMessage('Please select at least one recipient address.');
      return;
    }
    if (!changeAddress) {
      setErrorMessage('Change address not ready.');
      return;
    }
    if (selectedUtxos.length === 0) {
      setErrorMessage('Select at least one token source.');
      return;
    }
    if (activeOutputDrafts.length === 0) {
      setErrorMessage('Add at least one output mapping in Amounts.');
      return;
    }

    // Validate manual output mappings.
    for (const d of activeOutputDrafts) {
      if (!selectedRecipientSet.has(d.recipientCashAddr)) {
        setErrorMessage('An output references an unselected recipient.');
        return;
      }
      if (!selectedSourceKeySet.has(d.sourceKey)) {
        setErrorMessage('An output references an unselected source category.');
        return;
      }
      if (d.config.mintType === 'FT') {
        const amt = toBigIntSafe(d.config.ftAmount);
        if (amt <= 0n) {
          setErrorMessage(
            `FT amount must be > 0 for ${shortHash(
              d.sourceKey,
              10,
              0
            )} → ${shortHash(d.recipientCashAddr, 12, 8)}`
          );
          return;
        }
      }
    }

    setLoading(true);
    setStatus('Preparing transaction for review...');

    try {
      dispatch(clearTransaction());

      const tm = TransactionManager();

      const genesisInputs = selectedUtxos.filter(
        (u) => u.tx_pos === 0 && !u.token
      );
      if (genesisInputs.length === 0)
        throw new Error('No valid vout=0 non-token sources selected.');

      // Fee inputs: strictly non-genesis (tx_pos != 0) and non-token
      const genesisKeySet = new Set(genesisInputs.map((u) => utxoKey(u)));
      const feeCandidates = flatUtxos
        .filter((u) => !u.token && u.tx_pos !== 0)
        .filter((u) => !genesisKeySet.has(utxoKey(u)))
        .sort((a, b) => (utxoValue(b) > utxoValue(a) ? 1 : -1));

      if (feeCandidates.length === 0) {
        throw new Error(
          'No non-genesis UTXOs available to fund transaction fees.'
        );
      }

      let feeInputs: MintAppUtxo[] = [];
      let inputsForBuild: MintAppUtxo[] = [];
      let built: any = null;

      // Try adding fee inputs until builder is satisfied
      for (let i = 0; i < feeCandidates.length; i++) {
        feeInputs = [...feeInputs, feeCandidates[i]];
        inputsForBuild = [...genesisInputs, ...feeInputs];

        const outputs: TransactionOutput[] = [];

        const sourceByKey = new Map(genesisInputs.map((u) => [utxoKey(u), u]));
        for (const d of activeOutputDrafts) {
          const src = sourceByKey.get(d.sourceKey);
          if (!src) continue;
          const category = src.tx_hash;
          const isNFT = d.config.mintType === 'NFT';
          const tokenAmount = isNFT ? 0n : toBigIntSafe(d.config.ftAmount);

          const out = tm.addOutput(
            d.recipientCashAddr,
            TOKEN_OUTPUT_SATS,
            tokenAmount,
            category,
            inputsForBuild,
            addresses.map((a) => ({
              address: a.address,
              tokenAddress: a.tokenAddress,
            })),
            isNFT ? d.config.nftCapability : undefined,
            isNFT ? d.config.nftCommitment : undefined
          );

          if (!out) {
            throw new Error(
              `Failed creating output for ${shortHash(
                category,
                12,
                0
              )} → ${shortHash(d.recipientCashAddr, 12, 8)}`
            );
          }
          outputs.push(out);
        }

        const attempt = await tm.buildTransaction(
          outputs,
          null,
          changeAddress,
          inputsForBuild
        );
        if (!attempt.errorMsg) {
          built = attempt;
          break;
        }
      }

      if (!built || built.errorMsg) {
        throw new Error(built?.errorMsg || 'Failed to build mint transaction.');
      }

      const totalInput = inputsForBuild.reduce(
        (sum, u) => sum + utxoValue(u),
        0n
      );
      const totalOutput = sumOutputs(built.finalOutputs);
      const feePaid = totalInput - totalOutput;

      openConfirm({
        title: `Confirm mint (${activeOutputDrafts.length} output${
          activeOutputDrafts.length === 1 ? '' : 's'
        })`,
        subtitle: 'Fee policy: 1 sat/byte. Review before broadcast.',
        warning: <>This will broadcast immediately after confirmation.</>,
        body: (
          <TxSummary
            inputs={asTxSummaryInputs(inputsForBuild)}
            outputs={asTxSummaryOutputs(
              built.finalOutputs as TransactionOutput[]
            )}
            bytes={built.bytecodeSize}
            fee={feePaid}
          />
        ),
        onConfirm: async () => {
          setConfirmLoading(true);
          try {
            setStatus('Broadcasting mint transaction...');
            const sent = await tm.sendTransaction(built.finalTransaction);
            const sentTxid = sent?.txid ?? '';
            if (!sentTxid)
              throw new Error(sent?.errorMessage || 'Broadcast failed.');
            setTxid(sentTxid);
            setStatus('Mint successful.');
            setConfirmOpen(false);
            showToast('Broadcasted');
          } finally {
            setConfirmLoading(false);
          }
        },
      });

      setStatus('');
    } catch (e: any) {
      console.error(e);
      setErrorMessage(e?.message || 'Mint failed.');
      setStatus('');
    } finally {
      setLoading(false);
    }
  };

  const sourcesEmpty = displayGenesisUtxos.length === 0;

  return (
    <div className="relative px-4 pt-4 pb-36 max-w-3xl mx-auto space-y-6 bg-[#f6f6f7] min-h-screen">
      {/* Top header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold truncate">Mint CashTokens</h2>
            <Badge tone="gray">PoC</Badge>
          </div>
          <div className="text-[12px] text-gray-500 mt-1">
            Sources → recipients → set amounts → review & mint.
          </div>
        </div>

        {/* Lightweight toast */}
        {toast ? (
          <div className="px-3 py-2 rounded-xl bg-gray-900 text-white text-xs font-semibold">
            {toast}
          </div>
        ) : null}
      </div>

      {/* Stepper */}
      <Stepper
        step={step}
        canGoTo={(n) => {
          if (n === 1) return true;
          if (n === 2) return selectedCount > 0;
          return selectedCount > 0 && selectedRecipientCount > 0;
        }}
        onStep={setStep}
      />

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
            <CardShell
              title="Recipients"
              subtitle="Select one or more wallet addresses to receive minted tokens."
              right={
                <Badge tone={selectedRecipientCount > 0 ? 'green' : 'gray'}>
                  {selectedRecipientCount} selected
                </Badge>
              }
              open={true}
              collapsible={false}
              onToggle={() => {}}
            >
              <div className="space-y-3">
                <div className="rounded-[16px] bg-white shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden max-h-[280px] overflow-y-auto">
                  {addresses.map((a) => {
                    const checked = selectedRecipientCashAddrs.has(a.address);
                    const tokenAddr = recipientTokenAddressByCash[a.address] || '';
                    return (
                      <div
                        key={a.address}
                        className={`px-4 py-4 border-b border-gray-100 last:border-b-0 ${
                          checked ? 'bg-[#F2FBF5]' : 'bg-white'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleRecipient(a.address)}
                            className="mt-1 scale-110"
                          />

                          <div className="min-w-0 flex-1">
                            <div className="w-full text-left">
                              <div className="inline-flex items-center gap-2">
                                <span className="font-mono text-sm font-semibold truncate">
                                  {shortHash(a.address, 14, 10)}
                                </span>
                                {checked ? (
                                  <Badge tone="green">included</Badge>
                                ) : (
                                  <Badge>excluded</Badge>
                                )}
                              </div>
                              <div className="mt-1 text-[12px] text-gray-500 font-mono truncate">
                                token: {shortHash(tokenAddr, 18, 8)}
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            className="text-sm font-semibold text-blue-700 shrink-0"
                            onClick={() =>
                              copyText(a.address, 'Recipient copied')
                            }
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="text-[12px] text-gray-500 leading-snug">
                  Each selected recipient receives its own per-category allocation
                  in the Amounts step.
                </div>
              </div>
            </CardShell>
          </div>

          <div
            className={`w-1/3 px-1 shrink-0 transition-opacity duration-300 ${
              step === 1 ? 'opacity-100' : 'opacity-80'
            }`}
            style={{ order: 1 }}
          >
            <CardShell
              title="Sources"
              // subtitle="Select vout=0 non-token UTXOs. Each selected source mints a unique category."
              right={
                <div className="flex items-center gap-2">
                  <Badge>{`Sources: ${displayGenesisUtxos.length}`}</Badge>
                  <Badge
                    tone={selectedCount > 0 ? 'green' : 'gray'}
                  >{`Selected: ${selectedCount}`}</Badge>
                  {pendingCount > 0 ? (
                    <Badge tone="blue">{`Pending: ${pendingCount}`}</Badge>
                  ) : null}
                </div>
              }
              open={true}
              collapsible={false}
              onToggle={() => {}}
            >
              <div className="space-y-4">
                {sourcesEmpty ? (
                  <div className="rounded-2xl bg-amber-50 border border-amber-200 p-5 space-y-3">
                    <div className="text-base font-semibold text-amber-900">
                      No sources yet
                    </div>
                    <div className="text-sm text-amber-900/80">
                      Create one source to mint a new category.
                    </div>

                    <button
                      onClick={startBootstrapFlow}
                      disabled={loading || !changeAddress}
                      className="w-full px-4 py-3 rounded-xl bg-green-600 text-white font-semibold text-base"
                    >
                      {loading ? 'Preparing…' : 'Create source (vout=0)'}
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Selected chips summary row */}
                    <div className="space-y-2">
                      {/* <div className="text-sm text-gray-600 leading-snug">
                        Pick vout=0 UTXOs with no token. Each source becomes a
                        new token category.
                      </div> */}
                      <button
                        type="button"
                        className="inline-flex items-center gap-2 text-base font-semibold text-blue-700"
                        onClick={() => setShowCreateMore((v) => !v)}
                      >
                        <span>+ Create source</span>
                      </button>
                    </div>

                    {showCreateMore ? (
                      <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 space-y-3">
                        <div className="text-base font-semibold">
                          Create source
                        </div>
                        <div className="text-sm text-gray-600">
                          Creates a 1000-sat, vout=0 UTXO you can use as a token
                          category.
                        </div>

                        <button
                          onClick={startBootstrapFlow}
                          disabled={loading || !changeAddress}
                          className="w-full px-4 py-3 rounded-xl bg-green-600 text-white font-semibold text-base"
                        >
                          {loading ? 'Preparing…' : 'Create source (vout=0)'}
                        </button>
                      </div>
                    ) : null}

                    {/* Source list */}
                    <div className="rounded-[16px] bg-white shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden">
                      {displayGenesisUtxos.map((u) => {
                        const key = utxoKey(u);
                        const checked = selectedKeys.has(key);
                        const value = utxoValue(u);
                        const isBootstrap =
                          (u as any).__synthetic === 'bootstrap';

                        return (
                          <div
                            key={key}
                            className={`px-4 py-4 border-b border-gray-100 last:border-b-0 flex items-center gap-3 ${
                              checked ? 'bg-[#F2FBF5]' : 'bg-white'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleSelect(u)}
                              className="scale-110"
                            />
                            <button
                              type="button"
                              onClick={() =>
                                copyText(u.tx_hash, 'Category copied')
                              }
                              className="flex-1 min-w-0 text-left"
                            >
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center px-3 py-1.5 rounded-full bg-gray-100 text-gray-900 text-[13px] font-semibold font-mono truncate">
                                  {shortHash(u.tx_hash, 12, 8)}
                                </span>
                                {isBootstrap ? (
                                  <Badge tone="blue">bootstrap</Badge>
                                ) : null}
                              </div>
                              <div className="text-[12px] text-gray-500 mt-1">
                                {value.toString()} sats • vout {u.tx_pos}
                              </div>
                            </button>

                            {checked ? (
                              <button
                                type="button"
                                onClick={() => {
                                  toggleSelect(u);
                                  setStep(3);
                                }}
                                className="text-[13px] font-semibold text-gray-800"
                              >
                                Edit
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>

                    {/* <div className="pt-1 flex items-center justify-between gap-3 text-sm text-gray-500">
                      <div>Fees use your non-genesis UTXOs (vout ≠ 0).</div>
                      <button
                        type="button"
                        className="text-sm font-semibold text-gray-700"
                        onClick={() => {
                          if (selectedCount > 0) {
                            setStep(3);
                          }
                        }}
                        disabled={selectedCount === 0}
                      >
                        Continue →
                      </button>
                    </div> */}
                  </>
                )}
              </div>
            </CardShell>
          </div>

          <div
            className={`w-1/3 px-1 shrink-0 transition-opacity duration-300 ${
              step === 3 ? 'opacity-100' : 'opacity-80'
            }`}
            style={{ order: 3 }}
          >
            <CardShell
              title="Amounts"
              subtitle="Create manual output mappings: choose recipient, choose category, set FT/NFT details."
              right={
                activeOutputDrafts.length > 0 ? (
                  <Badge tone="green">{`${activeOutputDrafts.length} output${
                    activeOutputDrafts.length === 1 ? '' : 's'
                  }`}</Badge>
                ) : (
                  <Badge tone="gray">—</Badge>
                )
              }
              open={true}
              collapsible={false}
              onToggle={() => {}}
            >
              {selectedUtxos.length === 0 ? (
                <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 text-[12px] text-gray-600">
                  Select at least one source to configure mint amounts.
                </div>
              ) : selectedRecipientCount === 0 ? (
                <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 text-[12px] text-gray-600">
                  Select at least one recipient to configure per-recipient
                  allocations.
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[12px] text-gray-600">
                      Add one row per desired token output.
                    </div>
                    <button
                      type="button"
                      onClick={addOutputDraft}
                      className="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold"
                    >
                      + Add output
                    </button>
                  </div>

                  {activeOutputDrafts.length === 0 ? (
                    <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 text-[12px] text-gray-600">
                      No outputs configured yet. Add an output mapping.
                    </div>
                  ) : null}

                  {activeOutputDrafts.map((d, idx) => {
                    const source = selectedUtxos.find(
                      (u) => utxoKey(u) === d.sourceKey
                    );
                    if (!source) return null;
                    const open = expandedDraftId === d.id;
                    const collapsedLabel =
                      d.config.mintType === 'NFT'
                        ? `NFT • ${d.config.nftCapability}`
                        : `FT • ${d.config.ftAmount || '0'}`;
                    return (
                      <div
                        key={d.id}
                        className="rounded-[16px] bg-white shadow-[0_1px_0_rgba(0,0,0,0.08)] overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedDraftId(open ? null : d.id)}
                          className="w-full px-5 py-4 flex items-center justify-between"
                        >
                          <div className="min-w-0 text-left">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold">
                                Output {idx + 1}
                              </span>
                              <Badge
                                tone={
                                  d.config.mintType === 'NFT' ? 'blue' : 'green'
                                }
                              >
                                {d.config.mintType}
                              </Badge>
                            </div>
                            <div className="mt-1 text-[12px] text-gray-500 font-mono truncate">
                              {shortHash(d.recipientCashAddr, 14, 10)} ←{' '}
                              {shortHash(source.tx_hash, 12, 8)} • {collapsedLabel}
                            </div>
                          </div>
                          <div className="text-gray-500 font-bold text-lg">
                            {open ? '−' : '+'}
                          </div>
                        </button>
                        {open ? <div className="h-px bg-gray-100" /> : null}

                        {open ? (
                          <div className="px-5 pb-5 pt-4 space-y-4">
                            <div className="grid grid-cols-1 gap-3">
                              <div>
                                <label className="block text-sm font-semibold mb-1">
                                  Recipient
                                </label>
                                <select
                                  value={d.recipientCashAddr}
                                  onChange={(e) =>
                                    updateOutputDraft(d.id, {
                                      recipientCashAddr: e.target.value,
                                    })
                                  }
                                  className="border border-gray-200 p-3 w-full rounded-xl bg-white"
                                >
                                  {orderedSelectedRecipients.map((addr) => (
                                    <option key={addr} value={addr}>
                                      {addr}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <div>
                                <label className="block text-sm font-semibold mb-1">
                                  Category source
                                </label>
                                <select
                                  value={d.sourceKey}
                                  onChange={(e) =>
                                    updateOutputDraft(d.id, {
                                      sourceKey: e.target.value,
                                    })
                                  }
                                  className="border border-gray-200 p-3 w-full rounded-xl bg-white"
                                >
                                  {selectedUtxos.map((u) => {
                                    const k = utxoKey(u);
                                    return (
                                      <option key={k} value={k}>
                                        {k}
                                      </option>
                                    );
                                  })}
                                </select>
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <PillButton
                                active={d.config.mintType === 'FT'}
                                onClick={() =>
                                  updateOutputDraftConfig(d.id, {
                                    mintType: 'FT',
                                  })
                                }
                              >
                                FT
                              </PillButton>
                              <PillButton
                                active={d.config.mintType === 'NFT'}
                                onClick={() =>
                                  updateOutputDraftConfig(d.id, {
                                    mintType: 'NFT',
                                  })
                                }
                              >
                                NFT
                              </PillButton>
                            </div>

                            {d.config.mintType === 'FT' ? (
                              <div className="space-y-2">
                                <label className="block text-sm font-semibold">
                                  FT amount
                                </label>
                                <input
                                  type="number"
                                  min="1"
                                  value={d.config.ftAmount}
                                  onChange={(e) =>
                                    updateOutputDraftConfig(d.id, {
                                      ftAmount: e.target.value,
                                    })
                                  }
                                  className="border border-gray-100 bg-gray-50 p-4 w-full rounded-[16px] text-2xl font-semibold tracking-tight"
                                />
                                <div className="flex flex-wrap gap-2">
                                  <QuickChip
                                    label="1"
                                    onClick={() =>
                                      updateOutputDraftConfig(d.id, {
                                        ftAmount: '1',
                                      })
                                    }
                                  />
                                  <QuickChip
                                    label="10"
                                    onClick={() =>
                                      updateOutputDraftConfig(d.id, {
                                        ftAmount: '10',
                                      })
                                    }
                                  />
                                  <QuickChip
                                    label="100"
                                    onClick={() =>
                                      updateOutputDraftConfig(d.id, {
                                        ftAmount: '100',
                                      })
                                    }
                                  />
                                  <QuickChip
                                    label="1k"
                                    onClick={() =>
                                      updateOutputDraftConfig(d.id, {
                                        ftAmount: '1000',
                                      })
                                    }
                                  />
                                </div>
                              </div>
                            ) : (
                              <div className="space-y-2">
                                <label className="block text-sm font-semibold">
                                  NFT capability
                                </label>
                                <select
                                  value={d.config.nftCapability}
                                  onChange={(e) =>
                                    updateOutputDraftConfig(d.id, {
                                      nftCapability: e.target
                                        .value as NftCapability,
                                    })
                                  }
                                  className="border border-gray-200 p-3 w-full rounded-xl bg-white"
                                >
                                  <option value="none">none</option>
                                  <option value="mutable">mutable</option>
                                  <option value="minting">minting</option>
                                </select>

                                <details className="rounded-xl bg-gray-50 border border-gray-200 p-3">
                                  <summary className="text-sm font-semibold cursor-pointer">
                                    Advanced
                                  </summary>
                                  <div className="mt-3 space-y-2">
                                    <label className="block text-sm font-semibold">
                                      NFT commitment (optional)
                                    </label>
                                    <input
                                      type="text"
                                      value={d.config.nftCommitment}
                                      onChange={(e) =>
                                        updateOutputDraftConfig(d.id, {
                                          nftCommitment: e.target.value,
                                        })
                                      }
                                      className="border border-gray-200 p-3 w-full rounded-xl bg-white"
                                      placeholder="hex or text (passed through as-is)"
                                    />
                                  </div>
                                </details>
                              </div>
                            )}

                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setOutputDrafts((prev) => [
                                    ...prev,
                                    {
                                      ...d,
                                      id: `draft-${Date.now()}-${draftSeq.current++}`,
                                    },
                                  ])
                                }
                                className="px-3 py-2 rounded-xl bg-gray-100 text-gray-900 text-sm font-semibold"
                              >
                                Duplicate
                              </button>
                              <button
                                type="button"
                                onClick={() => removeOutputDraft(d.id)}
                                className="px-3 py-2 rounded-xl bg-red-50 text-red-700 text-sm font-semibold"
                              >
                                Remove
                              </button>
                            </div>

                            <div className="text-[12px] text-gray-500">
                              Token outputs use at least{' '}
                              <span className="font-mono font-semibold">
                                TOKEN_OUTPUT_SATS
                              </span>{' '}
                              sats.
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardShell>
          </div>
        </div>
      </div>

      {/* Status / errors */}
      {(errorMessage || status || txid) && (
        <div className="rounded-2xl border border-gray-200 bg-white shadow-sm p-4 space-y-2">
          {errorMessage && (
            <div className="rounded-xl bg-red-50 text-red-800 text-sm p-3">
              {errorMessage}
            </div>
          )}
          {status && (
            <div className="rounded-xl bg-gray-100 text-sm p-3">{status}</div>
          )}
          {txid && (
            <div className="rounded-xl bg-green-50 text-sm p-3 break-all">
              <div className="font-semibold flex items-center justify-between">
                Broadcast txid
                <button
                  type="button"
                  className="text-sm font-semibold text-blue-700"
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

      {/* Sticky bottom “wallet-style” action bar */}
      <div className="fixed left-0 right-0 bottom-20 z-[1000] px-4">
        <div className="max-w-3xl mx-auto rounded-[22px] bg-white shadow-[0_10px_30px_rgba(0,0,0,0.12)] p-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {step === 1
                  ? 'Step 1: Sources'
                  : step === 2
                    ? 'Step 2: Recipients'
                    : `Step 3: Amounts (${activeOutputDrafts.length} outputs)`}
              </div>
              <div className="text-[12px] text-gray-500">
                Fee policy: 1 sat/byte • Change: auto
              </div>
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
                  ? `${selectedCount} source${selectedCount === 1 ? '' : 's'}`
                  : 'No sources'}
              </Badge>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() =>
                setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))
              }
              disabled={step === 1 || loading}
              className="px-4 py-3 rounded-xl bg-gray-100 text-gray-900 font-semibold disabled:opacity-50"
            >
              Back
            </button>

            {step < 3 ? (
              <button
                type="button"
                onClick={() => {
                  if (step === 1) setStep(2);
                  else setStep(3);
                }}
                disabled={
                  loading ||
                  (step === 1 && selectedCount === 0) ||
                  (step === 2 && selectedRecipientCount === 0)
                }
                className="px-4 py-3 rounded-xl bg-black text-white font-semibold disabled:opacity-50"
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
                  activeOutputDrafts.length === 0
                }
                className="px-4 py-3 rounded-xl bg-green-600 text-white font-semibold disabled:opacity-50"
              >
                {loading
                  ? 'Preparing…'
                  : `Review & mint (${activeOutputDrafts.length})`}
              </button>
            )}
          </div>

          {errorMessage ? (
            <div className="mt-3 text-[12px] text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {errorMessage}
            </div>
          ) : null}
        </div>
      </div>

      {/* Contained confirmation modal */}
      <ContainedSwipeConfirmModal
        open={confirmOpen}
        title={confirmTitle}
        subtitle={confirmSubtitle}
        warning={confirmWarning}
        loading={confirmLoading}
        onCancel={() => {
          if (confirmLoading) return;
          setConfirmOpen(false);
        }}
        onConfirm={() => {
          if (!pendingConfirmAction || confirmLoading) return;
          void pendingConfirmAction();
        }}
      >
        {confirmBody}
      </ContainedSwipeConfirmModal>
    </div>
  );
};

export default MintCashTokensPoCApp;
