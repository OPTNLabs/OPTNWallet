import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { multisigRoute } from '../../navigation/routes';
import ElectrumService from '../../services/ElectrumService';
import { loadMultisigPolicy } from '../../services/multisig/MultisigStorageService';
import { listMultisigSpendSessions } from '../../services/multisig/MultisigSpendSessionService';
import type { MultisigPolicy } from '../../services/psbt/multisigWallet';
import { createMultisigDescriptorSet } from '../../services/psbt/multisigWallet';
import { refreshMultisigWalletUtxos } from '../../services/WalletUtxoRefreshService';
import MultisigPage from './MultisigPage';

export default function MultisigHome() {
  const navigate = useNavigate();
  const { wallet_id: routeWalletId } = useParams();
  const walletId = Number(routeWalletId);
  const [balance, setBalance] = useState(0);
  const [initialized, setInitialized] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [policy, setPolicy] = useState<MultisigPolicy | null>(null);
  const [hasPendingSpend, setHasPendingSpend] = useState(false);
  const [error, setError] = useState('');

  const openSpendWorkspace = (mode: 'resume' | 'new') => {
    navigate(multisigRoute(walletId, 'send'), {
      state: { multisigSpendMode: mode },
    });
  };

  useEffect(() => {
    let cancelled = false;
    void loadMultisigPolicy(walletId)
      .then((loaded) => {
        if (!cancelled) setPolicy(loaded);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not load the multisig policy.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [walletId]);

  useEffect(() => {
    if (!policy) return;
    let cancelled = false;
    const policyId = createMultisigDescriptorSet(
      policy,
      policy.network
    ).policyId;
    void listMultisigSpendSessions(walletId)
      .then((sessions) => {
        if (!cancelled) {
          setHasPendingSpend(
            sessions.some((session) => session.policyId === policyId)
          );
        }
      })
      .catch(() => {
        if (!cancelled) setHasPendingSpend(false);
      });
    return () => {
      cancelled = true;
    };
  }, [policy, walletId]);

  const refresh = useCallback(async () => {
    if (!Number.isSafeInteger(walletId) || walletId <= 0) return;
    setRefreshing(true);
    setInitialized(false);
    try {
      const snapshot = await refreshMultisigWalletUtxos(walletId);
      setBalance(
        Object.values(snapshot)
          .flat()
          .reduce(
            (sum, utxo) => sum + Number(utxo.value ?? utxo.amount ?? 0),
            0
          )
      );
      setInitialized(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Could not refresh the multisig balance.'
      );
    } finally {
      setRefreshing(false);
    }
  }, [walletId]);

  useEffect(() => {
    void refresh();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onBlock = () => void refresh();
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    void ElectrumService.subscribeBlockHeaders(onBlock, { emitCurrent: false });

    return () => {
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      void ElectrumService.unsubscribeBlockHeaders(onBlock);
    };
  }, [refresh]);

  return (
    <MultisigPage>
      <section className="rounded-2xl border border-[var(--wallet-accent)] bg-[var(--wallet-surface)] p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--wallet-accent-strong)]">
          Multisig overview
        </p>
        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-xs wallet-muted">Shared BCH balance</p>
            <p className="mt-1 text-3xl font-bold wallet-text-strong">
              {(balance / 100_000_000).toFixed(8)} BCH
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-[var(--wallet-border)] px-2 py-1 text-[10px] font-semibold uppercase wallet-muted">
              {initialized ? 'Synced' : 'Syncing'}
            </span>
            <button
              type="button"
              className="wallet-btn-secondary px-2 py-1 text-[10px]"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs wallet-muted">
          {policy?.network === 'mainnet' ? 'Mainnet' : 'Chipnet'} ·
          OP_CHECKMULTISIG
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold wallet-text-strong">
              {policy?.name ?? 'Shared policy'}
            </h2>
            <p className="mt-1 text-xs wallet-muted">
              {policy
                ? `${policy.threshold} of ${policy.signers.length} signatures`
                : 'Loading policy…'}
            </p>
          </div>
          <button
            type="button"
            className="wallet-btn-secondary px-3 py-2 text-xs"
            onClick={() => navigate(multisigRoute(walletId, 'policy'))}
          >
            View policy
          </button>
        </div>
        {policy && (
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {policy.signers.map((signer) => (
              <div
                key={signer.id}
                className="rounded-xl border border-[var(--wallet-border)] p-3"
              >
                <p className="text-xs font-semibold wallet-text-strong">
                  {signer.label || signer.name || signer.id}
                </p>
                <p className="mt-1 font-mono text-[10px] wallet-muted">
                  {signer.masterFingerprintHex
                    ? signer.masterFingerprintHex.toUpperCase()
                    : 'Fingerprint needs review'}
                </p>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-red-400">
            {error}
          </p>
        )}
      </section>

      <section className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          className="wallet-btn-primary py-3 text-sm font-semibold"
          onClick={() => navigate(multisigRoute(walletId, 'receive'))}
        >
          Receive to shared wallet
        </button>
        {hasPendingSpend && (
          <div className="space-y-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 sm:col-span-2">
            <p className="text-sm font-semibold wallet-text-strong">
              Pending multisig spend
            </p>
            <p className="text-xs leading-relaxed wallet-muted">
              Resume the saved PSBT to continue signing, or create a separate
              spend without deleting the pending one.
            </p>
            <button
              type="button"
              className="wallet-btn-primary w-full py-2 text-sm font-semibold"
              onClick={() => openSpendWorkspace('resume')}
            >
              Resume pending spend
            </button>
            <button
              type="button"
              className="wallet-btn-secondary w-full py-2 text-sm font-semibold"
              onClick={() => openSpendWorkspace('new')}
            >
              Create new spend
            </button>
          </div>
        )}
        {!hasPendingSpend && (
          <button
            type="button"
            className="wallet-btn-secondary py-3 text-sm font-semibold"
            onClick={() => openSpendWorkspace('new')}
          >
            Create new multisig spend
          </button>
        )}
        <button
          type="button"
          className="wallet-btn-secondary py-3 text-sm font-semibold sm:col-span-2"
          onClick={() => navigate(multisigRoute(walletId, 'sign'))}
        >
          Sign a multisig proposal
        </button>
      </section>
    </MultisigPage>
  );
}
