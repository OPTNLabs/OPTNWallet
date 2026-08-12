import type { FC } from 'react';

import { CashFusionSettings } from './CashFusionSettings';
import { TorSettings } from './TorSettings';

/**
 * Desktop-only privacy transports. The core server controls remain usable on
 * mobile, while these controls stay behind the desktop raw TCP/Tor boundary.
 */
export const ServerPrivacySettings: FC = () => (
  <>
    <TorSettings />

    <div className="flex flex-col gap-2 border-t border-[var(--wallet-border)] pt-4">
      <p className="text-xs font-semibold wallet-muted uppercase tracking-wide">
        CashFusion &amp; Tor
      </p>
      <CashFusionSettings variant="servers" />
    </div>
  </>
);
