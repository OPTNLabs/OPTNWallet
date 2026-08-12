// src/components/notifications/UtxoNotificationCenter.tsx
import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../redux/store';
import { dequeueNotification } from '../../redux/notificationsSlice';

const ToastItem: React.FC<{
  id: string;
  title: string;
  body: string;
  onClose: (id: string) => void;
  duration?: number;
}> = ({ id, title, body, onClose, duration = 6000 }) => {
  useEffect(() => {
    const t = setTimeout(() => onClose(id), duration);
    return () => clearTimeout(t);
  }, [id, duration, onClose]);

  return (
    <div
      className="pointer-events-auto mb-3 w-80 max-w-[92vw] rounded-2xl border border-emerald-300/60 bg-white/95 p-4 shadow-xl backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-3">
        <div className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-500" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-gray-900">{title}</div>
          <div className="mt-0.5 text-sm text-gray-700">{body}</div>
        </div>
        <button
          onClick={() => onClose(id)}
          className="ml-2 rounded-full p-1 text-gray-500 hover:bg-gray-100"
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const UtxoNotificationCenter: React.FC = () => {
  const dispatch = useDispatch();
  const queue = useSelector((s: RootState) => s.notifications.queue);

  const onClose = (id: string) => dispatch(dequeueNotification({ id }));

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-3 z-[9999] flex justify-center sm:justify-end sm:pr-4"
      style={{}}
    >
      <div className="pointer-events-none flex max-h-[80vh] flex-col-reverse overflow-y-auto sm:items-end">
        {queue.map((n) => {
          const sats = n.value ?? 0;
          const pretty = new Intl.NumberFormat().format(sats);
          const shortAddr = `${n.address.slice(0, 8)}…${n.address.slice(-6)}`;
          const shortTx = `${n.txid.slice(0, 6)}…${n.txid.slice(-6)}`;

          return (
            <ToastItem
              key={n.id}
              id={n.id}
              title="Funds received"
              body={`${pretty} sats to ${shortAddr} • ${shortTx}`}
              onClose={onClose}
            />
          );
        })}
      </div>
    </div>
  );
};

export default UtxoNotificationCenter;
