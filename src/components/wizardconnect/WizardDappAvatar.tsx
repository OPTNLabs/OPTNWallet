import { useState } from 'react';

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
        <img
          src={iconUrl}
          alt={`${title} icon`}
          className="block h-full w-full object-cover"
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
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
