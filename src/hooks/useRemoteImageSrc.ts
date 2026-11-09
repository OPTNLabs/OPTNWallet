import { useEffect, useState } from 'react';
import { localImageSrc, remoteImageSrc } from '../utils/remoteImage';

/** `src` as the page may load it; see `remoteImageSrc`. Undefined while it is
 *  being fetched, null when there is nothing to show. A source that needs no
 *  fetch is there on the first render. */
export function useRemoteImageSrc(
  src: string | null | undefined
): string | null | undefined {
  const local = localImageSrc(src);
  const [state, setState] = useState<{
    for: string | null | undefined;
    value: string | null | undefined;
  }>({
    for: src,
    value: undefined,
  });
  useEffect(() => {
    if (local !== undefined) return;
    let current = true;
    void remoteImageSrc(src).then((value) => {
      if (current) setState({ for: src, value });
    });
    return () => {
      current = false;
    };
  }, [src, local]);
  if (local !== undefined) return local;
  return state.for === src ? state.value : undefined;
}
