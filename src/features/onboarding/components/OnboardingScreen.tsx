import type { PropsWithChildren } from 'react';

const OnboardingScreen = ({ children }: PropsWithChildren) => {
  return (
    <section className="flex flex-col min-h-screen items-center wallet-surface">
      {children}
    </section>
  );
};

export default OnboardingScreen;
