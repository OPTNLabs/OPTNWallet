import React from 'react';
import { FaBitcoin } from 'react-icons/fa';
import RemoteImg from '../RemoteImg';

type TokenAvatarProps = {
  iconUri?: string | null;
  name: string;
  fallbackClassName?: string;
  sizeClassName?: string;
};

const TokenAvatar: React.FC<TokenAvatarProps> = ({
  iconUri,
  name,
  fallbackClassName = 'text-[var(--wallet-accent-strong)]',
  sizeClassName = 'h-10 w-10',
}) => {
  const fallback = (
    <FaBitcoin className={`${fallbackClassName} text-[1.35rem]`} />
  );
  return (
    <div
      className={`${sizeClassName} shrink-0 overflow-hidden rounded-2xl border border-[var(--wallet-border)] bg-[color-mix(in_oklab,var(--wallet-surface-strong)_72%,transparent)] flex items-center justify-center`}
    >
      {iconUri ? (
        <RemoteImg
          src={iconUri}
          alt={name}
          className="h-full w-full object-cover"
          fallback={fallback}
        />
      ) : (
        fallback
      )}
    </div>
  );
};

export default TokenAvatar;
