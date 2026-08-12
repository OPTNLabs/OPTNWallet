import React from 'react';

type SectionCardProps = {
  title?: string;
  className?: string;
  children: React.ReactNode;
};

const SectionCard: React.FC<SectionCardProps> = ({ title, className = '', children }) => {
  return (
    <section className={`wallet-card p-4 ${className}`.trim()}>
      {title ? (
        <h2 className="text-base font-semibold wallet-text-strong mb-3">{title}</h2>
      ) : null}
      {children}
    </section>
  );
};

export default SectionCard;
