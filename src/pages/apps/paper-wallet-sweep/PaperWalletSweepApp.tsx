import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Toast } from '@capacitor/toast';
import {
  decodePrivateKeyWif,
  privateKeyToP2pkhCashAddress,
} from '@bitauth/libauth';
import { FaCamera, FaChevronRight } from 'react-icons/fa';
import { CapacitorBarcodeScannerTypeHint } from '@capacitor/barcode-scanner';
import type { AddonSDK } from '../../../services/AddonsSDK';
import ElectrumService from '../../../services/ElectrumService';
import { PaperWalletSecretStore } from '../../../services/PaperWalletSecretStore';
import { PREFIX } from '../../../utils/constants';
import {
  scanBarcodeSafely,
  getBarcodeScannerErrorMessage,
} from '../../../utils/barcodeScanner';
import type { UTXO } from '../../../types/types';
import { buildPaperWalletSweepPlan } from './services/paperWalletSweepPlanner';
import {
  Badge,
  ContainedSwipeConfirmModal,
} from '../mint-cashtokens-poc/components/uiPrimitives';

const BASE58_WIF_PATTERN =
  /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
const BASE58_WIF_CANDIDATE_PATTERN =
  /[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{50,52}/g;

function extractWifCandidates(value: string): string[] {
  const trimmed = value.trim();
  const candidates = new Set<string>();

  if (BASE58_WIF_PATTERN.test(trimmed)) {
    candidates.add(trimmed);
  }

  for (const match of trimmed.match(BASE58_WIF_CANDIDATE_PATTERN) ?? []) {
    if (match && BASE58_WIF_PATTERN.test(match)) {
      candidates.add(match);
    }
  }

  const lastColonIndex = trimmed.lastIndexOf(':');
  if (lastColonIndex !== -1) {
    const suffix = trimmed.slice(lastColonIndex + 1).trim();
    if (suffix && suffix !== trimmed && BASE58_WIF_PATTERN.test(suffix)) {
      candidates.add(suffix);
    }
  }

  return [...candidates];
}

function decodeScannedWif(wif: string) {
  const trimmed = wif.trim();
  const direct = decodePrivateKeyWif(trimmed);
  if (typeof direct !== 'string') {
    return direct;
  }

  for (const candidate of extractWifCandidates(trimmed)) {
    if (candidate === trimmed) continue;
    const decoded = decodePrivateKeyWif(candidate);
    if (typeof decoded !== 'string') {
      return decoded;
    }
  }

  return direct;
}

type Props = { sdk: AddonSDK };

export default function PaperWalletSweepApp({ sdk }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [scannedAddress, setScannedAddress] = useState('');
  const [paperWalletUtxos, setPaperWalletUtxos] = useState<UTXO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [broadcastTxid, setBroadcastTxid] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [pendingSweep, setPendingSweep] = useState<null | {
    plan: Awaited<ReturnType<typeof buildPaperWalletSweepPlan>>;
    builtHex: string;
  }>(null);

  const networkPrefix = useMemo(() => {
    const network = sdk.wallet.getContext().network;
    return network === 'mainnet' ? PREFIX.mainnet : PREFIX.chipnet;
  }, [sdk]);

  const networkPrefixFallback = useMemo(
    () => (networkPrefix === PREFIX.mainnet ? PREFIX.chipnet : PREFIX.mainnet),
    [networkPrefix]
  );

  const handleScan = async () => {
    try {
      setLoading(true);
      setError(null);
      PaperWalletSecretStore.clear();

      const result = await scanBarcodeSafely({
        hint: CapacitorBarcodeScannerTypeHint.ALL,
        cameraDirection: 1,
      });
      if (!result?.ScanResult) {
        await Toast.show({ text: 'No QR code detected. Please try again.' });
        return;
      }

      const decoded = decodeScannedWif(result.ScanResult);
      if (typeof decoded === 'string') {
        throw new Error(decoded);
      }

      const { privateKey } = decoded;
      const addressCandidates = [networkPrefix, networkPrefixFallback];
      let resolvedAddress: string | null = null;
      let utxos: UTXO[] = [];

      for (const prefix of addressCandidates) {
        const addressResult = privateKeyToP2pkhCashAddress({
          privateKey,
          prefix,
          throwErrors: true,
          tokenSupport: false,
        });
        if (typeof addressResult === 'string') {
          continue;
        }

        const candidateAddress = addressResult.address;
        const candidateUtxos = (
          await ElectrumService.getUTXOs(candidateAddress)
        ).filter((utxo) => !utxo.abi && !utxo.contractName);
        if (candidateUtxos.length > 0) {
          resolvedAddress = candidateAddress;
          utxos = candidateUtxos;
          break;
        }

        if (!resolvedAddress) {
          resolvedAddress = candidateAddress;
          utxos = candidateUtxos;
        }
      }

      if (!resolvedAddress) {
        throw new Error(
          'Unable to derive a valid paper wallet address from the scanned key.'
        );
      }

      setScannedAddress(resolvedAddress);
      if (utxos.length === 0) {
        await Toast.show({
          text: 'No UTXOs found for this paper wallet. If this is a mainnet wallet and you are on chipnet, try switching networks.',
        });
        return;
      }

      const marked = utxos.map((utxo) => {
        PaperWalletSecretStore.set(utxo.tx_hash, utxo.tx_pos, privateKey);
        return {
          ...utxo,
          isPaperWallet: true,
          amount: utxo.value,
        };
      });
      setPaperWalletUtxos(marked);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : getBarcodeScannerErrorMessage(err);
      setError(message);
      await Toast.show({ text: message });
    } finally {
      setLoading(false);
    }
  };

  const handleSweep = async () => {
    if (!scannedAddress || paperWalletUtxos.length === 0) {
      await Toast.show({ text: 'Scan a paper wallet before sweeping.' });
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const addresses = await sdk.wallet.listAddresses();
      const destinationAddress = addresses[0]?.address;
      if (!destinationAddress) {
        throw new Error('No destination wallet address is available.');
      }

      const walletUtxos = await sdk.utxos.listForWallet();
      const walletFeeUtxos = walletUtxos.allUtxos.filter(
        (utxo) =>
          !utxo.token &&
          !utxo.isPaperWallet &&
          utxo.address !== scannedAddress &&
          (utxo.value ?? utxo.amount ?? 0) > 0
      );

      const plan = await buildPaperWalletSweepPlan({
        paperWalletAddress: scannedAddress,
        destinationAddress,
        paperWalletUtxos,
        walletFeeUtxos,
      });

      const built = await sdk.tx.build({
        inputs: [...plan.paperWalletUtxos, ...plan.feeInputs],
        outputs: plan.outputs,
        changeAddress: destinationAddress,
      });
      if (built.errorMsg || !built.hex) {
        throw new Error(built.errorMsg || 'Failed to build sweep transaction.');
      }

      setPendingSweep({ plan, builtHex: built.hex });
      setConfirmOpen(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      await Toast.show({ text: message });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmSweep = async () => {
    if (!pendingSweep) return;

    try {
      setConfirmLoading(true);
      const sent = await sdk.tx.broadcast(pendingSweep.builtHex);
      if (sent.errorMessage) {
        throw new Error(sent.errorMessage);
      }
      setBroadcastTxid(sent.txid);
      setConfirmOpen(false);
      setPendingSweep(null);
      await Toast.show({
        text: `Sweep broadcast${sent.txid ? `: ${sent.txid}` : ''}`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      await Toast.show({ text: message });
    } finally {
      setConfirmLoading(false);
    }
  };

  const tokenGroups = useMemo(() => {
    const groups = new Map<
      string,
      { count: number; amount: bigint; nft: boolean }
    >();
    for (const utxo of paperWalletUtxos) {
      if (!utxo.token?.category) continue;
      const current = groups.get(utxo.token.category) ?? {
        count: 0,
        amount: 0n,
        nft: false,
      };
      const amt =
        typeof utxo.token.amount === 'bigint'
          ? utxo.token.amount
          : BigInt(Math.trunc(Number(utxo.token.amount ?? 0) || 0));
      groups.set(utxo.token.category, {
        count: current.count + 1,
        amount: current.amount + amt,
        nft: current.nft || !!utxo.token.nft,
      });
    }
    return [...groups.entries()].map(([category, value]) => ({
      category,
      ...value,
    }));
  }, [paperWalletUtxos]);

  return (
    <div className="container mx-auto max-w-md h-[calc(100dvh-var(--navbar-height)-var(--safe-bottom))] px-4 pt-2 pb-3 flex flex-col overflow-hidden wallet-page">
      <div className="flex-none">
        <div className="flex justify-center pt-1">
          <img
            src="/assets/images/OPTNWelcome1.png"
            alt="OPTN"
            className="h-auto w-full max-w-[260px] object-contain"
          />
        </div>
        <div className="mt-4 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold wallet-text-strong tracking-[-0.02em]">
            Paper Wallet
          </h1>
          <button
            type="button"
            onClick={() => navigate('/apps')}
            className="wallet-btn-danger px-4 py-2"
          >
            Go Back
          </button>
        </div>
        <p className="mt-2 text-sm wallet-muted">
          Scan a WIF paper wallet and sweep BCH + CashTokens in one transaction.
        </p>
      </div>

      <div className="mt-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain touch-pan-y pr-1">
        <div className="space-y-4">
          <div className="wallet-card p-4 rounded-2xl">
            <div className="flex items-center justify-between gap-3">
              <div className="flex-1">
                <div className="text-sm wallet-muted">Paper wallet</div>
                <div className="mt-1 break-all text-sm wallet-text-strong">
                  {scannedAddress || 'No paper wallet scanned yet.'}
                </div>
              </div>
              <button
                className="wallet-btn-primary px-4 py-2 flex items-center gap-2"
                onClick={handleScan}
                disabled={loading}
              >
                <FaCamera /> Scan
              </button>
            </div>

            <div className="mt-4 flex items-center gap-2">
              <button
                className="wallet-btn-primary px-4 py-2 flex items-center gap-2"
                onClick={handleSweep}
                disabled={loading || paperWalletUtxos.length === 0}
              >
                Sweep <FaChevronRight />
              </button>
              {broadcastTxid && (
                <div className="text-xs wallet-muted break-all">
                  {broadcastTxid}
                </div>
              )}
            </div>

            {error && <div className="mt-3 wallet-danger-text">{error}</div>}
          </div>

          <div className="wallet-card p-4 rounded-2xl">
            <div className="font-semibold mb-2 wallet-text-strong">
              Paper wallet UTXOs
            </div>
            <div className="text-sm wallet-muted">
              {paperWalletUtxos.length} spendable output
              {paperWalletUtxos.length === 1 ? '' : 's'}
            </div>
            <ul className="mt-3 space-y-2 text-sm">
              {paperWalletUtxos.map((u) => (
                <li key={`${u.tx_hash}:${u.tx_pos}`} className="break-all">
                  {u.token
                    ? `${u.token.nft ? 'NFT' : 'FT'} ${u.token.category} @ ${u.tx_hash}:${u.tx_pos}`
                    : `BCH ${u.value} sats @ ${u.tx_hash}:${u.tx_pos}`}
                </li>
              ))}
            </ul>
          </div>

          <div className="wallet-card p-4 rounded-2xl">
            <div className="font-semibold mb-2 wallet-text-strong">
              Token groups
            </div>
            {tokenGroups.length === 0 ? (
              <div className="text-sm wallet-muted">
                No CashTokens detected.
              </div>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {tokenGroups.map((group) => (
                  <li key={group.category} className="break-all">
                    {group.nft ? 'NFT' : 'FT'} {group.category} -{' '}
                    {group.amount.toString()}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
      <ContainedSwipeConfirmModal
        open={confirmOpen && !!pendingSweep}
        title="Confirm sweep"
        subtitle="Slide to confirm the one-transaction paper wallet sweep."
        loading={confirmLoading}
        onCancel={() => {
          if (confirmLoading) return;
          setConfirmOpen(false);
          setPendingSweep(null);
        }}
        onConfirm={() => {
          if (confirmLoading) return;
          void handleConfirmSweep();
        }}
      >
        {pendingSweep ? (
          <div className="space-y-2 text-sm wallet-text-strong">
            <div className="flex items-center justify-between gap-3">
              <span>Paper wallet inputs</span>
              <Badge tone="blue">
                {pendingSweep.plan.paperWalletUtxos.length}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Wallet fee inputs</span>
              <Badge tone="amber">{pendingSweep.plan.feeInputs.length}</Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Token outputs</span>
              <Badge tone="green">
                {pendingSweep.plan.outputs.filter((o) => !!o.token).length}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>BCH outputs</span>
              <Badge>
                {pendingSweep.plan.outputs.filter((o) => !o.token).length}
              </Badge>
            </div>
            <div className="pt-2 text-xs wallet-muted">
              One transaction only. Token outputs are backed with 1000 sats.
            </div>
          </div>
        ) : null}
      </ContainedSwipeConfirmModal>
    </div>
  );
}
