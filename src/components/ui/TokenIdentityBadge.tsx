import React from 'react';
import TokenAvatar from './TokenAvatar';
import {
  getTokenPresentationStatusClassName,
  type TokenPresentation,
} from '../../utils/tokenPresentation';

type TokenIdentityBadgeProps = {
  presentation: TokenPresentation;
  className?: string;
  avatarClassName?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
  showStatus?: boolean;
  detail?: React.ReactNode;
};

export default function TokenIdentityBadge({
  presentation,
  className = '',
  avatarClassName,
  primaryClassName = '',
  secondaryClassName = '',
  showStatus = true,
  detail,
}: TokenIdentityBadgeProps) {
  const shouldRenderStatus = showStatus && Boolean(presentation.statusLabel);
  const statusClassName = shouldRenderStatus && presentation.statusTone
    ? getTokenPresentationStatusClassName(presentation.statusTone)
    : '';

  return (
    <div className={`flex min-w-0 items-center gap-3 ${className}`}>
      <TokenAvatar
        iconUri={presentation.iconUri}
        name={presentation.primaryLabel}
        sizeClassName={avatarClassName}
      />
      <div className="min-w-0 flex-1">
        <div
          className={`truncate text-base font-semibold wallet-text-strong ${primaryClassName}`}
        >
          {presentation.primaryLabel}
        </div>
        <div className={`mt-0.5 flex min-w-0 items-center gap-2 text-xs ${secondaryClassName}`}>
          {presentation.secondaryLabel ? (
            <span className="truncate wallet-muted">{presentation.secondaryLabel}</span>
          ) : null}
          {shouldRenderStatus ? (
            <span className={`truncate font-medium ${statusClassName}`}>
              {presentation.statusLabel}
            </span>
          ) : null}
        </div>
      </div>
      {detail ? <div className="shrink-0 text-right">{detail}</div> : null}
    </div>
  );
}
