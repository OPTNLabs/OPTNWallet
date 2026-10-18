import { useState } from 'react';
import RemoteImg from '../RemoteImg';

interface Props {
  name: string | null | undefined;
  iconUrl: string | null | undefined;
  className?: string;
}

function getFallbackInitials(name: string): string {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return initials || 'WZ';
}

export default function WizardDappAvatar({
  name,
  iconUrl,
  className,
}: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const title = name?.trim() || 'WizardConnect';
  const fallback = getFallbackInitials(title);

  if (iconUrl && !imageFailed) {
    return (
      <div className={className}>
        <RemoteImg
          src={iconUrl}
          alt={`${title} icon`}
          className="block h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
          fallback={
            <span className="text-lg font-bold wallet-text-strong">
              {fallback}
            </span>
          }
        />
      </div>
    );
  }

  return (
    <div className={className}>
      <span className="text-lg font-bold wallet-text-strong">{fallback}</span>
    </div>
  );
}
