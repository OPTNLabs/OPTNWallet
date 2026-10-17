import {
  useEffect,
  useState,
  type CSSProperties,
  type ImgHTMLAttributes,
  type ReactNode,
} from 'react';
import { useRemoteImageSrc } from '../hooks/useRemoteImageSrc';

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src: string | null | undefined;
  /** Shown while loading and when there is no image. Without one, an empty
   *  box of the image's size keeps the layout and its alt text. */
  fallback?: ReactNode;
};

/** An `<img>` whose remote source never loads from the webview directly. */
export function RemoteImg({ src, fallback, onError, ...rest }: Props) {
  const resolved = useRemoteImageSrc(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [resolved]);
  if (!resolved || failed) {
    if (fallback !== undefined) return <>{fallback}</>;
    const { alt, className, style } = rest;
    return (
      <span
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
        className={className}
        style={{ display: 'inline-block', ...style }}
      />
    );
  }
  return (
    <img
      {...rest}
      src={resolved}
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
    />
  );
}

/** A box whose CSS background is a remote image, loaded the same way. Empty
 *  until the image is there. */
export function RemoteBackground({
  src,
  className,
  style,
}: {
  src: string | null | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  const resolved = useRemoteImageSrc(src);
  return (
    <div
      className={className}
      style={
        resolved
          ? { ...style, backgroundImage: `url(${JSON.stringify(resolved)})` }
          : style
      }
    />
  );
}

export default RemoteImg;
