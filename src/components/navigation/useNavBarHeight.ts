import { useEffect, useRef } from 'react';

type UseNavBarHeightParams = {
  setNavBarHeight: (height: number) => void;
};

export function useNavBarHeight({ setNavBarHeight }: UseNavBarHeightParams) {
  const navBarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (navBarRef.current) {
      setNavBarHeight(navBarRef.current.offsetHeight);
    }
  }, [setNavBarHeight]);

  return { navBarRef };
}
