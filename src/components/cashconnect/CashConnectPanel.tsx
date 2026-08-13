import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import { disconnectCashConnectThunk } from '../../state/slices/cashconnectSlice';
import CashConnectPairCard from './CashConnectPairCard';

export default function CashConnectPanel() {
  const dispatch = useDispatch<AppDispatch>();
  const sessions = useSelector((state: RootState) => state.cashconnect.sessions);
  const entries = Object.values(sessions);

  return (
    <div className="p-4 space-y-4">
      <CashConnectPairCard />

      <div className="wallet-card p-4 space-y-3">
        {entries.length === 0 ? (
          <p className="wallet-muted text-sm">
            No active CashConnect sessions yet.
          </p>
        ) : (
          <>
            <h3 className="text-lg font-bold">Active CashConnect Sessions</h3>
            <div className="space-y-3">
              {entries.map((session) => (
                <div
                  key={session.dappPubkey}
                  className="wallet-card p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-semibold break-words">
                      {session.dapp.name}
                    </p>
                    <p className="text-xs wallet-muted break-all">
                      {session.dapp.url}
                    </p>
                    <p className="text-xs wallet-muted">
                      {session.template.name} · {session.chain}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="wallet-btn-danger px-3 py-2 text-sm"
                    onClick={() =>
                      void dispatch(
                        disconnectCashConnectThunk(session.dappPubkey)
                      )
                    }
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
