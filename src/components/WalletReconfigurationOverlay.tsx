import React, { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Network } from '../state/slices/networkSlice';
import {
  dismissWalletReconfiguration,
  type WalletOperationKind,
  type WalletOperationStage,
} from '../state/slices/walletReconfigurationSlice';
import type { RootState, AppDispatch } from '../state/store';
import { useI18n } from '../i18n/useI18n';
import type { TranslationKey } from '../i18n/resources';

const STAGE_ORDER: WalletOperationStage[] = [
  'preparing',
  'clearing',
  'deriving',
  'syncing',
];

const STAGE_COPY: Record<
  WalletOperationStage,
  { title: TranslationKey; detail: TranslationKey }
> = {
  preparing: {
    title: 'reconfiguration.preparing',
    detail: 'reconfiguration.preparingDetail',
  },
  clearing: {
    title: 'reconfiguration.clearing',
    detail: 'reconfiguration.clearingDetail',
  },
  deriving: {
    title: 'reconfiguration.deriving',
    detail: 'reconfiguration.derivingDetail',
  },
  syncing: {
    title: 'reconfiguration.syncing',
    detail: 'reconfiguration.syncingDetail',
  },
};

const operationTitle = (kind: WalletOperationKind): TranslationKey => {
  switch (kind) {
    case 'network-switch':
      return 'reconfiguration.switchingNetwork';
    case 'derivation-change':
      return 'reconfiguration.changingPath';
    case 'reload':
      return 'reconfiguration.reloading';
  }
};

const WalletReconfigurationOverlay: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const operation = useSelector(
    (state: RootState) => state.walletReconfiguration
  );

  useEffect(() => {
    if (operation.status !== 'idle') panelRef.current?.focus();
  }, [operation.status]);

  if (operation.status === 'idle') return null;

  const isError = operation.status === 'error';
  const isReload = operation.kind === 'reload';
  const visibleStages = isReload
    ? STAGE_ORDER.filter(
        (stage) => stage === 'preparing' || stage === 'syncing'
      )
    : STAGE_ORDER;
  const activeIndex = operation.stage
    ? visibleStages.indexOf(operation.stage)
    : -1;
  const currentStage = operation.stage ? STAGE_COPY[operation.stage] : null;
  const targetNetwork =
    operation.targetNetwork === Network.CHIPNET ? 'Chipnet' : 'Mainnet';

  return (
    <div
      className="fixed inset-0 z-[1300] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wallet-operation-title"
      aria-describedby="wallet-operation-detail"
      onKeyDown={(event) => {
        if (operation.status === 'running' && event.key === 'Tab') {
          event.preventDefault();
        }
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="wallet-popup-panel w-full max-w-md p-5 shadow-2xl outline-none"
      >
        {isError ? (
          <>
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15 text-2xl text-red-300">
              !
            </div>
            <h2
              id="wallet-operation-title"
              className="text-xl font-bold wallet-text-strong"
            >
              {t('reconfiguration.failed')}
            </h2>
            <p
              id="wallet-operation-detail"
              className="mt-2 text-sm wallet-muted"
            >
              {operation.error || t('reconfiguration.failedDetail')}
            </p>
            <button
              type="button"
              className="wallet-btn-danger mt-5 w-full"
              onClick={() => dispatch(dismissWalletReconfiguration())}
            >
              {t('reconfiguration.dismiss')}
            </button>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <span
                className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--wallet-border)] border-t-[var(--wallet-accent)]"
                aria-hidden="true"
              />
              <div>
                <h2
                  id="wallet-operation-title"
                  className="text-xl font-bold wallet-text-strong"
                >
                  {operation.kind
                    ? t(operationTitle(operation.kind))
                    : t('reconfiguration.updating')}
                </h2>
                {operation.kind === 'network-switch' && (
                  <p className="text-xs wallet-muted">
                    {t('reconfiguration.movingTo', { network: targetNetwork })}
                  </p>
                )}
              </div>
            </div>

            <div className="mb-4 rounded-xl wallet-surface-strong p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold wallet-text-strong">
                  {currentStage
                    ? t(currentStage.title)
                    : t('reconfiguration.working')}
                </span>
                <span className="text-xs wallet-muted">
                  {t('reconfiguration.stepOf', {
                    current: Math.max(activeIndex + 1, 1),
                    total: visibleStages.length,
                  })}
                </span>
              </div>
              <p
                id="wallet-operation-detail"
                className="mt-1 text-xs leading-relaxed wallet-muted"
              >
                {currentStage ? t(currentStage.detail) : null}
              </p>
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--wallet-border)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={visibleStages.length}
                aria-valuenow={Math.max(activeIndex + 1, 1)}
                aria-label={t('reconfiguration.progress')}
              >
                <div
                  className="h-full rounded-full bg-[var(--wallet-accent)] transition-all duration-500"
                  style={{
                    width: `${(Math.max(activeIndex + 1, 1) / visibleStages.length) * 100}%`,
                  }}
                />
              </div>
            </div>

            <ol className="space-y-2">
              {visibleStages.map((stage, index) => {
                const complete = index < activeIndex;
                const active = index === activeIndex;
                return (
                  <li
                    key={stage}
                    className={`flex items-center gap-3 text-sm ${
                      active
                        ? 'font-semibold wallet-text-strong'
                        : complete
                          ? 'wallet-text-strong'
                          : 'wallet-muted'
                    }`}
                  >
                    <span
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs ${
                        complete
                          ? 'border-[var(--wallet-accent)] bg-[var(--wallet-accent)] text-black'
                          : active
                            ? 'border-[var(--wallet-accent)] text-[var(--wallet-accent)]'
                            : 'border-[var(--wallet-border)]'
                      }`}
                    >
                      {complete ? '✓' : index + 1}
                    </span>
                    {t(STAGE_COPY[stage].title)}
                  </li>
                );
              })}
            </ol>

            <p className="mt-5 text-center text-xs wallet-muted">
              {t('reconfiguration.keepOpen')}
            </p>
          </>
        )}
      </div>
    </div>
  );
};

export default WalletReconfigurationOverlay;
