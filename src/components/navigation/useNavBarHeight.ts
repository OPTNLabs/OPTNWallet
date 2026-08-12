import { useEffect, useRef } from 'react';

type UseNavBarHeightParams = {
  setNavBarHeight: (height: number) => void;
};

export function useNavBarHeight({ setNavBarHeight }: UseNavBarHeightParams) {
  const navBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const navBar = navBarRef.current;
    if (!navBar) {
      return;
    }

    const syncHeight = () => {
      setNavBarHeight(navBar.offsetHeight);
    };

    syncHeight();

    const resizeObserver = new ResizeObserver(syncHeight);
    resizeObserver.observe(navBar);
    window.addEventListener('resize', syncHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', syncHeight);
    };
  }, [setNavBarHeight]);

  return { navBarRef };
}
