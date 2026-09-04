import { useParams } from 'react-router-dom';
import { multisigRoute } from '../../navigation/routes';
import { WatchOnlySend } from '../watch-only-send/WatchOnlySend';

/**
 * Mobile/internal multisig spend boundary.
 *
 * The transaction coordinator is shared with the legacy desktop air-gap
 * implementation, but this route opts into the multisig-owned review surface
 * and remains a mobile-only route. Desktop continues to use its existing
 * SeedSigner-compatible watch-only flow.
 *
 * The PSBT builder, parent-transaction checks, UR exchange, signature
 * verification, and broadcast boundary are shared with the desktop
 * watch-only engine. The route remains mobile-owned and supplies the
 * platform-neutral Capacitor QR scanner through the `mobile` prop.
 */
export default function MultisigSendWorkspace() {
  const { wallet_id: routeWalletId } = useParams();
  const walletId = Number(routeWalletId);

  return (
    <WatchOnlySend
      mobile
      walletIdOverride={walletId}
      returnTo={walletId ? multisigRoute(walletId) : undefined}
      backButtonVariant="danger"
      presentation="multisig"
    />
  );
}
