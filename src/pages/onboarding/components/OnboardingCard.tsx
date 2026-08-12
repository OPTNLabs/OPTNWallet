import type { PropsWithChildren } from 'react';
import { ONBOARDING_WELCOME_IMAGE } from '../constants';

type OnboardingCardProps = PropsWithChildren<{
  title: string;
  maxWidthClassName?: string;
}>;

const OnboardingCard = ({
  title,
  children,
  maxWidthClassName = 'max-w-md',
}: OnboardingCardProps) => {
  return (
    <div className="min-h-screen wallet-surface flex flex-col items-center justify-center p-4 w-full">
      <div className={`wallet-card p-6 w-full ${maxWidthClassName}`}>
        <div className="flex justify-center mt-4">
          <img
            src={ONBOARDING_WELCOME_IMAGE}
            alt="Welcome"
            className="max-w-full h-auto"
          />
        </div>

        <h1 className="wallet-text-strong font-bold text-xl mb-4 text-center">
          {title}
        </h1>

        {children}
      </div>
    </div>
  );
};

export default OnboardingCard;
