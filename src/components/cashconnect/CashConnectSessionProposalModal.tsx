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
import WalletPopupSheet from '../ui/WalletPopupSheet';
import { shortenHash } from '../../utils/shortenHash';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';

const KNOWN_TOKEN_LABELS: Record<string, string> = {
  d9ab24ed15a7846cc3d9e004aa5cb976860f13dac1ead05784ee4f4622af96ea: 'FURU',
};

function tokenLabel(
  category: string,
  metadata?: { name?: string; symbol?: string }
): string {
  const known = KNOWN_TOKEN_LABELS[category.toLowerCase()];
  if (known) return known;
  const symbol = metadata?.symbol?.trim();
  if (symbol) return symbol;
  const name = metadata?.name?.trim();
  if (name && name.toLowerCase() !== category.toLowerCase()) return name;
  return shortenHash(category, 6, 4);
}

function humanizeTemplateName(name: string): string {
  return name.replace(/^_+/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export default function CashConnectSessionProposalModal() {
  const dispatch = useDispatch<AppDispatch>();
  const proposal = useSelector(
    (state: RootState) => state.cashconnect.pendingProposal
  );
  const tokenMetadata = useSharedTokenMetadata(proposal?.allowedTokens ?? []);
  if (!proposal) return null;

  const dappUrl = normalizeExternalUrl(proposal.dapp.url);
  const actionNames = listCashConnectActionNames(proposal);
  const hasTransactionActions = cashConnectProposalHasTransactions(proposal);

  return (
    <WalletPopupSheet
      onDismiss={() => dispatch(rejectCashConnectProposalAction())}
      footer={
        <div className="grid grid-cols-2 gap-3">
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
      }
    >
      <h2 className="text-xl font-bold text-center mb-3">Approve CashConnect</h2>
      {proposal.dapp.icon ? (
        <div className="flex justify-center mb-3">
          <img
            src={proposal.dapp.icon}
            alt=""
            className="h-12 w-12 rounded-full object-cover"
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
          <span className="font-semibold">What:</span>{' '}
          {humanizeTemplateName(proposal.template.name)}
        </p>
        <p>
          <span className="font-semibold">Network:</span> {proposal.chain}
        </p>
        <p className="break-words">
          <span className="font-semibold">Actions:</span>{' '}
          {actionNames.join(', ') || 'none'}
        </p>
        {proposal.allowedTokens.length > 0 ? (
          <p>
            <span className="font-semibold">Tokens:</span>{' '}
            {proposal.allowedTokens
              .map((token) => tokenLabel(token, tokenMetadata[token]))
              .join(', ')}
          </p>
        ) : null}
        {hasTransactionActions ? (
          <p className="text-sm wallet-muted">
            Connecting does not send coins. Each spend asks again.
          </p>
        ) : null}
      </div>
    </WalletPopupSheet>
  );
}
