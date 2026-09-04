import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  getMultisigPolicyStatus,
  loadMultisigPolicy,
} from '../../services/multisig/MultisigStorageService';
import type { MultisigPolicy } from '../../services/psbt/multisigWallet';
import MultisigPage from './MultisigPage';
import { copyToClipboard } from '../../utils/clipboard';

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!(await copyToClipboard(value))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      className="shrink-0 text-[10px] font-semibold text-[var(--wallet-accent-strong)]"
      onClick={() => void copy()}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

export default function MultisigPolicy() {
  const { wallet_id: routeWalletId } = useParams();
  const walletId = Number(routeWalletId);
  const [policy, setPolicy] = useState<MultisigPolicy | null>(null);
  const [descriptors, setDescriptors] = useState<{
    policyId: string;
    receive: string | null;
    change: string | null;
  } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      loadMultisigPolicy(walletId),
      getMultisigPolicyStatus(walletId),
    ])
      .then(([loaded, stored]) => {
        if (cancelled) return;
        setPolicy(loaded);
        setDescriptors(
          stored
            ? {
                policyId: stored.policyId,
                receive: stored.receiveDescriptor,
                change: stored.changeDescriptor,
              }
            : null
        );
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

  return (
    <MultisigPage>
      <section className="rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
        <h2 className="text-xl font-bold wallet-text-strong">
          Multisig policy
        </h2>
        <p className="mt-1 text-sm wallet-muted">
          This is the shared identity every cosigner must approve before a spend
          is signed.
        </p>
        {descriptors?.policyId && (
          <div className="mt-4 rounded-xl border border-[var(--wallet-accent)] p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] wallet-muted">
                Policy ID
              </p>
              <CopyButton value={descriptors.policyId} />
            </div>
            <p className="mt-1 break-all font-mono text-xs wallet-text-strong">
              {descriptors.policyId}
            </p>
          </div>
        )}
      </section>

      {policy && (
        <section className="rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs wallet-muted">Network</p>
              <p className="mt-1 text-sm font-semibold wallet-text-strong">
                {policy.network === 'mainnet' ? 'Mainnet' : 'Chipnet'}
              </p>
            </div>
            <div>
              <p className="text-xs wallet-muted">Threshold</p>
              <p className="mt-1 text-sm font-semibold wallet-text-strong">
                {policy.threshold} of {policy.signers.length}
              </p>
            </div>
            <div>
              <p className="text-xs wallet-muted">Account path</p>
              <p className="mt-1 break-all font-mono text-xs wallet-text-strong">
                {policy.accountPath}
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            {policy.signers.map((signer) => (
              <div
                key={signer.id}
                className="rounded-xl border border-[var(--wallet-border)] p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold wallet-text-strong">
                      {signer.label || signer.name || signer.id}
                    </p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide wallet-muted">
                      Master fingerprint
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] wallet-muted">
                      {signer.masterFingerprintHex
                        ? signer.masterFingerprintHex.toUpperCase()
                        : 'needs review'}
                    </span>
                    {signer.masterFingerprintHex && (
                      <CopyButton value={signer.masterFingerprintHex} />
                    )}
                  </div>
                </div>
                <div className="mt-2 flex items-start justify-between gap-2">
                  <p className="break-all font-mono text-[10px] wallet-muted">
                    {signer.xpub}
                  </p>
                  <CopyButton value={signer.xpub} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {descriptors && (
        <section className="space-y-3 rounded-2xl border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-4">
          <h3 className="text-sm font-semibold wallet-text-strong">
            Canonical descriptors
          </h3>
          <label className="block text-xs wallet-muted">
            <span className="flex items-center justify-between gap-2">
              Receive
              {descriptors.receive && (
                <CopyButton value={descriptors.receive} />
              )}
            </span>
            <textarea
              readOnly
              value={descriptors.receive ?? ''}
              className="wallet-input mt-1 min-h-24 w-full resize-y font-mono text-[10px]"
            />
          </label>
          <label className="block text-xs wallet-muted">
            <span className="flex items-center justify-between gap-2">
              Change
              {descriptors.change && <CopyButton value={descriptors.change} />}
            </span>
            <textarea
              readOnly
              value={descriptors.change ?? ''}
              className="wallet-input mt-1 min-h-24 w-full resize-y font-mono text-[10px]"
            />
          </label>
        </section>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </MultisigPage>
  );
}
