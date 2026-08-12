// src/components/walletconnect/SessionSettingsModal.tsx
import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState, AppDispatch } from '../../state/store';
import { disconnectSession } from '../../state/slices/walletconnectSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';

interface Props {
  sessionTopic: string;
  onClose: () => void;
}

const SessionSettingsModal: React.FC<Props> = ({ sessionTopic, onClose }) => {
  const dispatch = useDispatch<AppDispatch>();
  const session = useSelector(
    (state: RootState) => state.walletconnect.activeSessions?.[sessionTopic]
  );

  if (!session) return null;
  const dappMeta = session.peer.metadata;
  const dappUrl = normalizeExternalUrl(dappMeta.url);

  // Correct expiry timestamp conversion (assuming seconds)
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // console.log(session.expiry)
  // console.log("expires at: ", new Date(session.expiry * 1000).toLocaleString('en-US', { timeZone }));
  // console.log("current time: ", new Date().toLocaleString('en-US', { timeZone }));

  const handleDisconnect = async () => {
    try {
      await dispatch(disconnectSession(sessionTopic)).unwrap();
    } catch (error) {
      console.error('Error disconnecting session:', error);
    } finally {
      onClose();
    }
  };

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        {/* Modal Header */}
        {/* <h2 className="text-2xl font-bold mb-4 text-center">Session Settings</h2> */}

        {/* DApp Details */}
        <div className="flex items-center gap-4 mb-4 min-w-0">
          <img
            src={dappMeta.icons[0]}
            alt="DApp Icon"
            className="h-16 w-16 shrink-0 rounded-full object-cover"
          />
          <div className="flex min-w-0 flex-col text-center md:text-left">
            <p className="break-words font-bold text-lg sm:text-xl leading-tight">
              {dappMeta.name}
            </p>
            {dappUrl ? (
              <a
                href={dappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 block text-xs sm:text-sm wallet-link underline break-all leading-relaxed"
              >
                {dappMeta.url}
              </a>
            ) : (
              <span className="mt-1 block text-xs sm:text-sm wallet-muted break-all leading-relaxed">
                {dappMeta.url}
              </span>
            )}
            {/* Description */}
            <p className="wallet-muted mt-2 text-xs sm:text-sm leading-relaxed break-words">
              {dappMeta.description}
            </p>

            {session.expiry && (
              <div className="mt-3 rounded border border-[var(--wallet-border)] bg-[var(--wallet-surface)] p-3 text-left">
                <p className="text-[11px] uppercase tracking-wide wallet-muted">
                  Disconnects On
                </p>
                <p className="wallet-text-strong text-sm sm:text-base">
                  {new Date(session.expiry * 1000).toLocaleString('en-US', {
                    timeZone,
                  })}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="grid grid-cols-2 gap-3 mt-4">
          <button
            onClick={onClose}
            className="wallet-btn-secondary px-3 py-2 text-sm sm:text-base"
          >
            Close
          </button>
          <button
            onClick={handleDisconnect}
            className="wallet-btn-danger px-3 py-2 text-sm sm:text-base whitespace-nowrap"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
};

export default SessionSettingsModal;
