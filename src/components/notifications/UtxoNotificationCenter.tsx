// src/components/notifications/UtxoNotificationCenter.tsx
import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../state/store';
import { dequeueNotification } from '../../state/slices/notificationsSlice';
import { useI18n } from '../../i18n/useI18n';
import { formatNumber } from '../../i18n/format';
import MaskedValue from '../ui/MaskedValue';

const ToastItem: React.FC<{
  id: string;
  title: string;
  body: React.ReactNode;
  onClose: (id: string) => void;
  duration?: number;
}> = ({ id, title, body, onClose, duration = 6000 }) => {
  const { t } = useI18n();
  useEffect(() => {
    const t = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(t);
  }, [id, duration, onClose]);

  return (
    <div
      className="pointer-events-auto mb-3 w-80 max-w-[92vw] wallet-card p-4 shadow-xl backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full wallet-accent-icon" />
        <div className="flex-1">
          <div className="text-sm font-semibold wallet-text-strong">
            {title}
          </div>
          <div className="mt-0.5 text-sm wallet-muted">{body}</div>
        </div>
        <button
          onClick={() => onClose(id)}
          className="ml-2 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full p-1 wallet-muted hover:brightness-95"
          aria-label={t('notifications.dismiss')}
          title={t('notifications.dismiss')}
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const UtxoNotificationCenter: React.FC = () => {
  const dispatch = useDispatch();
  const { t, locale } = useI18n();
  const queue = useSelector((s: RootState) => s.notifications.queue);

  const onClose = (id: string) => dispatch(dequeueNotification({ id }));

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-[9999] flex justify-center sm:justify-end sm:pr-4"
      style={{}}
    >
      <div className="pointer-events-none flex max-h-[80vh] flex-col-reverse overflow-y-auto sm:items-end">
        {queue.map((n) => {
          if (n.kind === 'walletconnect') {
            return (
              <ToastItem
                key={n.id}
                id={n.id}
                title={n.title}
                body={n.body}
                onClose={onClose}
              />
            );
          }

          const sats = n.value ?? 0;
          return (
            <ToastItem
              key={n.id}
              id={n.id}
              title={t('notifications.fundsReceived')}
              body={
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                  <span className="wallet-text-strong">
                    {formatNumber(sats, locale)} sats
                  </span>
                  <span aria-hidden="true">•</span>
                  <MaskedValue
                    value={n.address}
                    label={t('receive.receiveAddress')}
                    ariaLabel={t('receive.receiveAddress')}
                    copySuccessMessageKey="receive.addressCopied"
                    embedded
                    className="text-xs"
                  />
                  <span aria-hidden="true">•</span>
                  <MaskedValue
                    value={n.txid}
                    label={t('history.transactionId')}
                    ariaLabel={t('history.transactionId')}
                    copySuccessMessageKey="history.transactionCopied"
                    embedded
                    className="text-xs"
                  />
                </div>
              }
              onClose={onClose}
            />
          );
        })}
      </div>
    </div>
  );
};

export default UtxoNotificationCenter;
