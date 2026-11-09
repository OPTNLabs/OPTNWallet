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
import NetworkContextBanner from '../ui/NetworkContextBanner';
import { shortenHash } from '../../utils/shortenHash';
import useSharedTokenMetadata from '../../hooks/useSharedTokenMetadata';
import { useI18n } from '../../i18n/useI18n';

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
  const { t } = useI18n();
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
      dismissLabel={t('cashconnect.reject')}
      onDismiss={() => dispatch(rejectCashConnectProposalAction())}
      footer={
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="wallet-btn-primary px-3 py-2"
              onClick={() => dispatch(approveCashConnectProposalAction())}
            >
              {t('cashconnect.approve')}
            </button>
            <button
              type="button"
              className="wallet-btn-danger px-3 py-2"
              onClick={() => dispatch(rejectCashConnectProposalAction())}
            >
              {t('cashconnect.reject')}
            </button>
          </div>
        </div>
      }
    >
      <h2 className="text-xl font-bold text-center mb-3">
        {t('cashconnect.approve')} CashConnect
      </h2>
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
      <NetworkContextBanner network={proposal.chain} className="mt-4" />
      <div className="mt-4 text-sm space-y-2">
        <p>
          <span className="font-semibold">{t('cashconnect.what')}:</span>{' '}
          {humanizeTemplateName(proposal.template.name)}
        </p>
        <p className="break-words">
          <span className="font-semibold">{t('cashconnect.actions')}:</span>{' '}
          {actionNames.join(', ') || t('cashconnect.none')}
        </p>
        {proposal.allowedTokens.length > 0 ? (
          <p>
            <span className="font-semibold">{t('cashconnect.tokens')}:</span>{' '}
            {proposal.allowedTokens
              .map((token) => tokenLabel(token, tokenMetadata[token]))
              .join(', ')}
          </p>
        ) : null}
        {hasTransactionActions ? (
          <p className="text-sm wallet-muted">
            {t('cashconnect.connectingDoesNotSend')}
          </p>
        ) : null}
      </div>
    </WalletPopupSheet>
  );
}
