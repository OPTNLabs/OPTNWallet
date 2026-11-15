/**
 * "View on explorer", or the reason there is no link.
 *
 * Rendering the refusal matters as much as rendering the link. A holder on
 * "own infrastructure only" who simply sees nothing where the button was will
 * read it as a broken screen; told why, they can either accept it or point the
 * wallet at an explorer of their own.
 */

import { Link } from 'react-router-dom';
import { useI18n } from '../i18n/useI18n';
import type { Network } from '../state/slices/networkSlice';
import { useExplorerLink } from '../utils/servers/useExplorerLink';
import { handleExternalLinkClick } from '../utils/openExternalLink';
import { isDesktopPlatform } from '../utils/platform';

type Props = {
  network: Network;
  txid: string;
  className?: string;
  label?: string;
};

export default function ExplorerLink({
  network,
  txid,
  className,
  label = 'View on explorer ↗',
}: Props) {
  const { t } = useI18n();
  const explorer = useExplorerLink();
  const href = explorer.tx(network, txid);

  if (!href) {
    return explorer.reason ? (
      <p className="mt-3 text-xs opacity-70">
        {explorer.reason}{' '}
        <Link
          to={
            isDesktopPlatform()
              ? '/settings?panel=server'
              : '/settings?panel=explorer'
          }
          className="underline wallet-text-strong"
        >
          {isDesktopPlatform()
            ? t('history.openNetworkSettings')
            : t('history.openExplorerSettings')}
        </Link>
      </p>
    ) : null;
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      onClick={(event) =>
        handleExternalLinkClick(event, t('history.openExplorerFailed'))
      }
    >
      {label}
    </a>
  );
}
