import { formatSegment } from '@cashconnect-js/nostr/wallet';
import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import {
  approveCashConnectActionAction,
  rejectCashConnectActionAction,
} from '../../state/slices/cashconnectSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';
import WalletPopupSheet from '../ui/WalletPopupSheet';

function formatMeta(
  segments: Array<string | { type: string }> | undefined
): string {
  if (!segments?.length) return '';
  return segments
    .map((segment) =>
      typeof segment === 'string' ? segment : formatSegment(segment as never)
    )
    .join('');
}

function formatBalance(category: string, amount: bigint): string {
  const sign = amount > 0n ? '+' : amount < 0n ? '-' : '';
  const abs = amount < 0n ? -amount : amount;
  if (category === 'sats') {
    return `${sign}${Number(abs) / 1e8} BCH`;
  }
  return `${sign}${abs.toString()} ${category.slice(0, 12)}…`;
}

export default function CashConnectExecuteActionModal() {
  const dispatch = useDispatch<AppDispatch>();
  const pending = useSelector(
    (state: RootState) => state.cashconnect.pendingAction
  );
  if (!pending) return null;

  const { session, response } = pending;
  const dappUrl = normalizeExternalUrl(session.dapp.url);
  const title = formatMeta(response.meta?.title) || session.template.name;
  const description = formatMeta(response.meta?.description);

  return (
    <WalletPopupSheet
      footer={
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            onClick={() => dispatch(approveCashConnectActionAction())}
          >
            Approve
          </button>
          <button
            type="button"
            className="wallet-btn-danger px-3 py-2"
            onClick={() => dispatch(rejectCashConnectActionAction())}
          >
            Reject
          </button>
        </div>
      }
    >
      <h2 className="text-xl font-bold text-center mb-3">{title}</h2>
      <p className="text-center font-semibold">{session.dapp.name}</p>
      {dappUrl ? (
        <a
          href={dappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-sm wallet-link break-all"
        >
          {session.dapp.url}
        </a>
      ) : null}
      {description ? (
        <p className="mt-3 text-sm wallet-muted">{description}</p>
      ) : null}
      <div className="mt-4 text-sm space-y-1">
        <p className="font-semibold">Balance change</p>
        {Object.entries(response.balanceChanges).map(([category, amount]) => (
          <p key={category}>{formatBalance(category, amount)}</p>
        ))}
      </div>
    </WalletPopupSheet>
  );
}
