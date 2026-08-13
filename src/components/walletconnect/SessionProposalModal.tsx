// src/components/walletconnect/SessionProposalModal.tsx
import { useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { AppDispatch, RootState } from '../../state/store';
import {
  approveSessionProposal,
  rejectSessionProposal,
} from '../../state/slices/walletconnectSlice';
import { enqueueNotification } from '../../state/slices/notificationsSlice';
import { normalizeExternalUrl } from '../../utils/externalUrl';
import { useI18n } from '../../i18n/useI18n';
import WalletPopupSheet from '../ui/WalletPopupSheet';

function SessionProposalModal() {
  const dispatch = useDispatch<AppDispatch>();
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const proposal = useSelector(
    (state: RootState) => state.walletconnect.pendingProposal
  );
  if (!proposal) return null; // No proposal → no modal

  const dappMetadata = proposal.params.proposer.metadata;
  const dappUrl = normalizeExternalUrl(dappMetadata.url);

  const handleApprove = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatch(approveSessionProposal()).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:approved:${proposal.id}`,
          kind: 'walletconnect',
          title: t('wc.approvedTitle'),
          body: t('wc.approvedBody', { name: dappMetadata.name }),
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('Error approving session:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:approve-error:${proposal.id}`,
          kind: 'walletconnect',
          title: t('wc.approvalFailedTitle'),
          body: t('wc.approvalFailedBody', { name: dappMetadata.name }),
          createdAt: Date.now(),
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await dispatch(rejectSessionProposal()).unwrap();
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:rejected:${proposal.id}`,
          kind: 'walletconnect',
          title: t('wc.rejectedTitle'),
          body: t('wc.rejectedBody', { name: dappMetadata.name }),
          createdAt: Date.now(),
        })
      );
    } catch (err) {
      console.error('Error rejecting session:', err);
      dispatch(
        enqueueNotification({
          id: `walletconnect:proposal:reject-error:${proposal.id}`,
          kind: 'walletconnect',
          title: t('wc.rejectionFailedTitle'),
          body: t('wc.rejectionFailedBody', { name: dappMetadata.name }),
          createdAt: Date.now(),
        })
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WalletPopupSheet
      footer={
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={handleApprove}
            className="wallet-btn-primary px-3 py-2 text-sm sm:text-base"
            disabled={submitting}
          >
            {submitting ? t('wc.working') : t('wc.approve')}
          </button>
          <button
            onClick={handleReject}
            className="wallet-btn-danger px-3 py-2 text-sm sm:text-base whitespace-nowrap"
            disabled={submitting}
          >
            {t('wc.reject')}
          </button>
        </div>
      }
    >
      <h2 className="text-xl sm:text-2xl font-bold text-center mb-3">
        Approve Session
      </h2>
      {dappMetadata.icons[0] ? (
        <div className="flex justify-center mb-3">
          <img
            src={dappMetadata.icons[0]}
            alt={t('wc.unknownDapp')}
            className="h-12 w-12 rounded-full object-cover"
          />
        </div>
      ) : null}
      <div className="text-center">
        <p className="break-words font-semibold text-base sm:text-lg">
          {dappMetadata.name}
        </p>
        {dappUrl ? (
          <a
            href={dappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 block text-xs sm:text-sm wallet-link underline break-all leading-relaxed"
          >
            {dappMetadata.url}
          </a>
        ) : (
          <span className="mt-1 block text-xs sm:text-sm wallet-muted break-all leading-relaxed">
            {dappMetadata.url}
          </span>
        )}
        <p className="wallet-muted mt-2 text-xs sm:text-sm leading-relaxed break-words">
          {dappMetadata.description}
        </p>
      </div>
    </WalletPopupSheet>
  );
}

export default SessionProposalModal;
