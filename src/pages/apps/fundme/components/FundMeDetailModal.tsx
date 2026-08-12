import React from 'react';
import { createPortal } from 'react-dom';

import { formatBchFromSatoshis, isChainCampaign } from '../fundmeHelpers';
import type { DetailModalState } from '../types';
import { DEFAULT_BANNER } from '../types';

type FundMeDetailModalProps = {
  detailModal: DetailModalState | null;
  latestKnownBlockLabel: string;
  donationDraft: string;
  onClose: () => void;
  onDonationDraftChange: (value: string) => void;
};

const FundMeDetailModal: React.FC<FundMeDetailModalProps> = ({
  detailModal,
  latestKnownBlockLabel,
  donationDraft,
  onClose,
  onDonationDraftChange,
}) => {
  if (!detailModal) return null;

  return createPortal(
    <div className="fixed inset-0 z-[1000] bg-black/60" onClick={onClose}>
      <div
        className="absolute left-1/2 top-[10dvh] bottom-[calc(var(--navbar-height)+var(--safe-bottom)+6px)] flex w-[calc(100vw-40px)] max-w-[18.5rem] -translate-x-1/2 flex-col rounded-[20px] wallet-card shadow-2xl overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex flex-none items-start justify-between gap-3 border-b border-[var(--wallet-border)] bg-[var(--wallet-card-bg)] px-4 py-3">
          <div className="min-w-0">
            <h3 className="mt-1 text-lg font-semibold wallet-text-strong leading-tight">
              {detailModal.campaign.name}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="wallet-btn-danger shrink-0 px-3 py-2 text-sm"
          >
            Close
          </button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain touch-pan-y px-3 py-3"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="space-y-3">
            <div
              className="h-[72px] w-full rounded-2xl bg-cover bg-center"
              style={{
                backgroundImage: `url(${detailModal.detail?.banner || detailModal.campaign.banner || DEFAULT_BANNER})`,
              }}
            />

            <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs wallet-muted">
                    Campaign #{detailModal.campaign.id} by{' '}
                    {detailModal.detail?.owner || detailModal.campaign.owner}
                  </div>
                  <div className="mt-1 text-sm wallet-text-strong">
                    Status: {detailModal.campaign.status}
                  </div>
                </div>
                <span className="rounded-full px-3 py-1 text-xs font-semibold wallet-surface-strong border border-[var(--wallet-border)] wallet-text-strong">
                  {detailModal.campaign.endLabel}
                </span>
              </div>

              {isChainCampaign(detailModal.campaign) ? (
                <div className="mt-4">
                  <div className="h-2 rounded-full bg-black/25 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#31d89a]"
                      style={{
                        width: `${Math.max(
                          Math.min(
                            (detailModal.campaign.raisedSatoshis /
                              Math.max(detailModal.campaign.targetSatoshis, 1)) *
                              100,
                            100
                          ),
                          2
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="mt-2 text-xs wallet-muted">
                    {formatBchFromSatoshis(detailModal.campaign.raisedSatoshis)} /{' '}
                    {formatBchFromSatoshis(detailModal.campaign.targetSatoshis)} BCH
                  </div>
                  <div className="mt-1 text-xs wallet-muted">
                    End block: {detailModal.campaign.endBlock.toLocaleString()} · Latest
                    block: {latestKnownBlockLabel}
                  </div>
                </div>
              ) : null}
            </div>

            {detailModal.loading ? (
              <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-6 text-center wallet-muted">
                Loading campaign details...
              </div>
            ) : null}

            {detailModal.error ? (
              <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] px-4 py-4 text-sm wallet-muted">
                {detailModal.error}
              </div>
            ) : null}

            {!detailModal.loading && !detailModal.error ? (
              <>
                <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                    Overview
                  </div>
                  <p className="mt-2 text-sm leading-6 wallet-muted">
                    {detailModal.detail?.shortDescription ||
                      detailModal.campaign.shortDescription}
                  </p>
                  {detailModal.detail?.description ? (
                    <div
                      className="mt-3 rounded-xl border border-[var(--wallet-border)] px-3 py-3 text-sm leading-6 wallet-muted [&_a]:underline [&_ul]:list-disc [&_ul]:pl-5"
                      dangerouslySetInnerHTML={{
                        __html: detailModal.detail.description,
                      }}
                    />
                  ) : null}
                </div>

                <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                    Pledges
                  </div>
                  <div className="mt-3 text-sm wallet-text-strong">
                    {detailModal.detail?.pledges?.length ?? 0} pledge entries
                  </div>
                  <p className="mt-2 text-sm wallet-muted">
                    Transaction actions are still being reattached after the native
                    screen loss, so this restore focuses on campaign browsing and
                    creation UI first.
                  </p>
                </div>

                {isChainCampaign(detailModal.campaign) ? (
                  <div className="rounded-2xl wallet-surface-strong border border-[var(--wallet-border)] p-3">
                    <div className="text-xs font-semibold uppercase tracking-[0.12em] wallet-muted">
                      Donate
                    </div>
                    <p className="mt-2 text-xs wallet-muted">
                      Donation transaction controls are visible here now. The action
                      stays disabled until the native call path is reattached.
                    </p>
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        value={donationDraft}
                        onChange={(event) =>
                          onDonationDraftChange(event.target.value.replace(/[^0-9.]+/g, ''))
                        }
                        placeholder="0.01000000"
                        className="wallet-input min-w-0 flex-1"
                      />
                      <button
                        type="button"
                        disabled
                        className="rounded-2xl bg-[#31d89a]/40 px-4 py-3 text-sm font-semibold text-[#08261a]/70 cursor-not-allowed"
                      >
                        Donate
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default FundMeDetailModal;
