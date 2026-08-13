import { useDispatch, useSelector } from 'react-redux';
import type { AppDispatch, RootState } from '../../state/store';
import {
  approveCashConnectProposalAction,
  rejectCashConnectProposalAction,
} from '../../state/slices/cashconnectSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';
import {
  cashConnectProposalHasTransactions,
  listCashConnectActionNames,
} from '../../services/cashconnect/cashconnectProposal';

export default function CashConnectSessionProposalModal() {
  const dispatch = useDispatch<AppDispatch>();
  const proposal = useSelector(
    (state: RootState) => state.cashconnect.pendingProposal
  );
  if (!proposal) return null;

  const dappUrl = normalizeExternalUrl(proposal.dapp.url);
  const actionNames = listCashConnectActionNames(proposal);
  const hasTransactionActions = cashConnectProposalHasTransactions(proposal);

  return (
    <div className="wallet-popup-backdrop">
      <div className="wallet-popup-panel max-w-md w-full">
        <h2 className="text-xl font-bold text-center mb-4">
          Approve CashConnect
        </h2>
        {proposal.dapp.icon ? (
          <div className="flex justify-center mb-4">
            <img
              src={proposal.dapp.icon}
              alt=""
              className="h-16 w-16 rounded-full object-cover"
            />
          </div>
        ) : null}
        <div className="text-center space-y-1">
          <p className="font-semibold">{proposal.dapp.name}</p>
          {dappUrl ? (
            <a
              href={dappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-sm wallet-link break-all"
            >
              {proposal.dapp.url}
            </a>
          ) : (
            <p className="text-sm wallet-muted break-all">{proposal.dapp.url}</p>
          )}
          {proposal.dapp.description ? (
            <p className="text-sm wallet-muted">{proposal.dapp.description}</p>
          ) : null}
        </div>
        <div className="mt-4 text-sm space-y-2">
          <p>
            <span className="font-semibold">Template:</span>{' '}
            {proposal.template.name}
          </p>
          <p>
            <span className="font-semibold">Network:</span> {proposal.chain}
          </p>
          <p>
            <span className="font-semibold">Actions:</span>{' '}
            {actionNames.join(', ') || 'none'}
          </p>
          {proposal.allowedTokens.length > 0 ? (
            <p className="break-all">
              <span className="font-semibold">Tokens:</span>{' '}
              {proposal.allowedTokens.join(', ')}
            </p>
          ) : null}
          {hasTransactionActions ? (
            <p className="text-amber-600 dark:text-amber-400">
              Transaction actions are unavailable until CashConnect supports
              post-consent signing.
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-3 mt-6">
          <button
            type="button"
            className="wallet-btn-primary px-3 py-2"
            onClick={() => dispatch(approveCashConnectProposalAction())}
          >
            Approve
          </button>
          <button
            type="button"
            className="wallet-btn-danger px-3 py-2"
            onClick={() => dispatch(rejectCashConnectProposalAction())}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
