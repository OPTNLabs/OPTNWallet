import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { multisigRoute } from '../../navigation/routes';
import MultisigBackButton from './MultisigBackButton';

type MultisigPageProps = {
  children: ReactNode;
};

/** Content frame for the dedicated multisig workspace. */
export default function MultisigPage({ children }: MultisigPageProps) {
  const navigate = useNavigate();
  const { wallet_id: walletId } = useParams();
  const location = useLocation();
  const isHome = location.pathname === multisigRoute(walletId);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = 0;
    element.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  return (
    <div
      ref={scrollRef}
      className="h-full min-h-0 overflow-y-auto overscroll-contain px-4 py-4 touch-pan-y"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 pb-[calc(var(--navbar-height)+var(--safe-bottom)+1rem)]">
        {!isHome && (
          <MultisigBackButton onClick={() => navigate(multisigRoute(walletId))}>
            Back
          </MultisigBackButton>
        )}
        {children}
      </div>
    </div>
  );
}
