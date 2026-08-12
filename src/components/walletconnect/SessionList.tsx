// src/components/walletconnect/SessionList.tsx
import type { SessionTypes } from '@walletconnect/types';
import { normalizeExternalUrl } from '../../utils/externalUrl';

interface Props {
  activeSessions: Record<string, SessionTypes.Struct> | null;
  onDeleteSession: (topic: string) => void;
  onOpenSettings: (topic: string) => void;
}

export function SessionList({
  activeSessions,
  onDeleteSession,
  onOpenSettings,
}: Props) {
  if (!activeSessions || Object.keys(activeSessions).length === 0) {
    return <div className="text-center wallet-muted">No active sessions.</div>;
  }

  return (
    <div className="space-y-4 max-h-96 overflow-y-auto">
      {Object.entries(activeSessions).map(([topic, session]) => {
        const dappMeta = session.peer.metadata;
        const dappUrl = normalizeExternalUrl(dappMeta.url);
        // console.log(dappMeta);
        return (
          <div
            key={topic}
            className="wallet-card p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex items-center gap-3 min-w-0">
              <img
                src={dappMeta.icons[0]}
                alt="DApp icon"
                className="h-16 w-16 shrink-0 rounded-full object-cover"
              />
              <div className="text-center md:text-left min-w-0 flex-1">
                <div className="break-words font-bold text-base sm:text-lg lg:text-xl">
                  {dappMeta.name}
                </div>
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
                <p className="wallet-muted mt-1 text-xs sm:text-sm leading-relaxed break-words">
                  {dappMeta.description}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 md:flex md:justify-end md:gap-3 md:mt-0">
              <button
                onClick={() => onOpenSettings(topic)}
                className="wallet-btn-secondary px-3 py-2 text-sm md:text-base"
              >
                Settings
              </button>
              <button
                onClick={() => onDeleteSession(topic)}
                className="wallet-btn-danger px-3 py-2 text-sm md:text-base whitespace-nowrap"
              >
                Disconnect
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
