import React from 'react';

type EmptyStateProps = {
  message: string;
  className?: string;
};

const EmptyState: React.FC<EmptyStateProps> = ({ message, className = '' }) => {
  return (
    <div className={`wallet-card p-4 text-center wallet-muted ${className}`.trim()}>
      {message}
    </div>
  );
};

export default EmptyState;
