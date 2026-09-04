import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useParams } from 'react-router-dom';
import { copyToClipboard } from '../../utils/clipboard';
import MultisigPage from './MultisigPage';
import {
  getMultisigPolicyStatus,
  reserveMultisigAddress,
  type MultisigAddressReservation,
} from '../../services/multisig/MultisigStorageService';

/** Receive view for multisig wallets. Mounting this screen never reserves an index. */
export default function MultisigReceive() {
  const { wallet_id: routeWalletId } = useParams();
  const walletId = Number(routeWalletId);
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [reservation, setReservation] =
    useState<MultisigAddressReservation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState<'bch' | 'token' | null>(
    null
  );

  const copyAddress = async (kind: 'bch' | 'token', address: string) => {
    if (!(await copyToClipboard(address))) return;
    setCopiedAddress(kind);
    window.setTimeout(() => {
      setCopiedAddress((current) => (current === kind ? null : current));
    }, 1800);
  };

  useEffect(() => {
    if (!walletId) return;
    void getMultisigPolicyStatus(walletId)
      .then((status) => setPolicyId(status?.policyId ?? null))
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load the multisig policy.'
        )
      );
  }, [walletId]);

  const reserveNext = async () => {
    if (!walletId || busy) return;
    setBusy(true);
    setError('');
    try {
      setReservation(await reserveMultisigAddress(walletId, 0));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not reserve a receive address.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <MultisigPage>
      <section className="space-y-3 rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--wallet-accent-strong)]">
          Shared receive
        </p>
        <h2 className="text-xl font-bold wallet-text-strong">
          Receive into the multisig wallet
        </h2>
        <p className="text-sm wallet-muted">
          Reserve an address only after you choose to use it. Opening this
          screen does not advance the cursor.
        </p>
        {policyId && (
          <p className="break-all rounded-xl border border-[var(--wallet-border)] p-3 text-xs font-mono wallet-muted">
            Policy ID: {policyId}
          </p>
        )}
        {reservation ? (
          <>
            <div className="flex justify-center rounded-xl bg-white p-3">
              <QRCodeSVG
                value={reservation.tokenAddress}
                size={220}
                includeMargin
              />
            </div>
            <div className="rounded-xl border border-[var(--wallet-border)] p-3">
              <p className="text-xs font-semibold wallet-text-strong">
                Scan or copy this address
              </p>
              <p className="mt-1 text-xs leading-relaxed wallet-muted">
                The QR and token-aware address work for BCH and CashTokens. The
                ordinary BCH address is included for wallets that do not
                understand token-aware CashAddr yet.
              </p>
              <div className="mt-3 space-y-2">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide wallet-muted">
                      Token-aware address
                    </p>
                    <button
                      type="button"
                      className="text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
                      onClick={() =>
                        void copyAddress('token', reservation.tokenAddress)
                      }
                    >
                      {copiedAddress === 'token' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-1 break-all rounded-lg border border-[var(--wallet-border)] p-2 font-mono text-[10px] wallet-text-strong">
                    {reservation.tokenAddress}
                  </p>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide wallet-muted">
                      BCH address
                    </p>
                    <button
                      type="button"
                      className="text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
                      onClick={() =>
                        void copyAddress('bch', reservation.address)
                      }
                    >
                      {copiedAddress === 'bch' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="mt-1 break-all rounded-lg border border-[var(--wallet-border)] p-2 font-mono text-[10px] wallet-text-strong">
                    {reservation.address}
                  </p>
                </div>
              </div>
            </div>
            <p className="text-xs wallet-muted">
              Branch {reservation.branch} · index {reservation.index} · this
              address is reserved for the shared policy.
            </p>
          </>
        ) : (
          <button
            type="button"
            className="wallet-btn-primary w-full py-3"
            onClick={() => void reserveNext()}
            disabled={busy}
          >
            {busy ? 'Reserving…' : 'Reserve next receive address'}
          </button>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
      </section>
    </MultisigPage>
  );
}
