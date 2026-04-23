import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../redux/store';
import { dequeueServerNotification } from '../../redux/serverNotificationsSlice';

const ToastItem: React.FC<{
  id: string;
  title: string;
  body: string;
  onClose: (id: string) => void;
  duration?: number;
}> = ({ id, title, body, onClose, duration = 8000 }) => {
  useEffect(() => {
    const timer = window.setTimeout(() => onClose(id), duration);
    return () => window.clearTimeout(timer);
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
          <div className="text-sm font-semibold wallet-text-strong">{title}</div>
          <div className="mt-0.5 text-sm wallet-muted">{body}</div>
        </div>
        <button
          onClick={() => onClose(id)}
          className="ml-2 rounded-full p-1 wallet-muted hover:brightness-95"
          aria-label="Dismiss"
          title="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  );
};

const ServerNotificationCenter: React.FC = () => {
  const dispatch = useDispatch();
  const queue = useSelector((s: RootState) => s.serverNotifications.queue);

  const onClose = (id: string) => dispatch(dequeueServerNotification({ id }));

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[9998] flex justify-center sm:justify-start sm:pl-4">
      <div className="pointer-events-none flex max-h-[80vh] flex-col-reverse overflow-y-auto sm:items-start">
        {queue.map((n) => {
          const shortTx = `${n.txid.slice(0, 6)}…${n.txid.slice(-6)}`;
          const shortAddr = n.address
            ? `${n.address.slice(0, 8)}…${n.address.slice(-6)}`
            : 'unknown address';
          const title =
            n.kind === 'transaction_confirmed'
              ? 'Transaction confirmed'
              : n.kind === 'incoming_token'
                ? 'Incoming token'
                : 'Incoming BCH';
          const body = `${shortTx} • ${shortAddr}`;
          return (
            <ToastItem
              key={n.id}
              id={n.id}
              title={title}
              body={body}
              onClose={onClose}
            />
          );
        })}
      </div>
    </div>
  );
};

export default ServerNotificationCenter;
