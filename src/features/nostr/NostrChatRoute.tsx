import type { FC, PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { homeRoute } from '../../navigation/routes';
import type { RootState } from '../../state/store';

/**
 * Require an opened wallet before any chat-side effects can start.
 * Mounting the client derives the Nostr identity, publishes the kind-10050
 * relay list, and starts a gift-wrap subscription.
 */
export const NostrChatRoute: FC<PropsWithChildren> = ({ children }) => {
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const navigate = useNavigate();
  const opened = walletId > 0;

  useEffect(() => {
    if (!opened) {
      navigate(homeRoute(walletId), { replace: true });
    }
  }, [opened, navigate, walletId]);

  return opened ? <>{children}</> : null;
};
