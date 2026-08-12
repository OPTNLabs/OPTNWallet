import type { FC, PropsWithChildren } from 'react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';

import { homeRoute } from '../../navigation/routes';
import type { RootState } from '../../state/store';
import { selectNostrChatEnabled } from '../../state/slices/experimentalSlice';

/**
 * Honor an explicit chat opt-out before any chat-side effects can start.
 * Mounting the client derives the Nostr identity, publishes the kind-10050
 * relay list, and starts a gift-wrap subscription.
 */
export const NostrChatRoute: FC<PropsWithChildren> = ({ children }) => {
  const enabled = useSelector(selectNostrChatEnabled);
  const walletId = useSelector(
    (state: RootState) => state.wallet_id.currentWalletId
  );
  const navigate = useNavigate();

  useEffect(() => {
    if (!enabled) {
      navigate(homeRoute(walletId), { replace: true });
    }
  }, [enabled, navigate, walletId]);

  return enabled ? <>{children}</> : null;
};
