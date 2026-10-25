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

  const { session, request, response } = pending;
  const dappUrl = normalizeExternalUrl(session.dapp.url);
  const title = formatMeta(response.meta?.title) || session.template.name;
  const description = formatMeta(response.meta?.description);
  const balanceChanges = Object.entries(response.balanceChanges);
  const transactionCount = response.transactions.length;

  return (
    <WalletPopupSheet
      dismissLabel="Reject"
      onDismiss={() => dispatch(rejectCashConnectActionAction())}
      footer={
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            className="wallet-btn-primary min-h-[44px] px-3 py-2"
            onClick={() => dispatch(approveCashConnectActionAction())}
          >
            Approve request
          </button>
          <button
            type="button"
            className="wallet-btn-danger min-h-[44px] px-3 py-2"
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
      <div className="wallet-card mt-4 p-3 text-sm">
        <p className="font-semibold">What this request does</p>
        <p className="mt-1 break-all">Action: {request.action}</p>
        <p className="mt-1">
          Approving returns {transactionCount} prepared transaction
          {transactionCount === 1 ? '' : 's'} to {session.dapp.name}. The app
          may submit them to the network.
        </p>
        {transactionCount > 1 ? (
          <p className="mt-2 wallet-warning-panel rounded-lg p-2">
            This action includes multiple transactions. Review the estimated
            balance changes below.
          </p>
        ) : null}
      </div>
      <div className="mt-4 text-sm space-y-1">
        <p className="font-semibold">Balance change reported by this request</p>
        <p className="wallet-muted">
          CashConnect did not provide the source outputs needed for this wallet
          to verify ownership and change independently.
        </p>
        {balanceChanges.length === 0 ? (
          <p className="wallet-muted">
            No balance change was supplied for this request.
          </p>
        ) : null}
        {balanceChanges.map(([category, amount]) => (
          <p key={category}>{formatBalance(category, amount)}</p>
        ))}
      </div>
    </WalletPopupSheet>
  );
}
